import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { isRenderedBranch, jsxPosition } from "./expression-literal.mjs";

const require_ = createRequire(import.meta.url);
function loadParser() {
  try {
    return require_("@babel/parser");
  } catch {}
  const base = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../node_modules/.pnpm");
  const dir = fs.readdirSync(base).find((d) => d.startsWith("@babel+parser@"));
  return require_(path.resolve(base, dir, "node_modules/@babel/parser"));
}
const parser = loadParser();

/** Finds the first StringLiteral and reports where it sits. */
function locate(snippet) {
  const ast = parser.parse(`const x = ${snippet};`, { sourceType: "module", plugins: ["typescript", "jsx"] });
  let answer = null;
  const walk = (node, ancestors) => {
    if (!node || typeof node !== "object" || answer) return;
    if (Array.isArray(node)) return node.forEach((c) => walk(c, ancestors));
    if (typeof node.type !== "string") return;
    if (node.type === "StringLiteral" && answer === null) {
      answer = { position: jsxPosition(ancestors), branch: isRenderedBranch(ancestors) };
      return;
    }
    for (const key of Object.keys(node)) {
      if (key !== "loc") walk(node[key], [...ancestors, node]);
    }
  };
  walk(ast.program, []);
  return answer;
}

describe("jsxPosition", () => {
  it("calls a rendered ternary branch a child", () => {
    expect(locate('<p>{ready ? "Ready" : "Not ready"}</p>').position).toBe("child");
  });

  it("calls a rendered && branch a child", () => {
    expect(locate('<p>{busy && "Working"}</p>').position).toBe("child");
  });

  it("refuses an attribute, which may be a typed union", () => {
    expect(locate('<Avatar label={mine ? "Assignee" : "Originating"} />').position).toBe("attribute");
  });

  it("refuses a className, which is CSS", () => {
    expect(locate('<div className={busy ? "opacity-50" : "opacity-100"} />').position).toBe("attribute");
  });

  it("refuses anything passed through a call", () => {
    expect(locate('<div className={cn(busy ? "flex gap-2" : "grid")} />').position).toBe("call");
  });

  it("refuses a call in child position too", () => {
    expect(locate('<p>{format(ok ? "Yes" : "No")}</p>').position).toBe("call");
  });

  it("reports a literal outside JSX", () => {
    expect(locate('<p>{label}</p>')).toBeNull();
  });
});

describe("isRenderedBranch", () => {
  it("accepts a ternary branch", () => {
    expect(locate('<p>{ready ? "Ready" : "No"}</p>').branch).toBe(true);
  });

  it("rejects a literal that is not a branch", () => {
    expect(locate('<p>{"just a literal"}</p>').branch).toBe(false);
  });
});
