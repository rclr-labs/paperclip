import { createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, serverInstances } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  resolveServerOwners,
  serverBootId,
  serverHostname,
  startServerInstanceRegistration,
} from "../services/server-instance-registry.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("server instance registry", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-server-instance-registry-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  it("keeps an expired row on shutdown so leftover leases still resolve to their host", async () => {
    const registration = await startServerInstanceRegistration(db, { renewMs: 60_000 });
    const [live] = await db.select().from(serverInstances).where(eq(serverInstances.bootId, serverBootId));
    expect(live).toMatchObject({ hostname: serverHostname, pid: process.pid });
    expect(live.expiresAt.getTime()).toBeGreaterThan(Date.now());

    await registration.stop();
    const [stopped] = await db.select().from(serverInstances).where(eq(serverInstances.bootId, serverBootId));
    expect(stopped).toBeDefined();
    expect(stopped.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it("classifies owners: self, another host, and unregistered", async () => {
    await db.insert(serverInstances).values([
      { bootId: "remote-live", hostname: "replica-a.invalid", pid: 1, expiresAt: new Date(Date.now() + 60_000) },
      { bootId: "remote-stopped", hostname: "replica-a.invalid", pid: 1, expiresAt: new Date(Date.now() - 1_000) },
    ]);
    const owners = await resolveServerOwners(db, [serverBootId, "remote-live", "remote-stopped", "never-registered", null]);
    expect(owners.get(serverBootId)).toEqual({ kind: "self" });
    expect(owners.get("remote-live")).toEqual({ kind: "foreign", hostname: "replica-a.invalid", sameHost: false, alive: true });
    expect(owners.get("remote-stopped")).toEqual({ kind: "foreign", hostname: "replica-a.invalid", sameHost: false, alive: false });
    expect(owners.get("never-registered")).toEqual({ kind: "unknown" });
  });
});
