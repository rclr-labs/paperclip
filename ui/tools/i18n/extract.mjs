#!/usr/bin/env node
/**
 * Extracts user-visible strings from .tsx files into the i18n catalogue.
 *
 * Parses with a real AST (@babel/parser) rather than regex, because the hard
 * part is not rewriting the string — it is finding the component that owns it,
 * so `const { t } = useTranslation()` lands where a hook is legal.
 *
 * Conservative by design. Anything it cannot reason about is counted and left
 * untouched:
 *   - text whose parent element also holds an expression (needs <Trans>)
 *   - components with an expression body (no block to host a hook)
 *   - strings inside non-component functions
 *
 * Usage:
 *   node tools/i18n/extract.mjs --dir ui/src [--limit 20] [--apply]
 *   node tools/i18n/extract.mjs --file ui/src/pages/Foo.tsx --apply
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

// Resolved from this file so the tool works from any cwd.
const UI_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const LOCALES_DIR = path.join(UI_ROOT, "src/i18n/locales");

/** The repo ships TypeScript 7 (native), which exposes no JS AST API, and pnpm
 *  isolation hides transitive deps from the root. Resolve the parser by path. */
function loadParser() {
  try {
    return require_("@babel/parser");
  } catch {}
  const base = path.join(UI_ROOT, "..", "node_modules/.pnpm");
  const dir = fs.readdirSync(base).find((d) => d.startsWith("@babel+parser@"));
  if (!dir) throw new Error("@babel/parser not found; run pnpm install");
  return require_(path.resolve(base, dir, "node_modules/@babel/parser"));
}
const parser = loadParser();

import { isTranslatable } from "./translatable.mjs";
import { isExcludedFile } from "./excluded.mjs";
import { classifyTextNode } from "./composite.mjs";
import { buildInterpolation } from "./interpolate.mjs";
import { buildTrans } from "./trans.mjs";

/** Attributes that are DOM passthroughs on any element. */
const UI_ATTRS = new Set(["placeholder", "aria-label", "alt"]);

/**
 * `label` and `title` are only safe on a DOM element. On a custom component
 * they are author-defined props that may carry a TYPE, not copy — e.g.
 * `<AttributionAvatar label="Assignee">` where the prop is
 * `"Assignee" | "Originating"`. Replacing that with `t(...)` widens it to
 * string and stops compiling, which no render test catches.
 */
const DOM_ONLY_ATTRS = new Set(["label", "title"]);

function isDomElement(node) {
  const name = node?.openingElement?.name ?? node?.name;
  const text = name?.type === "JSXIdentifier" ? name.name : null;
  return text !== null && /^[a-z]/.test(text);
}
const EN = path.join(LOCALES_DIR, "en.json");

const args = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const APPLY = args.includes("--apply");
const LIMIT = Number(opt("limit", "0")) || 0;

const stats = { files: 0, withStrings: 0, changed: 0, keys: 0, interpolated: 0, trans: 0, needsTrans: 0, noComponent: 0, exprBody: 0 };

/**
 * JSX collapses any whitespace run containing a newline into a single space
 * when it renders. A catalogue string does not: React renders a string child
 * verbatim. So source indentation must be collapsed at extraction time, or a
 * sentence written across three lines renders with newlines and 14 spaces in
 * the middle of it.
 */
function normalizeJsxText(raw) {
  return raw.trim().replace(/\s*\n\s*/g, " ");
}

function slugKey(text) {
  const words = text.trim().toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean).slice(0, 6);
  if (!words.length) return "text";
  return words.map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1))).join("");
}

function namespaceFor(file) {
  const rel = path.relative(path.join(UI_ROOT, "src"), path.resolve(file)).replace(/\.tsx$/, "");
  return rel.split(path.sep).map((p) => p.replace(/[^A-Za-z0-9]/g, "")).map((p, i) => (i === 0 ? p : p[0].toLowerCase() + p.slice(1))).filter(Boolean);
}

/**
 * True when this node sits inside a <Trans> the extractor already added.
 *
 * Unlike the other transforms, <Trans> WRAPS rather than replaces, so running
 * again over its own output would nest a second wrapper around the first. The
 * other phases are idempotent for free: the key already holds the same value,
 * so the edit is skipped.
 */
function insideTrans(ancestors) {
  return ancestors.some(
    (node) => node.type === "JSXElement" && node.openingElement?.name?.name === "Trans",
  );
}

const FN_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ObjectMethod", "ClassMethod"]);

/** Nearest enclosing React component, or null when a hook cannot go there. */
function enclosingComponent(ancestors) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const node = ancestors[i];
    if (!FN_TYPES.has(node.type)) continue;
    const parent = ancestors[i - 1];
    const grand = ancestors[i - 2];
    let name = null;
    if (node.type === "FunctionDeclaration" && node.id && /^[A-Z]/.test(node.id.name)) name = node.id.name;
    else if (parent?.type === "VariableDeclarator" && parent.id?.type === "Identifier" && /^[A-Z]/.test(parent.id.name)) name = parent.id.name;
    // const Foo = memo(() => {...}) / forwardRef(...)
    else if (parent?.type === "CallExpression" && grand?.type === "VariableDeclarator" && grand.id?.type === "Identifier" && /^[A-Z]/.test(grand.id.name)) name = grand.id.name;

    if (!name) return { component: null, reason: "noComponent" };
    if (node.body?.type !== "BlockStatement") return { component: null, reason: "exprBody" };
    return { component: { name, body: node.body } };
  }
  return { component: null, reason: "noComponent" };
}

function walk(node, ancestors, fn) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const c of node) walk(c, ancestors, fn);
    return;
  }
  if (typeof node.type !== "string") return;
  fn(node, ancestors);
  const next = [...ancestors, node];
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue;
    walk(node[key], next, fn);
  }
}

function parse(src, file) {
  return parser.parse(src, {
    sourceType: "module",
    plugins: ["typescript", "jsx", "decorators-legacy", "classProperties"],
    errorRecovery: true,
    sourceFilename: file,
  });
}

function collect(file) {
  const src = fs.readFileSync(file, "utf8");
  let ast;
  try {
    ast = parse(src, file);
  } catch {
    return { src, hits: [], unparsed: true };
  }
  const hits = [];
  walk(ast.program, [], (node, ancestors) => {
    if (node.type === "JSXText") {
      if (!isTranslatable(normalizeJsxText(node.value))) return;
      const parent = ancestors[ancestors.length - 1];
      // composite.mjs decides whether this text stands alone or is part of a
      // sentence split across siblings. An icon beside a label is fine; a
      // second text run, an expression, or a sibling that carries its own text
      // means the clause cannot be keyed in pieces.
      if (classifyTextNode(parent, node) === "split") {
        stats.needsTrans++;
        return;
      }
      const { component, reason } = enclosingComponent(ancestors);
      if (!component) {
        stats[reason]++;
        return;
      }
      hits.push({
        kind: "text",
        start: node.start,
        end: node.end,
        text: normalizeJsxText(node.value),
        lead: node.value.match(/^\s*/)[0],
        trail: node.value.match(/\s*$/)[0],
        component,
      });
    }
    // A clause split around named values becomes one t() call carrying them,
    // which keeps the sentence whole and reorderable. The element's children
    // are replaced as a unit, so this is collected per ELEMENT, not per text.
    if (node.type === "JSXElement" || node.type === "JSXFragment") {
      const built = buildInterpolation(node.children ?? []);
      if (built && isTranslatable(built.message.replace(/\{\{[^}]*\}\}/g, "").trim())) {
        const { component, reason } = enclosingComponent([...ancestors, node]);
        if (!component) {
          stats[reason]++;
        } else {
          const kids = node.children;
          hits.push({
            kind: "interp",
            start: kids[0].start,
            end: kids[kids.length - 1].end,
            text: built.message,
            values: built.values,
            component,
          });
        }
      }
    }

    // A clause holding an inline element becomes <Trans>, which keeps the
    // children exactly as they are and reads the numbered tags from the
    // message. No hook is needed, so this does not require a component.
    if (node.type === "JSXElement" || node.type === "JSXFragment") {
      const trans = node.openingElement?.name?.name === "Trans" ? null : buildTrans(node.children ?? []);
      if (trans && isTranslatable(trans.message.replace(/<\/?\d+>/g, " ").trim(), { composed: true })) {
        const kids = node.children;
        hits.push({
          kind: "trans",
          start: kids[0].start,
          end: kids[kids.length - 1].end,
          text: trans.message,
        });
      }
    }

    if (node.type === "JSXAttribute" && node.name?.name && node.value?.type === "StringLiteral") {
      const attr = node.name.name;
      const owner = ancestors[ancestors.length - 2]; // JSXOpeningElement -> JSXElement
      const allowed = UI_ATTRS.has(attr) || (DOM_ONLY_ATTRS.has(attr) && isDomElement(owner));
      if (!allowed) return;
      if (!isTranslatable(node.value.value)) return;
      const { component, reason } = enclosingComponent(ancestors);
      if (!component) {
        stats[reason]++;
        return;
      }
      hits.push({ kind: "attr", start: node.value.start, end: node.value.end, text: node.value.value, component });
    }
  });
  return { src, hits };
}

/** Adds Trans to the @/i18n import, or creates it. */
function ensureTransImport(src) {
  if (/import\s*\{[^}]*\bTrans\b[^}]*\}\s*from\s*"@\/i18n"/.test(src)) return src;
  if (/from\s+"@\/i18n"/.test(src)) {
    return src.replace(/import\s*\{([^}]*)\}\s*from\s*"@\/i18n"/, (m, inner) => `import {${inner.trimEnd()}, Trans } from "@/i18n"`);
  }
  const imports = [...src.matchAll(/^import [^\n]*?;$/gm)];
  const last = imports[imports.length - 1];
  if (!last) return `import { Trans } from "@/i18n";\n` + src;
  const at = last.index + last[0].length;
  return src.slice(0, at) + `\nimport { Trans } from "@/i18n";` + src.slice(at);
}

function ensureImport(src) {
  if (/import\s*{[^}]*\buseTranslation\b[^}]*}\s*from\s*"@\/i18n"/.test(src)) return src;
  if (/from\s+"@\/i18n"/.test(src)) {
    return src.replace(/import\s*{([^}]*)}\s*from\s*"@\/i18n"/, (m, inner) => `import {${inner.trimEnd()}, useTranslation } from "@/i18n"`);
  }
  const imports = [...src.matchAll(/^import [^\n]*?;$/gm)];
  const last = imports[imports.length - 1];
  if (!last) return `import { useTranslation } from "@/i18n";\n` + src;
  const at = last.index + last[0].length;
  return src.slice(0, at) + `\nimport { useTranslation } from "@/i18n";` + src.slice(at);
}

const setDeep = (obj, keys, value) => {
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  const leaf = keys[keys.length - 1];
  if (!(leaf in cur)) cur[leaf] = value;
};
const getDeep = (obj, keys) => {
  let cur = obj;
  for (const k of keys) {
    if (typeof cur !== "object" || cur === null || !(k in cur)) return undefined;
    cur = cur[k];
  }
  return cur;
};

// ---- main ---------------------------------------------------------------

const files = [];
const fileArg = opt("file");
if (fileArg) files.push(fileArg);
else {
  const walkDir = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walkDir(p);
      else if (
        e.name.endsWith(".tsx") &&
        !e.name.includes(".test.") &&
        !e.name.includes(".stories.") &&
        !isExcludedFile(path.relative(path.join(UI_ROOT, "src"), p))
      ) {
        files.push(p);
      }
    }
  };
  walkDir(opt("dir", path.join(UI_ROOT, "src")));
}
files.sort();

const en = JSON.parse(fs.readFileSync(EN, "utf8"));
const added = [];

for (const file of files) {
  stats.files++;
  if (LIMIT && stats.changed >= LIMIT) continue;
  let { src, hits } = collect(file);
  if (!hits.length) continue;
  stats.withStrings++;

  const ns = namespaceFor(file);
  hits.sort((a, b) => b.start - a.start);

  const used = new Map();
  const edits = [];
  for (const hit of hits) {
    const base = slugKey(
      hit.kind === "interp"
        ? hit.text.replace(/\{\{[^}]*\}\}/g, " ")
        : hit.kind === "trans"
          ? hit.text.replace(/<\/?\d+>/g, " ")
          : hit.text,
    );
    let key = base;
    let n = 2;
    while (used.has(key) && used.get(key) !== hit.text) key = `${base}${n++}`;
    const full = [...ns, key];
    const existing = getDeep(en, full);
    if (existing !== undefined && existing !== hit.text) continue;
    used.set(key, hit.text);
    if (existing === undefined) {
      setDeep(en, full, hit.text);
      added.push({ key: full.join("."), text: hit.text });
    }
    const call = `t("${full.join(".")}")`;
    let replacement;
    if (hit.kind === "text") replacement = `${hit.lead}{${call}}${hit.trail}`;
    else if (hit.kind === "interp") {
      // Shorthand when the name already is the expression, e.g. { provider };
      // otherwise spell it out, e.g. { displayName: user.displayName }.
      const entries = hit.values.map(({ name, expression }) => {
        const source = src.slice(expression.start, expression.end);
        return source === name ? name : `${name}: ${source}`;
      });
      replacement = `{t("${full.join(".")}", { ${entries.join(", ")} })}`;
      stats.interpolated++;
    } else if (hit.kind === "trans") {
      const children = src.slice(hit.start, hit.end);
      replacement = `<Trans i18nKey="${full.join(".")}">${children}</Trans>`;
      stats.trans++;
    } else replacement = `{${call}}`;
    edits.push({ start: hit.start, end: hit.end, replacement });
  }
  if (!edits.length) continue;
  // An interpolation edit spans its element's whole child range, so drop any
  // edit nested inside another: applying both would corrupt the file.
  edits.sort((a, b) => b.start - a.start || a.end - b.end);
  const applied = [];
  for (const e of edits) {
    if (applied.some((k) => e.start >= k.start && e.end <= k.end)) continue;
    applied.push(e);
  }
  for (const e of applied) src = src.slice(0, e.start) + e.replacement + src.slice(e.end);

  // Re-parse the rewritten file, then insert hooks back-to-front.
  const names = new Set();
  const bodies = [];
  try {
    const ast2 = parse(src, file);
    walk(ast2.program, [], (node, ancestors) => {
      if (node.type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === "t") {
        const { component } = enclosingComponent(ancestors);
        if (component && !names.has(component.name)) {
          names.add(component.name);
          bodies.push(component.body);
        }
      }
    });
  } catch {
    continue; // rewrite broke parsing: do not write this file
  }
  bodies.sort((a, b) => b.start - a.start);
  for (const body of bodies) {
    const text = src.slice(body.start, body.end);
    if (/const\s*{\s*t\s*[,}]/.test(text)) continue;
    const indent = text.match(/\n(\s+)\S/)?.[1] ?? "  ";
    src = src.slice(0, body.start + 1) + `\n${indent}const { t } = useTranslation();` + src.slice(body.start + 1);
  }
  if (/<Trans i18nKey=/.test(src)) src = ensureTransImport(src);
  src = ensureImport(src);

  // Final gate: the file must still parse before it is written.
  try {
    parse(src, file);
  } catch {
    continue;
  }
  if (APPLY) fs.writeFileSync(file, src, "utf8");
  stats.changed++;
}

stats.keys = added.length;

if (APPLY && added.length) {
  fs.writeFileSync(EN, JSON.stringify(en, null, 2) + "\n", "utf8");
  // locale-validation treats a missing key as an error and locales.ts asserts
  // every locale at import time, so each key must exist in all of them.
  for (const f of fs.readdirSync(LOCALES_DIR)) {
    if (!f.endsWith(".json") || f === "en.json") continue;
    const p = path.join(LOCALES_DIR, f);
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    for (const { key, text } of added) setDeep(data, key.split("."), text);
    fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf8");
  }
}

console.log(`arquivos analisados:            ${stats.files}`);
console.log(`com string extraivel:           ${stats.withStrings}`);
console.log(`${APPLY ? "alterados" : "alteraveis"}:${" ".repeat(APPLY ? 23 : 22)}${stats.changed}`);
console.log(`chaves novas:                   ${stats.keys}`);
console.log(`  das quais com interpolacao:   ${stats.interpolated}`);
console.log(`  das quais com <Trans>:        ${stats.trans}`);
console.log(`recusados — exige <Trans>:      ${stats.needsTrans}`);
console.log(`recusados — fora de componente: ${stats.noComponent}`);
console.log(`recusados — corpo sem bloco:    ${stats.exprBody}`);
if (!APPLY) console.log("\n(dry-run — use --apply para escrever)");

export { normalizeJsxText };
