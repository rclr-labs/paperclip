import { randomUUID } from "node:crypto";
import { createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import type { LiveEvent } from "@paperclipai/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  LIVE_EVENTS_CHANNEL,
  publishLiveEvent,
  startLiveEventsReplicaFanout,
  subscribeAllCompanyLiveEvents,
  subscribeClientCompanyLiveEvents,
  subscribeCompanyLiveEvents,
} from "../services/live-events.js";

async function waitFor<T>(read: () => T | undefined, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("live events fan-out between server processes", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  // `local` is this process's pool; `peer` stands in for another replica.
  let local: ReturnType<typeof createDb>;
  let peer: ReturnType<typeof createDb>;
  let fanout: { stop(): Promise<void> };
  const peerReceived: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-live-events-fanout-");
    local = createDb(database.connectionString);
    peer = createDb(database.connectionString);
    await peer.$client.listen(LIVE_EVENTS_CHANNEL, (text) => { peerReceived.push(JSON.parse(text)); });
    fanout = await startLiveEventsReplicaFanout(local.$client);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await fanout?.stop();
    await local?.$client.end();
    await peer?.$client.end();
    await database?.cleanup();
  });

  it("publishes local company events to other replicas", async () => {
    const companyId = randomUUID();
    publishLiveEvent({ companyId, type: "activity.logged", payload: { action: "issue.updated" } });
    const message = await waitFor(() => peerReceived.find((m) => (m.event as LiveEvent).companyId === companyId));
    expect(message).toMatchObject({
      scope: "company",
      event: { companyId, type: "activity.logged", payload: { action: "issue.updated" } },
    });
    expect(typeof message.origin).toBe("string");
  });

  it("delivers another replica's events to clients only, exactly once", async () => {
    const companyId = randomUUID();
    const client: LiveEvent[] = [];
    const internal: LiveEvent[] = [];
    const unsubscribers = [
      subscribeClientCompanyLiveEvents(companyId, (event) => { client.push(event); }),
      // Server-side observers (budget, chat completion) must not run a side
      // effect once per replica.
      subscribeCompanyLiveEvents(companyId, (event) => { internal.push(event); }),
      subscribeAllCompanyLiveEvents((event) => { if (event.companyId === companyId) internal.push(event); }),
    ];
    try {
      const event = { id: 7, companyId, type: "activity.logged", createdAt: new Date().toISOString(), payload: { from: "peer" } };
      await peer.$client.notify(LIVE_EVENTS_CHANNEL, JSON.stringify({ v: 1, origin: "peer-boot", scope: "company", event }));
      await waitFor(() => client[0]);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(client).toHaveLength(1);
      expect(client[0]).toMatchObject({ companyId, type: "activity.logged", payload: { from: "peer" } });
      expect(internal).toHaveLength(0);
    } finally {
      for (const unsubscribe of unsubscribers) unsubscribe();
    }
  });

  it("ignores its own echo", async () => {
    const companyId = randomUUID();
    const client: LiveEvent[] = [];
    const unsubscribe = subscribeClientCompanyLiveEvents(companyId, (event) => { client.push(event); });
    try {
      publishLiveEvent({ companyId, type: "activity.logged", payload: { own: true } });
      // The NOTIFY came back to the peer, so it also came back to us.
      await waitFor(() => peerReceived.find((m) => (m.event as LiveEvent).companyId === companyId));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(client).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  it("bounds oversized events to the NOTIFY payload limit", async () => {
    const companyId = randomUUID();
    publishLiveEvent({ companyId, type: "activity.logged", payload: { blob: "x".repeat(20_000) } });
    const message = await waitFor(() => peerReceived.find((m) => (m.event as LiveEvent).companyId === companyId));
    expect(message.event).toMatchObject({ companyId, type: "activity.logged", payload: { truncated: true } });
  });
});
