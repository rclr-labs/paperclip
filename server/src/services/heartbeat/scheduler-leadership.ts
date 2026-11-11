import { and, eq, sql } from "drizzle-orm";
import { serverLeases, type Db } from "@paperclipai/db";
import { serverBootId } from "../server-instance-registry.js";

/**
 * Singleton heartbeat scheduler across server replicas.
 *
 * Every replica with the scheduler enabled builds the heartbeat service and
 * contends for one database row. Only the holder runs scheduler ticks and the
 * recovery that a new owner of all runs must perform (native restart recovery,
 * orphan reaping, queued-run resumption). A takeover increments `generation`,
 * so a stale leader cannot renew or release its successor's lease.
 *
 * Pattern: the Discord Gateway receiver lease in
 * `chat-channels/runtime/ownership.ts`, with lease times on the database clock
 * so replicas with skewed clocks agree on expiry.
 */
export const HEARTBEAT_SCHEDULER_LEASE = "heartbeat_scheduler";
export const SCHEDULER_LEASE_TTL_MS = 30_000;
export const SCHEDULER_LEASE_RENEW_MS = 5_000;

/** Acquire the lease if it is free or expired, or renew it if we hold it.
 * Returns the held generation, or null when another holder owns it. */
export async function acquireOrRenewServerLease(
  db: Db,
  input: { name: string; holderBootId: string; ttlMs: number },
): Promise<{ generation: number } | null> {
  const expiresAt = sql`clock_timestamp() + (${input.ttlMs} * interval '1 millisecond')`;
  const sameHolder = sql`${serverLeases.holderBootId} = excluded.holder_boot_id`;
  const [row] = await db
    .insert(serverLeases)
    .values({ name: input.name, holderBootId: input.holderBootId, generation: 1, expiresAt })
    .onConflictDoUpdate({
      target: serverLeases.name,
      set: {
        holderBootId: sql`excluded.holder_boot_id`,
        generation: sql`case when ${sameHolder} then ${serverLeases.generation} else ${serverLeases.generation} + 1 end`,
        acquiredAt: sql`case when ${sameHolder} then ${serverLeases.acquiredAt} else clock_timestamp() end`,
        renewedAt: sql`clock_timestamp()`,
        expiresAt: sql`excluded.expires_at`,
      },
      setWhere: sql`${sameHolder} or ${serverLeases.expiresAt} <= clock_timestamp()`,
    })
    .returning({ generation: serverLeases.generation });
  return row ? { generation: row.generation } : null;
}

/** Release only our own lease, so a successor can take over immediately.
 * The row is expired rather than deleted, so generations never repeat. */
export async function releaseServerLease(
  db: Db,
  input: { name: string; holderBootId: string },
): Promise<void> {
  await db
    .update(serverLeases)
    .set({ expiresAt: sql`clock_timestamp()` })
    .where(and(eq(serverLeases.name, input.name), eq(serverLeases.holderBootId, input.holderBootId)));
}

export type SchedulerLeadership = {
  /** True while this process holds an unexpired lease (by the local deadline). */
  isLeader(): boolean;
  generation(): number | null;
  /** Stop contending and release the lease if held. */
  stop(): Promise<void>;
};

export async function startSchedulerLeadership(
  db: Db,
  opts: {
    holderBootId?: string;
    name?: string;
    ttlMs?: number;
    renewMs?: number;
    onAcquired?: (generation: number) => void | Promise<void>;
    onLost?: () => void;
    onError?: (error: unknown) => void;
  } = {},
): Promise<SchedulerLeadership> {
  const name = opts.name ?? HEARTBEAT_SCHEDULER_LEASE;
  const holderBootId = opts.holderBootId ?? serverBootId;
  const ttlMs = opts.ttlMs ?? SCHEDULER_LEASE_TTL_MS;
  const renewMs = opts.renewMs ?? SCHEDULER_LEASE_RENEW_MS;
  let held: { generation: number; deadline: number } | null = null;
  let stopped = false;
  let pending: Promise<void> | null = null;

  const stepDown = () => {
    if (!held) return;
    held = null;
    opts.onLost?.();
  };
  const isLeader = () => {
    // Fail safe: without a renewal inside the TTL, another replica may already
    // hold the row, so stop acting as leader before the database says so.
    if (held && Date.now() >= held.deadline) stepDown();
    return held !== null;
  };

  const attempt = async () => {
    const startedAt = Date.now();
    let result: { generation: number } | null;
    try {
      result = await acquireOrRenewServerLease(db, { name, holderBootId, ttlMs });
    } catch (error) {
      opts.onError?.(error);
      isLeader();
      return;
    }
    if (stopped) return;
    if (!result || (held && held.generation !== result.generation)) {
      stepDown();
      if (!result) return;
    }
    const acquired = held === null;
    held = { generation: result.generation, deadline: startedAt + ttlMs };
    if (acquired) {
      try {
        await opts.onAcquired?.(result.generation);
      } catch (error) {
        opts.onError?.(error);
      }
    }
  };

  await attempt();
  const timer = setInterval(() => {
    if (pending || stopped) return;
    pending = attempt().finally(() => { pending = null; });
  }, renewMs);
  timer.unref();

  return {
    isLeader,
    generation: () => (isLeader() ? held!.generation : null),
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await pending;
      const wasLeader = held !== null;
      stepDown();
      if (wasLeader) {
        await releaseServerLease(db, { name, holderBootId }).catch((error) => opts.onError?.(error));
      }
    },
  };
}
