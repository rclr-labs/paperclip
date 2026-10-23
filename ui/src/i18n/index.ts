import i18n, { type InitOptions, type TOptions } from "i18next";
import { initReactI18next, useTranslation as useReactI18nextTranslation } from "react-i18next";

import { DEFAULT_LOCALE, i18nextResources, loadLocaleMessages, supportedLocales } from "./locales";
import { detectLocale, persistLocale } from "./resolve-locale";

const i18nextOptions: InitOptions = {
  resources: i18nextResources,
  lng: DEFAULT_LOCALE,
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: supportedLocales,
  defaultNS: "translation",
  interpolation: { escapeValue: false },
  returnObjects: false,
  initAsync: false,
};

/**
 * Init synchronously with English so the first render never waits on a network
 * chunk, then swap in the reader's locale as soon as its chunk resolves. The
 * swap is a no-op when English is what they wanted.
 */
void i18n
  .use(initReactI18next)
  .init(i18nextOptions)
  .then(() => applyLocale(detectLocale(supportedLocales)))
  .catch((error: unknown) => {
    console.error("Failed to initialize i18next", error);
  });

async function applyLocale(locale: string) {
  if (locale === DEFAULT_LOCALE) return;
  const messages = await loadLocaleMessages(locale);
  if (!messages) return;
  i18n.addResourceBundle(locale, "translation", messages, true, true);
  await i18n.changeLanguage(locale);
}

/**
 * Changing the language is a user decision, so it is persisted — the browser's
 * preference is only consulted when the user has not chosen.
 */
export async function setLocale(locale: string) {
  if (!supportedLocales.includes(locale)) {
    throw new Error(`Unsupported locale: ${locale}`);
  }
  persistLocale(locale);
  await applyLocale(locale);
  if (locale === DEFAULT_LOCALE) await i18n.changeLanguage(locale);
}

export function currentLocale() {
  return i18n.resolvedLanguage ?? i18n.language ?? DEFAULT_LOCALE;
}

export function t(key: string, options: TOptions = {}) {
  return i18n.t(key, options);
}

export const useTranslation = useReactI18nextTranslation;
export { i18n };
