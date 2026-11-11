import { randomUUID } from "node:crypto";
import { createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { withAgentStartAdvisoryLock } from "../services/agent-start-lock.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("agent start lock across server processes", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  // Two clients stand in for two server processes: they share no memory.
  let replicaA: ReturnType<typeof createDb>;
  let replicaB: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-agent-start-lock-");
    replicaA = createDb(database.connectionString);
    replicaB = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await replicaA?.$client.end();
    await replicaB?.$client.end();
    await database?.cleanup();
  });

  it("serializes starts for one agent across processes and leaves other agents free", async () => {
    const agentId = randomUUID();
    const order: string[] = [];
    let releaseA!: () => void;
    const aHolds = new Promise<void>((resolve) => { releaseA = resolve; });
    let aEntered!: () => void;
    const aStarted = new Promise<void>((resolve) => { aEntered = resolve; });

    const a = withAgentStartAdvisoryLock(replicaA, agentId, async () => {
      order.push("a:start");
      aEntered();
      await aHolds;
      order.push("a:end");
    });
    await aStarted;
    const b = withAgentStartAdvisoryLock(replicaB, agentId, async () => { order.push("b:start"); });
    const other = withAgentStartAdvisoryLock(replicaB, randomUUID(), async () => "other");

    await expect(other).resolves.toBe("other");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(order).toEqual(["a:start"]);

    releaseA();
    await Promise.all([a, b]);
    expect(order).toEqual(["a:start", "a:end", "b:start"]);
  });

  it("continues after the stale bound when the holder never releases", async () => {
    const agentId = randomUUID();
    let releaseA!: () => void;
    const aHolds = new Promise<void>((resolve) => { releaseA = resolve; });
    let aEntered!: () => void;
    const aStarted = new Promise<void>((resolve) => { aEntered = resolve; });
    const a = withAgentStartAdvisoryLock(replicaA, agentId, async () => { aEntered(); await aHolds; });
    await aStarted;
    try {
      await expect(
        withAgentStartAdvisoryLock(replicaB, agentId, async () => "started", { staleMs: 300 }),
      ).resolves.toBe("started");
    } finally {
      releaseA();
      await a;
    }
  });
});
