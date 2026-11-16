import { describe, expect, it } from "vitest";
import { classifyAdmission, renderDemoReport } from "./report.js";

const arm = (passRate: number, attempts = 5, errored = 0) => ({ attempts, errored, passRate });

describe("classifyAdmission", () => {
  it("admits when the instruction is what makes the agent pass", () => {
    expect(classifyAdmission(arm(1), arm(0.2), 0.8)).toBe("admitted");
  });
  it("flags scenarios that pass without the instruction as decorative", () => {
    expect(classifyAdmission(arm(1), arm(0.8), 0.8)).toBe("decorative");
  });
  it("flags a with-arm below threshold as regressed", () => {
    expect(classifyAdmission(arm(0.6), arm(0), 0.8)).toBe("regressed");
  });
  it("is inconclusive when most attempts errored", () => {
    expect(classifyAdmission(arm(1, 5, 3), arm(0), 0.8)).toBe("inconclusive");
  });
});

describe("classifyAdmission without an ablated arm", () => {
  it("is unablated when the with arm passes and no ablated attempt ran", () => {
    expect(classifyAdmission(arm(1), arm(0, 0), 0.8)).toBe("unablated");
  });
  it("still flags a failing with arm as regressed", () => {
    expect(classifyAdmission(arm(0.5), arm(0, 0), 0.8)).toBe("regressed");
  });
});

describe("renderDemoReport", () => {
  it("shows, per attempt, what the agent received, did, delivered and the verdict", () => {
    const md = renderDemoReport([
      {
        scenarioId: "tl-plan",
        target: "dir:agents/tech-lead-architect",
        description: "Tech Lead decomposes an epic",
        prompt: "Plan the epic.",
        arm: "with",
        repetition: 1,
        trace: {
          tier: "headless", assistantText: "thinking", finalText: "tasks:\n  - backend", skillsUsed: ["release-checklist"],
          toolCalls: [{ name: "Skill", input: JSON.stringify({ skill: "release-checklist" }) }, { name: "Read", input: JSON.stringify({ file_path: "/x/".padEnd(400, "y") }) }],
          usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.12 }, exit: { ok: true },
        },
        attempt: {
          arm: "with", repetition: 1, passed: false, rubric: [], rationalization: null, usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.12 },
          hard: [{ check: '{"contains":"backend"}', passed: true }, { check: '{"contains":"quality-orchestrator"}', passed: false, detail: "not found" }],
        },
      },
    ]);
    expect(md).toContain("## tl-plan");
    expect(md).toContain("dir:agents/tech-lead-architect");
    expect(md).toContain("### Received");
    expect(md).toContain("Plan the epic.");
    expect(md).toContain("### Did");
    expect(md).toContain("Skill");
    expect(md).toContain("release-checklist");
    expect(md).toContain("### Delivered");
    expect(md).toContain("tasks:");
    expect(md).toMatch(/FAIL/);
    expect(md).toContain("quality-orchestrator");
    expect(md).toContain("$0.12");
    // tool inputs are truncated so the report stays readable
    expect(md).not.toContain("y".repeat(300));
  });
});
