import type { Ablation, EvalScenario } from "./scenario.js";

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
  const ablations = Array.isArray(scenario.ablate) ? scenario.ablate : [scenario.ablate];
  if (ablations.includes("revision:previous") && ablations.length > 1) {
    throw new ArmConstructionError(`${scenario.id}: revision:previous replaces the whole bundle and cannot be combined`);
  }

  let ablated = bundle;
  const descriptions: string[] = [];
  for (const ablation of ablations) {
    ablated = applyAblation(scenario.id, ablated, ablation, previousRevision);
    descriptions.push(
      ablation === "instructions" ? "instructions removed"
      : ablation === "revision:previous" ? `previous revision ${previousRevision?.revision ?? "(unknown)"}`
      : `skill ${ablation.slice("skill:".length)} removed`,
    );
  }
  return [withArm, { id: "ablated", bundle: ablated, ablation: descriptions.join(" + ") }];
}

function applyAblation(scenarioId: string, bundle: EvalBundle, ablation: Ablation, previousRevision?: EvalBundle): EvalBundle {
  if (ablation === "instructions") {
    if (!bundle.instructions) throw new ArmConstructionError(`${scenarioId}: bundle ${bundle.id} has no instructions to ablate`);
    return { ...bundle, id: `${bundle.id}~no-instructions`, instructions: null };
  }
  if (ablation === "revision:previous") {
    if (!previousRevision) throw new ArmConstructionError(`${scenarioId}: ablate=revision:previous needs the previous revision of ${bundle.id}`);
    return previousRevision;
  }
  const slug = ablation.slice("skill:".length);
  if (!(slug in bundle.skills)) throw new ArmConstructionError(`${scenarioId}: bundle ${bundle.id} has no skill "${slug}" to ablate`);
  const { [slug]: _removed, ...rest } = bundle.skills;
  return { ...bundle, id: `${bundle.id}~no-${slug}`, skills: rest };
}
