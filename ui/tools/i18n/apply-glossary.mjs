#!/usr/bin/env node
/**
 * Applies a translation glossary to a locale file.
 *
 * The glossary maps the English SOURCE STRING to its translation, not the key,
 * because the same label is reached by many keys ("Cancel" appears 50 times).
 * Translating the string once and matching by value is both less work and more
 * consistent than translating key by key.
 *
 * Usage:
 *   node tools/i18n/apply-glossary.mjs --locale pt-BR [--check]
 */
import fs from "node:fs";
import path from "node:path";

// Resolved from this file so the tool works from any cwd.
const UI_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const LOCALES_DIR = path.join(UI_ROOT, "src/i18n/locales");
const args = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const LOCALE = opt("locale", "pt-BR");
const CHECK = args.includes("--check");

const en = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, "en.json"), "utf8"));
const targetPath = path.join(LOCALES_DIR, `${LOCALE}.json`);
const target = JSON.parse(fs.readFileSync(targetPath, "utf8"));
const glossaryPath = path.join(UI_ROOT, `tools/i18n/glossary.${LOCALE}.json`);
const glossary = fs.existsSync(glossaryPath) ? JSON.parse(fs.readFileSync(glossaryPath, "utf8")) : {};

const placeholders = (s) => Array.from(s.matchAll(/{{\s*([A-Za-z0-9_.-]+)\s*}}/g), (m) => m[1]).sort().join(",");

let applied = 0;
let untranslated = 0;
const problems = [];

function walkBoth(enNode, targetNode, pathKeys) {
  for (const [key, value] of Object.entries(enNode)) {
    if (value && typeof value === "object") {
      if (!targetNode[key] || typeof targetNode[key] !== "object") targetNode[key] = {};
      walkBoth(value, targetNode[key], [...pathKeys, key]);
      continue;
    }
    const translation = glossary[value];
    if (translation === undefined) {
      if (targetNode[key] === value) untranslated++;
      continue;
    }
    if (placeholders(translation) !== placeholders(value)) {
      problems.push(`${[...pathKeys, key].join(".")}: placeholders differ (en "${value}" vs "${translation}")`);
      continue;
    }
    const limit = Math.min(2000, Math.max(value.length * 4 + 64, value.length + 128));
    if (translation.length > limit) {
      problems.push(`${[...pathKeys, key].join(".")}: translation too long (${translation.length} > ${limit})`);
      continue;
    }
    if (targetNode[key] !== translation) {
      targetNode[key] = translation;
      applied++;
    }
  }
}

walkBoth(en, target, []);

if (problems.length) {
  console.error(`problemas: ${problems.length}`);
  for (const p of problems.slice(0, 20)) console.error("  -", p);
  process.exit(1);
}

if (!CHECK) fs.writeFileSync(targetPath, JSON.stringify(target, null, 2) + "\n", "utf8");

const totalKeys = (function count(o) {
  return Object.values(o).reduce((n, v) => n + (v && typeof v === "object" ? count(v) : 1), 0);
})(en);

console.log(`locale:            ${LOCALE}`);
console.log(`glossario:         ${Object.keys(glossary).length} textos`);
console.log(`chaves aplicadas:  ${applied}`);
console.log(`ainda em ingles:   ${untranslated} de ${totalKeys} (${((totalKeys - untranslated) / totalKeys * 100).toFixed(0)}% traduzido)`);
if (CHECK) console.log("(--check: nada escrito)");
