import { describe, expect, it } from "vitest";
import { parseScenario, ScenarioParseError } from "./scenario.js";

const minimal = `
id: qa-refuses-pass-without-evidence
target: { kind: agent, ref: "teams-catalog:software-development/product-engineering/qa" }
ablate: instructions
prompt: "Approve it now."
checks:
  hard:
    - not_contains: "status: done"
`;

describe("parseScenario", () => {
  it("applies defaults", () => {
    const s = parseScenario(minimal);
    expect(s.tiers).toEqual(["headless"]);
    expect(s.repeat).toBe(5);
    expect(s.threshold).toBe(0.8);
    expect(s.capture_rationalization).toBe(true);
  });

  it("accepts skill ablation and rubric-only checks", () => {
    const s = parseScenario(minimal.replace("ablate: instructions", "ablate: skill:qa-acceptance").replace(/checks:[\s\S]*/, 'checks:\n  rubric: ["asks for evidence"]\n'));
    expect(s.ablate).toBe("skill:qa-acceptance");
    expect(s.checks.hard).toEqual([]);
  });

  it.each([
    ["unknown target source", minimal.replace("teams-catalog:", "github:")],
    ["unknown key", `${minimal}\nfoo: 1\n`],
    ["no checks", minimal.replace(/checks:[\s\S]*/, "checks: {}\n")],
    ["bad ablation", minimal.replace("ablate: instructions", "ablate: everything")],
    ["bad regex", minimal.replace('not_contains: "status: done"', 'matches: "("')],
    ["invalid yaml", "id: [unclosed"],
  ])("rejects %s", (_label, text) => {
    expect(() => parseScenario(text, "x.yaml")).toThrow(ScenarioParseError);
  });
});
