import en from "./locales/en.json";

function lookup(key: string): string | undefined {
  let node: unknown = en;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null || !(part in node)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

/**
 * Rewrites `t("some.key")` back to the English copy it resolves to.
 *
 * Source-contract tests assert that specific user-facing wording lives in a
 * specific flow — a contract about copy, not about plumbing. Once that copy
 * moves into the catalogue the literal leaves the component, and the contract
 * would read as broken while the promise it protects is intact. Resolving the
 * call sites restores what a reader of the rendered page sees, so those tests
 * keep testing the thing they were written to protect.
 *
 * An unknown key is left untouched: a contract asserting copy that no longer
 * resolves should fail, not quietly pass.
 */
export function resolveCatalogueCopy(source: string) {
  const call = String.raw`t\(\s*"([^"]+)"\s*\)`;
  return source
    // JSX attribute: placeholder={t("k")} -> placeholder="value"
    .replace(new RegExp(String.raw`=\{\s*${call}\s*\}`, "g"), (match, key: string) => {
      const value = lookup(key);
      return value === undefined ? match : `="${value}"`;
    })
    // JSX child: {t("k")} -> value
    .replace(new RegExp(String.raw`\{\s*${call}\s*\}`, "g"), (match, key: string) => {
      const value = lookup(key);
      return value === undefined ? match : value;
    })
    // Bare call in an expression position.
    .replace(new RegExp(call, "g"), (match, key: string) => lookup(key) ?? match);
}
