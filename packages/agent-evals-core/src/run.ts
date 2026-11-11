import { buildArms, type EvalArm, type EvalBundle } from "./arms.js";
import { runHardChecks } from "./assertions.js";
import { buildScenarioReport, type AttemptResult, type ScenarioReport } from "./report.js";
import type { EvalScenario } from "./scenario.js";
import type { EvalTrace } from "./trace.js";

/**
 * Run one scenario on both arms, `repeat` times each.
 *
 * Arms depend on the scenario (the ablation is per scenario), so this does not
 * go through the eval-kernel matrix, whose candidates are scenario-independent.
 */

export type ExecuteAttempt = (arm: EvalArm, scenario: EvalScenario, repetition: number) => Promise<EvalTrace>;

export interface RubricVerdict {
  readonly criterion: string;
  readonly passed: boolean;
  readonly reason: string;
  /** Verbatim excerpt from the trace backing the verdict. */
  readonly quote: string;
}

export type JudgeAttempt = (trace: EvalTrace, scenario: EvalScenario) => Promise<readonly RubricVerdict[]>;

export interface RunScenarioInput {
  readonly scenario: EvalScenario;
  readonly bundle: EvalBundle;
  readonly previousRevision?: EvalBundle;
  readonly execute: ExecuteAttempt;
  /** Omit to skip rubric criteria (the report then counts hard checks only). */
  readonly judge?: JudgeAttempt;
  readonly onAttempt?: (attempt: AttemptResult) => void;
}

/** Last assistant paragraph of a failing attempt: where the agent explains itself. */
export function extractRationalization(trace: EvalTrace, verdicts: readonly RubricVerdict[]): string | null {
  const failedQuote = verdicts.find((v) => !v.passed && v.quote.trim().length > 0)?.quote;
  if (failedQuote) return failedQuote.trim();
  const text = (trace.finalText || trace.assistantText).trim();
  if (!text) return null;
  // Scenarios end with a forced-choice line ("DECISION: X"); the reasoning is the paragraph before it.
  const isDecisionLine = (p: string) => /^[A-Z][A-Z -]*:\s*[A-Z0-9][A-Z0-9 -]*$/.test(p.trim());
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 0 && !isDecisionLine(p));
  return (paragraphs[paragraphs.length - 1] ?? text).slice(0, 600);
}

export async function runScenario(input: RunScenarioInput): Promise<{ report: ScenarioReport; attempts: AttemptResult[] }> {
  const { scenario } = input;
  const arms = buildArms(scenario, input.bundle, input.previousRevision);
  const attempts: AttemptResult[] = [];

  for (let repetition = 1; repetition <= scenario.repeat; repetition++) {
    // Interleave arms so drift over time (rate limits, model updates) hits both equally.
    for (const arm of arms) {
      let attempt: AttemptResult;
      try {
        const trace = await input.execute(arm, scenario, repetition);
        if (!trace.exit.ok) {
          attempt = { arm: arm.id, repetition, passed: false, hard: [], rubric: [], rationalization: null, usage: trace.usage, error: trace.exit.error ?? "run failed" };
        } else {
          const hard = runHardChecks(trace, scenario.checks.hard);
          const hardOk = hard.every((h) => h.passed);
          const rubric = hardOk && input.judge && scenario.checks.rubric.length > 0 ? await input.judge(trace, scenario) : [];
          const rubricOk = input.judge ? rubric.every((r) => r.passed) : true;
          const passed = hardOk && rubricOk;
          attempt = {
            arm: arm.id,
            repetition,
            passed,
            hard,
            rubric,
            rationalization: !passed && scenario.capture_rationalization ? extractRationalization(trace, rubric) : null,
            usage: trace.usage,
          };
        }
      } catch (err) {
        attempt = {
          arm: arm.id,
          repetition,
          passed: false,
          hard: [],
          rubric: [],
          rationalization: null,
          usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
          error: err instanceof Error ? err.message : String(err),
        };
      }
      attempts.push(attempt);
      input.onAttempt?.(attempt);
    }
  }
  return { report: buildScenarioReport(scenario, attempts), attempts };
}
