import type { ArmId } from "./arms.js";
import type { HardCheckResult } from "./assertions.js";
import type { EvalScenario } from "./scenario.js";
import type { EvalTrace } from "./trace.js";

/** Outcome of one repetition of one arm. */
export interface AttemptResult {
  readonly arm: ArmId;
  readonly repetition: number;
  readonly passed: boolean;
  readonly hard: readonly HardCheckResult[];
  /** Judge verdicts per rubric criterion; empty when hard checks already failed or there is no rubric. */
  readonly rubric: readonly { readonly criterion: string; readonly passed: boolean; readonly reason: string; readonly quote: string }[];
  /** Verbatim justification from a failing attempt — raw material for the instruction's Excuse/Reality table. */
  readonly rationalization: string | null;
  readonly usage: EvalTrace["usage"];
  readonly error?: string;
}

/**
 * - `admitted`: the instruction is what makes the agent pass (with ≥ threshold, ablated < threshold).
 * - `decorative`: the agent passes even without the instruction — the scenario tests nothing.
 * - `regressed`: the arm WITH the instruction is below threshold — fix the instruction.
 * - `inconclusive`: too many attempts errored to judge.
 * - `unablated`: the with arm passed but no ablated arm ran (demo/smoke run), so nothing is proven about the instruction.
 */
export type Admission = "admitted" | "decorative" | "regressed" | "inconclusive" | "unablated";

export interface ArmSummary {
  readonly attempts: number;
  readonly errored: number;
  readonly passRate: number;
}

export interface ScenarioReport {
  readonly scenarioId: string;
  readonly threshold: number;
  readonly with: ArmSummary;
  readonly ablated: ArmSummary;
  readonly delta: number;
  readonly admission: Admission;
  readonly rationalizations: readonly string[];
  readonly costUsd: number;
}

export function summarizeArm(attempts: readonly AttemptResult[]): ArmSummary {
  const errored = attempts.filter((a) => a.error !== undefined).length;
  const judged = attempts.length - errored;
  const passed = attempts.filter((a) => a.error === undefined && a.passed).length;
  return { attempts: attempts.length, errored, passRate: judged === 0 ? 0 : passed / judged };
}

/**
 * Decide whether a scenario belongs in the suite.
 *
 * This is the instruction-level mutation test: a scenario that passes without
 * the instruction is decoration.
 */
export function classifyAdmission(withArm: ArmSummary, ablated: ArmSummary, threshold: number): Admission {
  // Errors first: an arm that mostly timed out or crashed says nothing.
  if (withArm.errored > withArm.attempts / 2 || ablated.errored > ablated.attempts / 2) return "inconclusive";
  // The instruction itself must hold; a worse ablated arm does not excuse it.
  if (withArm.passRate < threshold) return "regressed";
  if (ablated.attempts === 0) return "unablated";
  if (ablated.passRate >= threshold) return "decorative";
  return "admitted";
}

export function buildScenarioReport(scenario: Pick<EvalScenario, "id" | "threshold">, attempts: readonly AttemptResult[]): ScenarioReport {
  const withArm = summarizeArm(attempts.filter((a) => a.arm === "with"));
  const ablated = summarizeArm(attempts.filter((a) => a.arm === "ablated"));
  const rationalizations = [
    ...new Set(attempts.filter((a) => !a.passed && a.rationalization).map((a) => a.rationalization as string)),
  ];
  const costUsd = attempts.reduce((sum, a) => sum + (a.usage.costUsd ?? 0), 0);
  return {
    scenarioId: scenario.id,
    threshold: scenario.threshold,
    with: withArm,
    ablated,
    delta: withArm.passRate - ablated.passRate,
    admission: classifyAdmission(withArm, ablated, scenario.threshold),
    rationalizations,
    costUsd,
  };
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

export function renderMarkdownReport(reports: readonly ScenarioReport[]): string {
  const lines = [
    "# Agent instruction evals",
    "",
    "| Scenario | with | ablated | Δ | Admission | Cost |",
    "|---|---|---|---|---|---|",
    ...reports.map(
      (r) =>
        `| ${r.scenarioId} | ${pct(r.with.passRate)} (${r.with.attempts}${r.with.errored ? `, ${r.with.errored} err` : ""}) | ${r.ablated.attempts === 0 ? "—" : `${pct(r.ablated.passRate)} (${r.ablated.attempts}${r.ablated.errored ? `, ${r.ablated.errored} err` : ""})`} | ${r.ablated.attempts === 0 ? "—" : pct(r.delta)} | ${r.admission} | $${r.costUsd.toFixed(2)} |`,
    ),
  ];
  for (const r of reports) {
    if (r.rationalizations.length === 0) continue;
    lines.push("", `## ${r.scenarioId}: rationalizations`, "", ...r.rationalizations.map((q) => `> ${q.replace(/\n/g, " ")}`));
  }
  return `${lines.join("\n")}\n`;
}

/** One attempt, with enough context to show a person what the agent got and what it did. */
export interface DemoEntry {
  readonly scenarioId: string;
  readonly target: string;
  readonly description?: string;
  readonly prompt: string;
  readonly arm: ArmId;
  readonly repetition: number;
  readonly trace?: EvalTrace;
  readonly attempt: AttemptResult;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

function describeToolCall(name: string, input: string): string {
  let detail = input;
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    const key = ["skill", "file_path", "command", "pattern", "url", "description"].find((k) => typeof parsed[k] === "string");
    if (key) detail = String(parsed[key]);
  } catch {
    // keep the raw input
  }
  return `\`${name}\` ${clip(detail.replace(/\s+/g, " "), 160)}`;
}

/**
 * Per-attempt narrative for a demo: what the agent received (the prompt), what it did (skills
 * loaded, tool calls), what it delivered (final text) and the check verdict. The admission table
 * in `renderMarkdownReport` says whether the instruction matters; this says what the agent does.
 */
export function renderDemoReport(entries: readonly DemoEntry[]): string {
  const lines = ["# Agent evals: what each agent did", ""];
  for (const e of entries) {
    const a = e.attempt;
    const verdict = a.error ? `ERROR (${a.error})` : a.passed ? "PASS" : "FAIL";
    lines.push(`## ${e.scenarioId} (${e.arm} #${e.repetition}): ${verdict}`, "");
    lines.push(`- Target: \`${e.target}\``);
    if (e.description) lines.push(`- Scenario: ${e.description.trim()}`);
    const cost = a.usage.costUsd === null ? "n/a" : `$${a.usage.costUsd.toFixed(2)}`;
    lines.push(`- Cost: ${cost} (${a.usage.inputTokens} in / ${a.usage.outputTokens} out tokens)`, "");
    lines.push("### Received", "", "```text", e.prompt.trim(), "```", "");
    lines.push("### Did", "");
    const t = e.trace;
    if (!t) lines.push("- (no trace: the attempt failed before the agent ran)");
    else {
      lines.push(`- Skills loaded: ${t.skillsUsed.length ? t.skillsUsed.map((s) => `\`${s}\``).join(", ") : "none"}`);
      if (t.toolCalls.length === 0) lines.push("- Tool calls: none");
      else lines.push(`- Tool calls (${t.toolCalls.length}):`, ...t.toolCalls.slice(0, 30).map((c, i) => `  ${i + 1}. ${describeToolCall(c.name, c.input)}`));
      if (t.toolCalls.length > 30) lines.push(`  … ${t.toolCalls.length - 30} more`);
    }
    lines.push("", "### Delivered", "");
    const delivered = t ? (t.finalText || t.assistantText).trim() : "";
    lines.push(delivered ? delivered.split("\n").map((l) => `> ${l}`).join("\n") : "_(nothing)_", "");
    lines.push("### Verdict", "");
    for (const h of a.hard) lines.push(`- ${h.passed ? "pass" : "FAIL"} ${h.check}${h.detail ? ` — ${h.detail}` : ""}`);
    for (const r of a.rubric) lines.push(`- ${r.passed ? "pass" : "FAIL"} (judge) ${r.criterion} — ${r.reason}`);
    if (a.hard.length + a.rubric.length === 0) lines.push(`- ${verdict}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
