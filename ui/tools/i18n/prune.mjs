#!/usr/bin/env node
/**
 * Removes catalogue entries that should never have been extracted, and puts
 * the literal back in the component.
 *
 * The rule that decides is the tool's own `isTranslatable`, so the catalogue
 * and the extractor cannot disagree: anything the extractor would refuse today
 * is pruned, whatever an earlier, looser version of the rule let through.
 *
 * Restores as a JSX string expression — {"text"} / ={"text"} — which is always
 * valid regardless of quotes in the value and renders identically.
 *
 * Usage: node ui/tools/i18n/prune.mjs [--apply]
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { isTranslatable } from "./translatable.mjs";
import { isExcludedKey } from "./excluded.mjs";

const require_ = createRequire(import.meta.url);
function loadParser() {
  try {
    return require_("@babel/parser");
  } catch {}
  const base = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../node_modules/.pnpm");
  const dir = fs.readdirSync(base).find((d) => d.startsWith("@babel+parser@"));
  if (!dir) throw new Error("@babel/parser not found; run pnpm install");
  return require_(path.resolve(base, dir, "node_modules/@babel/parser"));
}
const parser = loadParser();

/**
 * Removes the hook and import a pruned file no longer needs.
 *
 * Restoring a literal without removing the `const { t } = useTranslation()`
 * that served it leaves an unused binding and an unused import — which
 * noUnusedLocals and lint both reject, and which is why a fully pruned file
 * otherwise keeps a two-line diff forever.
 */
function tidyOrphans(src) {
  let out = src;
  // Drop a hook line from any component that no longer calls t(.
  const lines = out.split("\n");
  const keep = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*const \{ t \} = useTranslation\(\);\s*$/.test(lines[i])) {
      keep.push(lines[i]);
      continue;
    }
    // Look ahead to the end of this component body for a t( call.
    let depth = 0;
    let usesT = false;
    for (let j = i + 1; j < lines.length; j++) {
      if (/\bt\(/.test(lines[j])) { usesT = true; break; }
      depth += (lines[j].match(/\{/g) ?? []).length - (lines[j].match(/\}/g) ?? []).length;
      if (depth < 0) break; // left the component
    }
    if (usesT) keep.push(lines[i]);
  }
  out = keep.join("\n");
  // Drop the import when nothing in the file calls t( or uses the hook.
  if (!/\bt\(/.test(out) && !/useTranslation\(/.test(out)) {
    out = out
      .replace(/^import \{ useTranslation \} from "@\/i18n";\n/m, "")
      .replace(/import \{([^}]*?),\s*useTranslation \} from "@\/i18n"/, 'import {$1} from "@/i18n"');
  }
  try {
    parser.parse(out, { sourceType: "module", plugins: ["typescript", "jsx"] });
  } catch {
    return src; // never write something that stopped parsing
  }
  return out;
}

const UI_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const LOCALES_DIR = path.join(UI_ROOT, "src/i18n/locales");
const APPLY = process.argv.includes("--apply");

const withoutPlaceholders = (value) => value.replace(/\{\{[^}]*\}\}/g, "x");

const en = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, "en.json"), "utf8"));

const bad = new Map();
(function walk(node, prefix) {
  for (const [key, value] of Object.entries(node)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object") walk(value, full);
    // Two reasons to prune: the string is not copy, or it came from a surface
    // that should never have been extracted at all.
    //
    // Placeholders are stripped before the copy test. `isTranslatable` refuses
    // a SOURCE string containing {{...}} — a component should not hand the
    // catalogue something already interpolated — but a catalogue VALUE carries
    // them by design, and testing the raw value would condemn every
    // interpolated message the extractor just wrote.
    else if (!isTranslatable(withoutPlaceholders(value), { composed: value.includes("{{") }) || isExcludedKey(full)) bad.set(full, value);
  }
})(en, "");

// No early exit: the tidy pass below still has work when a previous run
// removed keys but left the hook and import it served behind.
const nothingToPrune = bad.size === 0;

const tsxFiles = [];
(function walkDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkDir(p);
    else if (entry.name.endsWith(".tsx") && !entry.name.includes(".test.")) tsxFiles.push(p);
  }
})(path.join(UI_ROOT, "src"));

// A key is only safe to prune if every call site could be rewritten back to a
// literal. `t("k", { count })` cannot be — there is nowhere for the value to
// go — so pruning it would leave a call pointing at a key that no longer
// exists, which renders as the key itself and no test would notice.
const orphans = [];
for (const file of tsxFiles) {
  const text = fs.readFileSync(file, "utf8");
  for (const key of bad.keys()) {
    const call = new RegExp(`\\bt\\(\\s*"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "g");
    for (const match of text.matchAll(call)) {
      const after = text.slice(match.index + match[0].length).trimStart();
      if (!after.startsWith(")")) orphans.push(`${path.relative(UI_ROOT, file)}: ${key}`);
    }
  }
}
if (orphans.length > 0) {
  console.error(`ABORTADO: ${orphans.length} chamada(s) t() com argumentos que o prune nao sabe restaurar.`);
  console.error("Remover essas chaves deixaria a chamada apontando para chave inexistente.");
  for (const o of orphans.slice(0, 8)) console.error("  " + o);
  process.exit(1);
}

let touchedFiles = 0;
let restored = 0;
for (const file of tsxFiles) {
  let src = fs.readFileSync(file, "utf8");
  const before = src;
  for (const [key, value] of bad) {
    const call = `t\\(\\s*"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*\\)`;
    const literal = JSON.stringify(value);
    const attr = new RegExp(`=\\{\\s*${call}\\s*\\}`, "g");
    const child = new RegExp(`\\{\\s*${call}\\s*\\}`, "g");
    // Restore the plain form when the value allows it, so pruning leaves no
    // diff at all against the pre-extraction source.
    //
    // Raw JSX text cannot carry < > { }: Babel DECODES entities when it reads
    // JSXText, so a source that wrote `&lt;timestamp&gt;` reaches the catalogue
    // as `<timestamp>`, and writing that back raw makes the parser look for a
    // closing tag. Children re-encode those characters; attributes, which also
    // cannot carry a quote, fall back to the always-valid brace form.
    const jsxEntities = (text) =>
      text
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\{/g, "&#123;")
        .replace(/\}/g, "&#125;")
        .replace(/"/g, "&quot;");
    const plainAttr = !/["\n<>{}]/.test(value);
    src = src.replace(attr, () => {
      restored++;
      return plainAttr ? `="${value}"` : `={${literal}}`;
    });
    src = src.replace(child, () => {
      restored++;
      return value.includes("\n") ? `{${literal}}` : jsxEntities(value);
    });
  }
  src = tidyOrphans(src);
  if (src !== before) {
    touchedFiles++;
    if (APPLY) fs.writeFileSync(file, src, "utf8");
  }
}

function deleteDeep(obj, keys) {
  const [head, ...rest] = keys;
  if (rest.length === 0) {
    delete obj[head];
    return;
  }
  if (typeof obj[head] !== "object" || obj[head] === null) return;
  deleteDeep(obj[head], rest);
  if (Object.keys(obj[head]).length === 0) delete obj[head];
}

if (APPLY) {
  for (const f of fs.readdirSync(LOCALES_DIR)) {
    if (!f.endsWith(".json")) continue;
    const p = path.join(LOCALES_DIR, f);
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    for (const key of bad.keys()) deleteDeep(data, key.split("."));
    fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf8");
  }
}

if (nothingToPrune) console.log("nada a remover: toda chave do catalogo passa pela regra atual");
console.log(`chaves removidas:      ${bad.size}`);
console.log(`literais restaurados:  ${restored} em ${touchedFiles} arquivos`);
if (!APPLY) console.log("\n(dry-run — use --apply para escrever)");
