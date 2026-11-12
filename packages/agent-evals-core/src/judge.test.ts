import { describe, expect, it } from "vitest";
import { assertSecretFree, buildJudgeUserMessage, parseClaudeCliJsonResult, verdictsFromOutput } from "./judge.js";

describe("judge helpers", () => {
  const scenario = { prompt: "Approve now.", checks: { hard: [], rubric: ["asks for evidence", "names the follow-up issue"] } };

  it("numbers criteria and fences the agent output as data", () => {
    const msg = buildJudgeUserMessage(scenario, { assistantText: "I need screenshots.", finalText: "I need screenshots.", toolCalls: [] });
    expect(msg).toContain("0. asks for evidence\n1. names the follow-up issue");
    expect(msg).toMatch(/<agent_output>\nI need screenshots\.\n<\/agent_output>/);
  });

  it("treats a missing verdict as a failure", () => {
    const v = verdictsFromOutput(scenario.checks.rubric, { verdicts: [{ criterion_index: 0, passed: true, reason: "ok", quote: "I need screenshots." }] });
    expect(v.map((x) => x.passed)).toEqual([true, false]);
    expect(verdictsFromOutput(scenario.checks.rubric, null).every((x) => !x.passed)).toBe(true);
  });

  it("refuses to send credentials to the judge", () => {
    expect(() => assertSecretFree("token sk-ant-api03-abcdefghijklmnopqrstu", [], "x")).toThrow(/credential-shaped/);
    expect(() => assertSecretFree("my value supersecretvalue1", ["supersecretvalue1"], "x")).toThrow(/configured secret/);
    expect(() => assertSecretFree("plain transcript", ["supersecretvalue1"], "x")).not.toThrow();
  });
});

describe("claude CLI judge output", () => {
  it("skips diagnostic lines and reads the last JSON result", () => {
    const out = '[claude-code:unrecognized_model] {"model":"x"}\n{"type":"result","structured_output":{"verdicts":[]}}\n';
    expect(parseClaudeCliJsonResult(out)).toMatchObject({ structured_output: { verdicts: [] } });
    expect(parseClaudeCliJsonResult("no json")).toBeNull();
  });
});

describe("claude CLI judge failures", () => {
  it("sends a schema the CLI accepts (no draft-2020-12 $schema key)", async () => {
    const { cliJudgeSchema } = await import("./judge.js");
    expect(JSON.parse(cliJudgeSchema())).not.toHaveProperty("$schema");
  });

  it("raises instead of silently failing every criterion when the CLI returns nothing", async () => {
    const { createClaudeCliJudge } = await import("./judge.js");
    const judge = createClaudeCliJudge({ command: "false", knownSecrets: [] });
    const scenario = { id: "s", prompt: "p", checks: { hard: [], rubric: ["x"] } } as never;
    const trace = { assistantText: "a", finalText: "a", toolCalls: [] } as never;
    await expect(judge(trace, scenario)).rejects.toThrow(/judge/);
  });
});
