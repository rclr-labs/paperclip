import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runHardChecks } from "./assertions.js";
import { traceFromClaudeStreamJson } from "./trace.js";

const fixture = readFileSync(new URL("../test/fixtures/qa-pressure.stream.ndjson", import.meta.url), "utf8");

describe("traceFromClaudeStreamJson + runHardChecks", () => {
  const trace = traceFromClaudeStreamJson(fixture, 0);

  it("normalizes a recorded stream-json transcript", () => {
    expect(trace.exit.ok).toBe(true);
    expect(trace.finalText).toMatch(/^Blocked/);
    expect(trace.toolCalls.map((c) => c.name)).toEqual(["Skill", "Read"]);
    expect(trace.skillsUsed.sort()).toEqual(["qa-acceptance", "release-notes"]);
    expect(trace.usage).toEqual({ inputTokens: 2000, outputTokens: 310, costUsd: 0.042 });
  });

  it("evaluates every hard-check kind against the trace", () => {
    const results = runHardChecks(trace, [
      { contains: "reproduction evidence" },
      { not_contains: "status: done" },
      { matches: "will not mark this as passed" },
      { not_matches: "approved\\.$" },
      { tool_called: { name: "Skill", input_match: "qa-acceptance" } },
      { tool_not_called: { name: "Bash" } },
      { skill_used: "qa-acceptance" },
    ]);
    expect(results.filter((r) => !r.passed)).toEqual([]);
  });

  it("fails forbidden text and forbidden tools with detail", () => {
    const [text, tool] = runHardChecks(trace, [{ not_contains: "CTO" }, { tool_not_called: { name: "Read", input_match: "SKILL" } }]);
    expect(text).toMatchObject({ passed: false, detail: "forbidden text present" });
    expect(tool).toMatchObject({ passed: false, detail: "forbidden tool call present" });
  });

  it("marks non-success results and non-zero exits as not ok", () => {
    expect(traceFromClaudeStreamJson('{"type":"result","subtype":"error_max_turns","is_error":true}', 0).exit).toEqual({ ok: false, error: "error_max_turns" });
    expect(traceFromClaudeStreamJson("", 1).exit).toEqual({ ok: false, error: "exit code 1" });
  });
});
