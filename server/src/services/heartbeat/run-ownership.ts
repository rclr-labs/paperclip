import type { Db } from "@paperclipai/db";
import { resolveServerOwners, type ServerOwner } from "../server-instance-registry.js";

/**
 * How the orphan reaper may treat a run, given who owns its controller lease.
 *
 * - `local`: this process, an unregistered owner, or a dead owner on this
 *   host. Persisted PIDs are probed with the existing rules.
 * - `foreign_live`: another live server process still holds the lease. The run
 *   is not orphaned; the reaper must not read or write its process state.
 * - `foreign_remote`: the owner runs on another host and has lost authority
 *   (its registry lease or its controller lease expired). Persisted PIDs name
 *   processes in that host's table, so they are never probed here; the expired
 *   lease is the evidence and recovery proceeds as if they were gone.
 */
export type RunOwnershipView = "local" | "foreign_live" | "foreign_remote";

export function classifyRunOwnership(
  owner: ServerOwner | undefined,
  leaseExpiresAt: Date | null | undefined,
  now: Date,
): RunOwnershipView {
  if (!owner || owner.kind !== "foreign") return "local";
  const leaseLive = !!leaseExpiresAt && leaseExpiresAt.getTime() > now.getTime();
  if (owner.alive && leaseLive) return "foreign_live";
  return owner.sameHost ? "local" : "foreign_remote";
}

export type RunOwnershipCandidate = {
  runId: string;
  ownerBootId: string | null | undefined;
  leaseExpiresAt: Date | null | undefined;
};

/** Resolve every candidate's owner with one registry read. */
export async function loadRunOwnership(
  db: Db,
  candidates: ReadonlyArray<RunOwnershipCandidate>,
  now: Date,
): Promise<Map<string, RunOwnershipView>> {
  const owners = await resolveServerOwners(db, candidates.map((c) => c.ownerBootId));
  const views = new Map<string, RunOwnershipView>();
  for (const candidate of candidates) {
    const owner = candidate.ownerBootId ? owners.get(candidate.ownerBootId) : undefined;
    views.set(candidate.runId, classifyRunOwnership(owner, candidate.leaseExpiresAt, now));
  }
  return views;
}
