import { buildJudgeUserMessage, judgeOutputSchema, verdictsFromOutput, type JudgeAttempt, type JudgeOutput } from "@paperclipai/agent-evals-core";
import { runEvalIssue, type IssueRunInput } from "./heartbeat-tier.js";

/**
 * Rubric judge that runs as a Paperclip agent (the company's "Eval Judge",
 * see eval-agents.ts) on the company's own AI connection: no API key.
 *
 * A judge run that fails, or whose answer is not a parseable verdict list,
 * throws. The scenario runner records a thrown judge as an errored attempt,
 * never as a pass.
 */

/**
 * The last JSON object in the judge's answer that matches the verdict schema.
 * The judge's chat and the comments it posted are both scanned, so a verdict
 * list posted on the issue still counts when the chat ends with a summary.
 */
export function parseJudgeAnswer(text: string): JudgeOutput | null {
  const candidates: string[] = [];
  for (const fenced of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(fenced[1]!);
  // Every balanced top-level {...} span, scanned from each opening brace.
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i]!;
      if (inString) {
        if (ch === "\\") i++;
        else if (ch === "\"") inString = false;
      } else if (ch === "\"") inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        candidates.push(text.slice(start, i + 1));
        break;
      }
    }
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const parsed = judgeOutputSchema.safeParse(JSON.parse(candidates[i]!.trim()));
      if (parsed.success) return parsed.data;
    } catch {
      // not JSON; try the previous candidate
    }
  }
  return null;
}

export function createHeartbeatJudge(input: IssueRunInput & {
  readonly judgeAgentId: () => Promise<string>;
  readonly onCost?: (costUsd: number) => void;
}): JudgeAttempt {
  return async (trace, scenario) => {
    if (scenario.checks.rubric.length === 0) return [];
    const agentId = await input.judgeAgentId();
    const description = [
      buildJudgeUserMessage(scenario, trace),
      "",
      "Grade every criterion above. Reply with exactly one JSON object: {\"verdicts\":[{\"criterion_index\":0,\"passed\":true,\"reason\":\"…\",\"quote\":\"…\"}]}",
    ].join("\n");
    const judged = await runEvalIssue(input, agentId, `eval · judge · ${scenario.id}`, description, `${scenario.id}:judge`);
    input.onCost?.(judged.usage.costUsd ?? 0);
    if (!judged.exit.ok) throw new Error(`judge run failed: ${judged.exit.error ?? "unknown error"}`);
    const output = parseJudgeAnswer(`${judged.assistantText}\n${judged.finalText}`);
    if (!output) throw new Error("judge answer is not a parseable verdict list");
    return verdictsFromOutput(scenario.checks.rubric, output);
  };
}
