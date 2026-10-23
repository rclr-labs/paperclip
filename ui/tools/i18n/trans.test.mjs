import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { buildTrans } from "./trans.mjs";

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

const build = (snippet) => {
  const ast = parser.parse(`const x = ${snippet};`, { sourceType: "module", plugins: ["typescript", "jsx"] });
  return buildTrans(ast.program.body[0].declarations[0].init.children);
};

describe("buildTrans", () => {
  it("numbers the inline element by its child index", () => {
    expect(build("<p>Use the <code>x</code> to run</p>").message).toBe("Use the <1>x</1> to run");
  });

  it("numbers a leading element as zero", () => {
    expect(build("<p><strong>Ada</strong> signed in</p>").message).toBe("<0>Ada</0> signed in");
  });

  it("numbers two elements independently", () => {
    expect(build("<p>Read <a>docs</a> then <a>guides</a></p>").message).toBe(
      "Read <1>docs</1> then <3>guides</3>",
    );
  });

  it("collapses source wrapping like JSX does", () => {
    expect(build("<p>\n  Signed in as\n  <strong>Ada</strong>\n</p>").message).toBe("Signed in as <1>Ada</1>");
  });

  it("refuses a decorative icon beside a label, which plain t() handles", () => {
    expect(build("<Button><Copy /> Copy endpoint</Button>")).toBeNull();
  });

  it("refuses a clause whose only element is empty", () => {
    expect(build("<p>Line one<br /> line two</p>")).toBeNull();
  });

  it("keeps an empty element when another one carries text", () => {
    expect(build("<p>See <a>docs</a><br /> below</p>").message).toBe("See <1>docs</1><2></2> below");
  });

  it("treats the JSX space idiom as a space", () => {
    expect(build('<p>Open{" "}<a>the docs</a></p>').message).toBe("Open <2>the docs</2>");
  });

  it("indexes what React receives, not the AST, when JSX is wrapped", () => {
    // JSX drops whitespace-only text containing a newline, so the span is at
    // runtime index 2 even though it sits at 3 in the AST children array.
    const snippet = [
      "<p>",
      '  Ask an administrator to grant you the{" "}',
      '  <span className="font-mono">audit:view_agent_actions</span>{" "}',
      "  permission to view it.",
      "</p>",
    ].join("\n");
    expect(build(snippet).message).toBe(
      "Ask an administrator to grant you the <2>audit:view_agent_actions</2> permission to view it.",
    );
  });

  it("keeps a single-line space between elements, which JSX does not drop", () => {
    expect(build("<p>See <a>docs</a> and <a>guides</a></p>").message).toBe(
      "See <1>docs</1> and <3>guides</3>",
    );
  });

  it("refuses an inline element holding another element", () => {
    expect(build("<p>See <a><em>docs</em></a> now</p>")).toBeNull();
  });

  it("refuses an inline element holding an expression", () => {
    expect(build("<p>See <a>{label}</a> now</p>")).toBeNull();
  });

  it("refuses a clause with a value expression, which needs interpolation", () => {
    expect(build("<p>Hi {name}, see <a>docs</a></p>")).toBeNull();
  });

  it("refuses a layout container whose children are all elements", () => {
    expect(build("<div><Label>Name</Label><Input /></div>")).toBeNull();
  });

  it("refuses a component wrapper like SelectContent", () => {
    expect(build("<SelectContent><SelectItem>A</SelectItem><SelectItem>B</SelectItem></SelectContent>")).toBeNull();
  });

  it("refuses a row of buttons", () => {
    expect(build("<div><Button>Save</Button><Button>Cancel</Button></div>")).toBeNull();
  });

  it("refuses a clause with no inline element", () => {
    expect(build("<p>Just text</p>")).toBeNull();
  });

  it("refuses a wrapped token with no prose", () => {
    expect(build("<p><code>x</code></p>")).toBeNull();
  });
});
