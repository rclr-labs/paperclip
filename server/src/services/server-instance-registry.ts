import { randomUUID } from "node:crypto";
import os from "node:os";
import { eq, inArray, sql } from "drizzle-orm";
import { serverInstances, type Db } from "@paperclipai/db";

/**
 * One identity per server process. Every controller lease this process takes
 * (legacy run leases, native coordinator leases, the scheduler leader lease)
 * names this boot ID, so the registry row below answers "which host runs the
 * owner, and is it still alive?" for all of them.
 */
export const serverBootId = randomUUID();
export const serverHostname = os.hostname();

export const SERVER_INSTANCE_TTL_MS = 60_000;
export const SERVER_INSTANCE_RENEW_MS = 10_000;

function processStartedAt(): Date {
  return new Date(Date.now() - Math.round(process.uptime() * 1000));
}

/** Insert or refresh this process's registry row. Lease times come from the
 * database clock so replicas with skewed clocks agree on expiry. */
export async function renewServerInstance(db: Db, ttlMs = SERVER_INSTANCE_TTL_MS): Promise<void> {
  const expiresAt = sql`clock_timestamp() + (${ttlMs} * interval '1 millisecond')`;
  await db
    .insert(serverInstances)
    .values({
      bootId: serverBootId,
      hostname: serverHostname,
      pid: process.pid,
      processStartedAt: processStartedAt(),
      expiresAt,
    })
    .onConflictDoUpdate({
      target: serverInstances.bootId,
      set: { renewedAt: sql`clock_timestamp()`, expiresAt },
    });
}

export async function deregisterServerInstance(db: Db): Promise<void> {
  await db.delete(serverInstances).where(eq(serverInstances.bootId, serverBootId));
}

/** Register now, then renew until stopped. A failed renewal is retried on the
 * next tick; it only shortens how long other replicas believe we are alive. */
export async function startServerInstanceRegistration(
  db: Db,
  opts: { ttlMs?: number; renewMs?: number; onError?: (error: unknown) => void } = {},
): Promise<{ stop(): Promise<void> }> {
  const ttlMs = opts.ttlMs ?? SERVER_INSTANCE_TTL_MS;
  await renewServerInstance(db, ttlMs);
  let pending: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (pending) return;
    pending = renewServerInstance(db, ttlMs)
      .catch((error) => opts.onError?.(error))
      .finally(() => { pending = null; });
  }, opts.renewMs ?? SERVER_INSTANCE_RENEW_MS);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      await pending;
      await deregisterServerInstance(db).catch((error) => opts.onError?.(error));
    },
  };
}

/**
 * What this process may conclude about the owner of a controller lease.
 *
 * - `self`: this process owns it.
 * - `unknown`: no registry row (an owner from before the registry existed, a
 *   revocation token, or no owner at all). Callers keep their existing rules.
 * - `foreign`: another registered process. `sameHost` says whether its numeric
 *   PIDs can be probed from here; `alive` says whether it still holds its
 *   registry lease (and, on this host, whether its PID still runs).
 */
export type ServerOwner =
  | { kind: "self" }
  | { kind: "unknown" }
  | { kind: "foreign"; hostname: string; sameHost: boolean; alive: boolean };

function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

export async function resolveServerOwners(
  db: Db,
  bootIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, ServerOwner>> {
  const owners = new Map<string, ServerOwner>();
  const lookup = new Set<string>();
  for (const bootId of bootIds) {
    if (!bootId) continue;
    if (bootId === serverBootId) owners.set(bootId, { kind: "self" });
    else lookup.add(bootId);
  }
  if (lookup.size === 0) return owners;
  const rows = await db
    .select({
      bootId: serverInstances.bootId,
      hostname: serverInstances.hostname,
      pid: serverInstances.pid,
      live: sql<boolean>`${serverInstances.expiresAt} > clock_timestamp()`,
    })
    .from(serverInstances)
    .where(inArray(serverInstances.bootId, [...lookup]));
  for (const row of rows) {
    const sameHost = row.hostname === serverHostname;
    owners.set(row.bootId, {
      kind: "foreign",
      hostname: row.hostname,
      sameHost,
      alive: Boolean(row.live) && (!sameHost || pidIsAlive(row.pid)),
    });
  }
  for (const bootId of lookup) {
    if (!owners.has(bootId)) owners.set(bootId, { kind: "unknown" });
  }
  return owners;
}

export async function resolveServerOwner(db: Db, bootId: string | null | undefined): Promise<ServerOwner> {
  if (!bootId) return { kind: "unknown" };
  return (await resolveServerOwners(db, [bootId])).get(bootId) ?? { kind: "unknown" };
}
