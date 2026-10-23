import { DEFAULT_LOCALE } from "./locales";

export const LOCALE_STORAGE_KEY = "paperclip.locale";

/**
 * Locale resolution is split from the browser so it can be tested as data.
 * `preferred` is the ordered list the user's browser reports; `supported` is
 * what we actually ship. Both arrive as plain arrays — no window required.
 */
export function matchLocale(preferred: readonly string[], supported: readonly string[]) {
  const byExact = new Map(supported.map((locale) => [locale.toLowerCase(), locale]));
  const byBase = new Map<string, string>();
  // First locale wins per base language, so the shipped order decides whether
  // "pt" resolves to pt-BR or pt-PT rather than the browser's spelling.
  for (const locale of supported) {
    const base = locale.toLowerCase().split("-")[0];
    if (!byBase.has(base)) byBase.set(base, locale);
  }

  for (const candidate of preferred) {
    const normalized = candidate.toLowerCase();
    const exact = byExact.get(normalized);
    if (exact) return exact;
    const base = byBase.get(normalized.split("-")[0]);
    if (base) return base;
  }
  return null;
}

export function resolveLocale(options: {
  stored?: string | null;
  preferred?: readonly string[];
  supported: readonly string[];
}) {
  const { stored, preferred = [], supported } = options;
  // An explicit choice outranks the browser; it is the only signal the user
  // made on purpose.
  if (stored && supported.includes(stored)) return stored;
  return matchLocale(preferred, supported) ?? DEFAULT_LOCALE;
}

function safeReadStoredLocale() {
  // Storage throws in private-mode and embedded contexts; a locale is never
  // worth failing app startup over.
  try {
    return globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function persistLocale(locale: string) {
  try {
    globalThis.localStorage?.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Non-fatal: the choice applies to this session and is re-detected next load.
  }
}

export function detectLocale(supported: readonly string[]) {
  const navigatorLocales = globalThis.navigator?.languages ?? [];
  const navigatorLocale = globalThis.navigator?.language;
  const preferred = navigatorLocales.length > 0 ? navigatorLocales : navigatorLocale ? [navigatorLocale] : [];
  return resolveLocale({ stored: safeReadStoredLocale(), preferred, supported });
}
