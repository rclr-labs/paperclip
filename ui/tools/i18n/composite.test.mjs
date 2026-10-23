import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { classifyTextNode } from "./composite.mjs";

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

/** Classifies the first non-whitespace text node in a JSX snippet. */
function classify(snippet) {
  const ast = parser.parse(`const x = ${snippet};`, { sourceType: "module", plugins: ["typescript", "jsx"] });
  let answer = null;
  const walk = (node, parent) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach((c) => walk(c, parent));
    if (typeof node.type !== "string") return;
    if (node.type === "JSXText" && node.value.trim() && answer === null) {
      answer = classifyTextNode(parent, node);
      return;
    }
    for (const key of Object.keys(node)) {
      if (key === "loc") continue;
      walk(node[key], node.type === "JSXElement" || node.type === "JSXFragment" ? node : parent);
    }
  };
  walk(ast.program, null);
  return answer;
}

describe("classifyTextNode", () => {
  it.each([
    ["a bare label", "<span>Copy message</span>"],
    ["an icon before the label", '<Button><Copy className="size-4" /> Copy message</Button>'],
    ["an icon after the label", "<Button>Terminate <Spinner /></Button>"],
    ["icons on both sides", "<Button><Icon /> Reset Sessions <Chevron /></Button>"],
    ["a self-closing sibling with props only", '<div><img src="x" alt="" /> Raw tracing on</div>'],
  ])("calls %s standalone", (_label, snippet) => {
    expect(classify(snippet)).toBe("standalone");
  });

  it.each([
    ["a sibling link carrying text", "<p>Read the <a>docs</a></p>"],
    ["a sibling element carrying text", "<p>Signed in as <strong>Ada</strong></p>"],
    ["an expression after the text", "<p>Sign in to {provider}</p>"],
    ["an expression before the text", "<p>{count} completed runs await accounting</p>"],
    ["two text runs around an element", "<p>Use the <code>x</code> to run</p>"],
    ["a nested element holding an expression", "<p>Limit <strong>{max}</strong></p>"],
  ])("calls %s split", (_label, snippet) => {
    expect(classify(snippet)).toBe("split");
  });
});
