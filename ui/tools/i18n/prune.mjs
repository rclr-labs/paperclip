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
import { isTranslatable } from "./translatable.mjs";

const UI_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const LOCALES_DIR = path.join(UI_ROOT, "src/i18n/locales");
const APPLY = process.argv.includes("--apply");

const en = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, "en.json"), "utf8"));

const bad = new Map();
(function walk(node, prefix) {
  for (const [key, value] of Object.entries(node)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object") walk(value, full);
    else if (!isTranslatable(value)) bad.set(full, value);
  }
})(en, "");

if (bad.size === 0) {
  console.log("nada a remover: toda chave do catalogo passa pela regra atual");
  process.exit(0);
}

const tsxFiles = [];
(function walkDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkDir(p);
    else if (entry.name.endsWith(".tsx") && !entry.name.includes(".test.")) tsxFiles.push(p);
  }
})(path.join(UI_ROOT, "src"));

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
    // diff at all against the pre-extraction source. Values carrying a quote
    // or a newline fall back to the brace form, which is always valid.
    const plain = !value.includes('"') && !value.includes("\n");
    src = src.replace(attr, () => {
      restored++;
      return plain ? `="${value}"` : `={${literal}}`;
    });
    src = src.replace(child, () => {
      restored++;
      return plain ? value : `{${literal}}`;
    });
  }
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

console.log(`chaves removidas:      ${bad.size}`);
console.log(`literais restaurados:  ${restored} em ${touchedFiles} arquivos`);
if (!APPLY) console.log("\n(dry-run — use --apply para escrever)");
