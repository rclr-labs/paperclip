#!/usr/bin/env node
/**
 * Removes catalogue keys that no source file references.
 *
 * Keys go dead when a component is reverted, deleted, or rewritten while its
 * entries stay behind in all 40 locale files. Nobody notices, because a key
 * nothing calls produces no visible bug — it just makes every translator do
 * work for a string no reader will ever see.
 *
 * Conservative: a key survives if its full dotted name appears anywhere in the
 * source at all, in any form. Only keys with zero textual references go.
 *
 * Usage: node ui/tools/i18n/sweep-dead-keys.mjs [--apply]
 */
import fs from "node:fs";
import path from "node:path";

const UI_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const LOCALES_DIR = path.join(UI_ROOT, "src/i18n/locales");
const APPLY = process.argv.includes("--apply");

const en = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, "en.json"), "utf8"));

const keys = [];
(function walk(node, prefix) {
  for (const [key, value] of Object.entries(node)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object") walk(value, full);
    else keys.push(full);
  }
})(en, "");

// One pass over the source, then substring checks against that blob.
const sources = [];
(function walkDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkDir(p);
    else if (/\.(tsx?|mts|mjs)$/.test(entry.name)) sources.push(p);
  }
})(path.join(UI_ROOT, "src"));
const blob = sources.map((f) => fs.readFileSync(f, "utf8")).join("\n");

const dead = keys.filter((key) => !blob.includes(key));

function deleteDeep(obj, parts) {
  const [head, ...rest] = parts;
  if (rest.length === 0) {
    delete obj[head];
    return;
  }
  if (typeof obj[head] !== "object" || obj[head] === null) return;
  deleteDeep(obj[head], rest);
  if (Object.keys(obj[head]).length === 0) delete obj[head];
}

if (APPLY && dead.length > 0) {
  for (const f of fs.readdirSync(LOCALES_DIR)) {
    if (!f.endsWith(".json")) continue;
    const p = path.join(LOCALES_DIR, f);
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    for (const key of dead) deleteDeep(data, key.split("."));
    fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf8");
  }
}

console.log(`chaves no catalogo:     ${keys.length}`);
console.log(`sem referencia alguma:  ${dead.length}`);
for (const key of dead.slice(0, 12)) console.log(`  ${key}`);
if (dead.length > 12) console.log(`  … e mais ${dead.length - 12}`);
if (!APPLY) console.log("\n(dry-run — use --apply para escrever)");
