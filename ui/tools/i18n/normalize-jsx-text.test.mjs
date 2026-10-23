import { describe, expect, it } from "vitest";
import { normalizeJsxText } from "./extract.mjs";

describe("normalizeJsxText", () => {
  it("collapses a newline plus source indentation into one space", () => {
    expect(normalizeJsxText("so no agent will\n              be woken to act on it.")).toBe(
      "so no agent will be woken to act on it.",
    );
  });

  it("collapses several wrapped lines", () => {
    expect(
      normalizeJsxText("\n          This comment will be posted without an assignee, so\n          no agent will be woken.\n        "),
    ).toBe("This comment will be posted without an assignee, so no agent will be woken.");
  });

  it("leaves a single-line string untouched apart from trimming", () => {
    expect(normalizeJsxText("  Create account  ")).toBe("Create account");
  });

  it("keeps single spaces between words", () => {
    expect(normalizeJsxText("Sign in / Create account")).toBe("Sign in / Create account");
  });

  it("matches what JSX would render, not what the source looks like", () => {
    // The source wraps; the DOM does not. The catalogue must hold the DOM form.
    const source = "A run finished successfully, but the task\n        still needs a next step.";
    expect(normalizeJsxText(source)).toBe("A run finished successfully, but the task still needs a next step.");
  });
});
