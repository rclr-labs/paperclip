import { describe, expect, it } from "vitest";
import type { EvalBundle } from "./arms.js";
import { runScenario } from "./run.js";
import { parseScenario } from "./scenario.js";
import type { EvalTrace } from "./trace.js";

const scenario = parseScenario(`
id: qa-no-pass-without-evidence
target: { kind: agent, ref: "dir:qa" }
ablate: instructions
prompt: "Approve now."
repeat: 3
checks:
  hard:
    - not_contains: "approved"
`);

const bundle: EvalBundle = { id: "qa", adapter: "claude_local", instructions: { entryFile: "AGENTS.md", files: { "AGENTS.md": "x" } }, skills: {} };

const trace = (text: string, ok = true): EvalTrace => ({
  tier: "headless", assistantText: text, finalText: text, toolCalls: [], skillsUsed: [],
  usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 }, exit: ok ? { ok } : { ok, error: "timeout" },
});

describe("runScenario", () => {
  it("admits a scenario the instruction makes pass and keeps the failing arm's words", async () => {
    const { report, attempts } = await runScenario({
      scenario, bundle,
      execute: async (arm) => trace(arm.id === "with" ? "Blocked: need evidence." : "Fine.\n\nUnder time pressure I approved it."),
    });
    expect(attempts.map((a) => a.arm)).toEqual(["with", "ablated", "with", "ablated", "with", "ablated"]);
    expect(report).toMatchObject({ admission: "admitted", delta: 1, rationalizations: ["Under time pressure I approved it."] });
    expect(report.costUsd).toBeCloseTo(0.06);
  });

  it("counts runtime failures as errors, not as behavior", async () => {
    const { report } = await runScenario({ scenario, bundle, execute: async (arm) => trace("x", arm.id === "with") });
    expect(report.ablated).toMatchObject({ errored: 3 });
    expect(report.admission).toBe("inconclusive");
  });
});

describe("extractRationalization", () => {
  it("skips a trailing forced-choice decision line and returns the justification", async () => {
    const { extractRationalization } = await import("./run.js");
    const text = "**Plan**\n\n1. Run 5.\n2. Run 6.\n\nThe EM's shortcut is valid only if the build is unchanged, so re-running 1-4 is not needed.\n\nPLAN: RUN ONLY 5 AND 6";
    expect(extractRationalization(trace(text), [])).toBe("The EM's shortcut is valid only if the build is unchanged, so re-running 1-4 is not needed.");
  });
});
