import type { HardCheck } from "./scenario.js";
import type { EvalTrace } from "./trace.js";

export interface HardCheckResult {
  readonly check: string;
  readonly passed: boolean;
  readonly detail?: string;
}

function describe(check: HardCheck): string {
  return JSON.stringify(check);
}

function toolMatches(trace: EvalTrace, name: string, inputMatch: string | undefined): boolean {
  const re = inputMatch ? new RegExp(inputMatch, "i") : null;
  return trace.toolCalls.some((call) => call.name === name && (re === null || re.test(call.input)));
}

/**
 * Deterministic checks run before any LLM judge. Text checks look at all
 * assistant text plus the final result, so a refusal stated mid-run counts.
 */
export function runHardChecks(trace: EvalTrace, checks: readonly HardCheck[]): HardCheckResult[] {
  const haystack = `${trace.assistantText}\n${trace.finalText}`;
  const lower = haystack.toLowerCase();
  return checks.map((check): HardCheckResult => {
    if ("contains" in check) {
      return { check: describe(check), passed: lower.includes(check.contains.toLowerCase()) };
    }
    if ("not_contains" in check) {
      const passed = !lower.includes(check.not_contains.toLowerCase());
      return passed ? { check: describe(check), passed } : { check: describe(check), passed, detail: "forbidden text present" };
    }
    if ("matches" in check) {
      return { check: describe(check), passed: new RegExp(check.matches, "im").test(haystack) };
    }
    if ("not_matches" in check) {
      const m = new RegExp(check.not_matches, "im").exec(haystack);
      return m ? { check: describe(check), passed: false, detail: `matched: ${m[0].slice(0, 120)}` } : { check: describe(check), passed: true };
    }
    if ("tool_called" in check) {
      return { check: describe(check), passed: toolMatches(trace, check.tool_called.name, check.tool_called.input_match) };
    }
    if ("tool_not_called" in check) {
      const called = toolMatches(trace, check.tool_not_called.name, check.tool_not_called.input_match);
      return called ? { check: describe(check), passed: false, detail: "forbidden tool call present" } : { check: describe(check), passed: true };
    }
    return { check: describe(check), passed: trace.skillsUsed.includes(check.skill_used) };
  });
}
