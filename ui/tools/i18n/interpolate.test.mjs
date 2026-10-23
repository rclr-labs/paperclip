import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { buildInterpolation, nameFor } from "./interpolate.mjs";

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

function childrenOf(snippet) {
  const ast = parser.parse(`const x = ${snippet};`, { sourceType: "module", plugins: ["typescript", "jsx"] });
  return ast.program.body[0].declarations[0].init.children;
}
const build = (snippet) => buildInterpolation(childrenOf(snippet));

describe("nameFor", () => {
  it("names an identifier after itself", () => {
    expect(nameFor(childrenOf("<p>a {provider}</p>")[1].expression)).toBe("provider");
  });
  it("names a property access after the property", () => {
    expect(nameFor(childrenOf("<p>a {user.displayName}</p>")[1].expression)).toBe("displayName");
  });
  it("refuses a conditional", () => {
    expect(nameFor(childrenOf("<p>a {ok ? x : y}</p>")[1].expression)).toBeNull();
  });
  it("refuses a call", () => {
    expect(nameFor(childrenOf("<p>a {fmt(x)}</p>")[1].expression)).toBeNull();
  });
});

describe("buildInterpolation", () => {
  it("keeps the clause whole with a trailing value", () => {
    expect(build("<p>Sign in to {provider}</p>").message).toBe("Sign in to {{provider}}");
  });

  it("handles a leading value", () => {
    expect(build("<p>{count} completed runs await accounting</p>").message).toBe(
      "{{count}} completed runs await accounting",
    );
  });

  it("handles a value in the middle", () => {
    expect(build("<p>Keep {model}, your account, and settings</p>").message).toBe(
      "Keep {{model}}, your account, and settings",
    );
  });

  it("collapses source wrapping like JSX does", () => {
    expect(build("<p>\n  Last checked\n  {when}\n</p>").message).toBe("Last checked {{when}}");
  });

  it("treats the JSX space idiom as a space, never a placeholder", () => {
    const built = build('<p>Choose{" "}{provider} now</p>');
    expect(built.message).toBe("Choose {{provider}} now");
    expect(built.values).toHaveLength(1);
  });

  it("disambiguates two values that would share a name", () => {
    const built = build("<p>from {a.id} to {b.id}</p>");
    expect(built.message).toBe("from {{id}} to {{id2}}");
    expect(built.values.map((v) => v.name)).toEqual(["id", "id2"]);
  });

  it("refuses a clause holding an element", () => {
    expect(build("<p>Use the <code>x</code> for {thing}</p>")).toBeNull();
  });

  it("refuses a clause whose value cannot be named", () => {
    expect(build("<p>Status: {ok ? 'on' : 'off'}</p>")).toBeNull();
  });

  it("refuses when there is no text to translate", () => {
    expect(build("<p>{a} {b}</p>")).toBeNull();
  });

  it("refuses when there is no value", () => {
    expect(build("<p>Just text</p>")).toBeNull();
  });
});
