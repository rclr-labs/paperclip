import { describe, expect, it } from "vitest";
import { classifyAdmission } from "./report.js";

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
