import { createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, serverLeases } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { acquireOrRenewServerLease, releaseServerLease, startSchedulerLeadership } from "./scheduler-leadership.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("heartbeat scheduler leadership", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-scheduler-leadership-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(async () => { await db.delete(serverLeases); });
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  it("grants the lease to one holder and fences a takeover with a new generation", async () => {
    const a = await acquireOrRenewServerLease(db, { name: "scheduler", holderBootId: "boot-a", ttlMs: 60_000 });
    const b = await acquireOrRenewServerLease(db, { name: "scheduler", holderBootId: "boot-b", ttlMs: 60_000 });
    expect(a).toEqual({ generation: 1 });
    expect(b).toBeNull();
    // Renewal keeps the generation.
    expect(await acquireOrRenewServerLease(db, { name: "scheduler", holderBootId: "boot-a", ttlMs: 60_000 }))
      .toEqual({ generation: 1 });

    // Expiry lets another holder take over; the old holder cannot renew.
    await db.update(serverLeases).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(serverLeases.name, "scheduler"));
    expect(await acquireOrRenewServerLease(db, { name: "scheduler", holderBootId: "boot-b", ttlMs: 60_000 }))
      .toEqual({ generation: 2 });
    expect(await acquireOrRenewServerLease(db, { name: "scheduler", holderBootId: "boot-a", ttlMs: 60_000 })).toBeNull();
  });

  it("lets only the holder release, so a stale leader cannot drop a successor", async () => {
    await acquireOrRenewServerLease(db, { name: "scheduler", holderBootId: "boot-a", ttlMs: 60_000 });
    await releaseServerLease(db, { name: "scheduler", holderBootId: "boot-b" });
    expect(await acquireOrRenewServerLease(db, { name: "scheduler", holderBootId: "boot-b", ttlMs: 60_000 })).toBeNull();
    await releaseServerLease(db, { name: "scheduler", holderBootId: "boot-a" });
    expect(await acquireOrRenewServerLease(db, { name: "scheduler", holderBootId: "boot-b", ttlMs: 60_000 }))
      .toEqual({ generation: 2 });
  });

  it("hands leadership from blue to green on release without a restart", async () => {
    const events: string[] = [];
    const blue = await startSchedulerLeadership(db, {
      holderBootId: "blue", ttlMs: 5_000, renewMs: 50,
      onAcquired: (generation) => { events.push(`blue+${generation}`); },
      onLost: () => { events.push("blue-"); },
    });
    const green = await startSchedulerLeadership(db, {
      holderBootId: "green", ttlMs: 5_000, renewMs: 50,
      onAcquired: (generation) => { events.push(`green+${generation}`); },
      onLost: () => { events.push("green-"); },
    });
    try {
      expect(blue.isLeader()).toBe(true);
      expect(green.isLeader()).toBe(false);

      await blue.stop();
      const deadline = Date.now() + 3_000;
      while (!green.isLeader() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));

      expect(green.isLeader()).toBe(true);
      expect(green.generation()).toBe(2);
      expect(events).toEqual(["blue+1", "blue-", "green+2"]);
    } finally {
      await blue.stop();
      await green.stop();
    }
  });

  it("steps down locally when it cannot renew before the lease deadline", async () => {
    let lost = 0;
    const leader = await startSchedulerLeadership(db, {
      holderBootId: "solo", ttlMs: 1_000, renewMs: 50,
      onLost: () => { lost += 1; },
    });
    try {
      expect(leader.isLeader()).toBe(true);
      // Another holder takes the row over (for example after a pause long
      // enough for the lease to expire); the next renewal must step down.
      await db.update(serverLeases).set({ holderBootId: "other", generation: 9 }).where(eq(serverLeases.name, "heartbeat_scheduler"));
      const deadline = Date.now() + 2_000;
      while (leader.isLeader() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      expect(leader.isLeader()).toBe(false);
      expect(lost).toBe(1);
    } finally {
      await leader.stop();
    }
  });
});
