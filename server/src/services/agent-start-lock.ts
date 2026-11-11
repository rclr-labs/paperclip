import { sql } from "drizzle-orm";
import { withDedicatedDbConnection, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

const AGENT_START_LOCK_STALE_MS = 30_000;
const startLocksByAgent = new Map<string, { promise: Promise<void>; startedAtMs: number }>();

async function waitForAgentStartLock(agentId: string, lock: { promise: Promise<void>; startedAtMs: number }) {
  const elapsedMs = Date.now() - lock.startedAtMs;
  const remainingMs = AGENT_START_LOCK_STALE_MS - elapsedMs;
  if (remainingMs <= 0) {
    logger.warn({ agentId, staleMs: elapsedMs }, "agent start lock stale; continuing queued-run start");
    return;
  }

  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([
    lock.promise,
    new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        resolve();
      }, remainingMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);

  if (timedOut) {
    logger.warn({ agentId, staleMs: AGENT_START_LOCK_STALE_MS }, "agent start lock timed out; continuing queued-run start");
  }
}

function isLockTimeout(error: unknown): boolean {
  for (let cause = error, depth = 0; cause && depth < 4; cause = (cause as { cause?: unknown }).cause, depth++) {
    if ((cause as { code?: unknown }).code === "55P03") return true;
  }
  return false;
}

/**
 * Cross-process half of the start lock. A session advisory lock on a dedicated
 * connection serializes starts for one agent across every server process that
 * shares the database. The critical section keeps using the shared pool, so it
 * cannot deadlock on pool capacity, and no transaction stays idle while it
 * runs. Closing the connection releases the lock even if unlock fails.
 *
 * The stale bound matches the in-process lock: a holder that does not finish
 * within it no longer blocks starts.
 */
export async function withAgentStartAdvisoryLock<T>(
  db: Db,
  agentId: string,
  fn: () => Promise<T>,
  opts: { staleMs?: number } = {},
): Promise<T> {
  const staleMs = opts.staleMs ?? AGENT_START_LOCK_STALE_MS;
  const key = sql`hashtextextended(${`agent_start:${agentId}`}, 0)`;
  return withDedicatedDbConnection(db, async (connection) => {
    await connection.execute(sql`select set_config('lock_timeout', ${`${staleMs}ms`}, false)`);
    let locked = false;
    try {
      await connection.execute(sql`select pg_advisory_lock(${key})`);
      locked = true;
    } catch (error) {
      if (!isLockTimeout(error)) throw error;
      logger.warn({ agentId, staleMs }, "agent start lock held by another process is stale; continuing queued-run start");
    }
    try {
      return await fn();
    } finally {
      if (locked) await connection.execute(sql`select pg_advisory_unlock(${key})`).catch(() => undefined);
    }
  });
}

/**
 * Serialize queued-run starts for one agent. The in-process chain keeps local
 * FIFO order without a connection per waiter; with `db`, the advisory lock
 * also excludes other server processes on the same database.
 */
export async function withAgentStartLock<T>(
  agentId: string,
  fn: () => Promise<T>,
  opts: { db?: Db } = {},
) {
  const previous = startLocksByAgent.get(agentId);
  const waitForPrevious = previous ? waitForAgentStartLock(agentId, previous) : Promise.resolve();
  const db = opts.db;
  const run = waitForPrevious.then(() => (db ? withAgentStartAdvisoryLockIfSupported(db, agentId, fn) : fn()));
  const marker = run.then(
    () => undefined,
    () => undefined,
  );
  startLocksByAgent.set(agentId, { promise: marker, startedAtMs: Date.now() });
  try {
    return await run;
  } finally {
    if (startLocksByAgent.get(agentId)?.promise === marker) {
      startLocksByAgent.delete(agentId);
    }
  }
}

/** Test doubles and transaction handles have no dedicated-connection factory;
 * they run in one process, where the in-process chain already serializes. */
async function withAgentStartAdvisoryLockIfSupported<T>(db: Db, agentId: string, fn: () => Promise<T>): Promise<T> {
  let entered = false;
  try {
    return await withAgentStartAdvisoryLock(db, agentId, () => {
      entered = true;
      return fn();
    });
  } catch (error) {
    if (!entered && error instanceof Error && error.message === "dedicated_connection_requires_create_db") return fn();
    throw error;
  }
}
