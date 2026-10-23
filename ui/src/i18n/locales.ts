import type { Resource } from "i18next";

import en from "./locales/en.json";

export const DEFAULT_LOCALE = "en" as const;

/**
 * Only English is bundled eagerly. It is the fallback for every other locale,
 * so it is always needed — and it is the one catalogue that must never arrive
 * late.
 *
 * The rest load on demand. An eager glob over 40 locales was free while the
 * catalogue held three strings; at thousands it costs seconds per module-graph
 * load and ships every language to every reader. A lazy glob lets Vite emit one
 * chunk per locale, fetched only when that locale is actually selected.
 */
const localeLoaders = import.meta.glob("./locales/*.json", {
  import: "default",
}) as Record<string, () => Promise<unknown>>;

function localeFromPath(path: string) {
  const locale = path.match(/\/([A-Za-z0-9_-]+)\.json$/)?.[1];
  if (!locale) throw new Error(`Invalid locale file path: ${path}`);
  return locale;
}

const loaderByLocale = new Map(
  Object.entries(localeLoaders).map(([path, load]) => [localeFromPath(path), load]),
);

export const supportedLocales = [...loaderByLocale.keys()];

if (!loaderByLocale.has(DEFAULT_LOCALE)) {
  throw new Error(`Missing default locale messages for ${DEFAULT_LOCALE}`);
}

export const defaultLocaleMessages = en;

export const i18nextResources: Resource = {
  [DEFAULT_LOCALE]: { translation: en },
};

/** Loads one locale's messages, or the English fallback if it is unknown. */
export async function loadLocaleMessages(locale: string) {
  const load = loaderByLocale.get(locale);
  if (!load) return null;
  return (await load()) as Record<string, unknown>;
}

/** Every locale, for validation in tests and build checks — never at runtime. */
export async function loadAllLocaleMessages() {
  const entries = await Promise.all(
    [...loaderByLocale.entries()].map(async ([locale, load]) => [locale, await load()] as const),
  );
  return Object.fromEntries(entries) as Record<string, unknown>;
}

export type SupportedLocale = string;
