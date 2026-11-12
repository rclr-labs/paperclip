import { describe, expect, it } from "vitest";
import { ArmConstructionError, buildArms, type EvalBundle } from "./arms.js";

const bundle: EvalBundle = {
  id: "qa",
  adapter: "claude_local",
  instructions: { entryFile: "AGENTS.md", files: { "AGENTS.md": "rules" } },
  skills: { "qa-acceptance": { "SKILL.md": "x" }, other: { "SKILL.md": "y" } },
};

describe("buildArms", () => {
  it("removes instructions", () => {
    const [w, a] = buildArms({ id: "s", ablate: "instructions" }, bundle);
    expect(w.bundle).toBe(bundle);
    expect(a.bundle.instructions).toBeNull();
    expect(a.bundle.skills).toBe(bundle.skills);
  });

  it("removes only the named skill", () => {
    const [, a] = buildArms({ id: "s", ablate: "skill:qa-acceptance" }, bundle);
    expect(Object.keys(a.bundle.skills)).toEqual(["other"]);
    expect(a.bundle.instructions).toBe(bundle.instructions);
  });

  it("uses the supplied previous revision", () => {
    const prev = { ...bundle, revision: "abc" };
    expect(buildArms({ id: "s", ablate: "revision:previous" }, bundle, prev)[1]).toMatchObject({ bundle: prev, ablation: "previous revision abc" });
  });

  it("fails closed when the ablation target is missing", () => {
    expect(() => buildArms({ id: "s", ablate: "skill:nope" }, bundle)).toThrow(ArmConstructionError);
    expect(() => buildArms({ id: "s", ablate: "revision:previous" }, bundle)).toThrow(ArmConstructionError);
    expect(() => buildArms({ id: "s", ablate: "instructions" }, { ...bundle, instructions: null })).toThrow(ArmConstructionError);
  });
});

describe("buildArms with combined ablations", () => {
  it("removes instructions and the duplicating skill together", () => {
    const [, a] = buildArms({ id: "s", ablate: ["instructions", "skill:qa-acceptance"] }, bundle);
    expect(a.bundle.instructions).toBeNull();
    expect(Object.keys(a.bundle.skills)).toEqual(["other"]);
    expect(a.ablation).toBe("instructions removed + skill qa-acceptance removed");
  });
  it("refuses to combine revision:previous", () => {
    expect(() => buildArms({ id: "s", ablate: ["revision:previous", "instructions"] }, bundle, bundle)).toThrow(ArmConstructionError);
  });
});
