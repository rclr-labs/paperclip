import type { EvalScenario } from "./scenario.js";

/**
 * What the agent under test is made of: the unit that actually changes
 * behavior (see `doc/plans/2026-03-13-agent-evals-framework.md`, EvalBundle).
 */
export interface EvalBundle {
  readonly id: string;
  readonly adapter: string;
  readonly model?: string;
  /** Instruction files keyed by bundle-relative path; `entryFile` is the one the adapter loads. */
  readonly instructions: { readonly entryFile: string; readonly files: Readonly<Record<string, string>> } | null;
  /** Skills keyed by slug; each value maps skill-relative path → content (SKILL.md at minimum). */
  readonly skills: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Content hash of the source revision, for the report. */
  readonly revision?: string;
}

export type ArmId = "with" | "ablated";

export interface EvalArm {
  readonly id: ArmId;
  readonly bundle: EvalBundle;
  /** Human-readable description of what was removed, for the report. */
  readonly ablation: string | null;
}

export class ArmConstructionError extends Error {
  readonly code = "agent_evals_arm_invalid" as const;
}

/**
 * Build the two arms for a scenario. `revision:previous` needs the caller to
 * supply the previous bundle (the loader fetches it from
 * `agent_instruction_revisions`); the other ablations are derived here.
 */
export function buildArms(
  scenario: Pick<EvalScenario, "id" | "ablate">,
  bundle: EvalBundle,
  previousRevision?: EvalBundle,
): readonly [EvalArm, EvalArm] {
  const withArm: EvalArm = { id: "with", bundle, ablation: null };

  if (scenario.ablate === "instructions") {
    if (!bundle.instructions) throw new ArmConstructionError(`${scenario.id}: bundle ${bundle.id} has no instructions to ablate`);
    return [withArm, { id: "ablated", bundle: { ...bundle, id: `${bundle.id}~no-instructions`, instructions: null }, ablation: "instructions removed" }];
  }

  if (scenario.ablate === "revision:previous") {
    if (!previousRevision) throw new ArmConstructionError(`${scenario.id}: ablate=revision:previous needs the previous revision of ${bundle.id}`);
    return [withArm, { id: "ablated", bundle: previousRevision, ablation: `previous revision ${previousRevision.revision ?? "(unknown)"}` }];
  }

  const slug = scenario.ablate.slice("skill:".length);
  if (!(slug in bundle.skills)) throw new ArmConstructionError(`${scenario.id}: bundle ${bundle.id} has no skill "${slug}" to ablate`);
  const { [slug]: _removed, ...rest } = bundle.skills;
  return [withArm, { id: "ablated", bundle: { ...bundle, id: `${bundle.id}~no-${slug}`, skills: rest }, ablation: `skill ${slug} removed` }];
}
