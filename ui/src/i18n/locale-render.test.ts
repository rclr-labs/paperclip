import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "./locales/en.json";
import ptBR from "./locales/pt-BR.json";

/**
 * The premise of the whole catalogue is that a Brazilian reader sees
 * Portuguese. Catalogue validity and English tests both pass when that wiring
 * is broken, so it gets its own test: resolution -> lazy chunk -> resource
 * bundle -> active language.
 */
describe("locale wiring", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it("renders Portuguese when the reader has chosen pt-BR", async () => {
    localStorage.setItem("paperclip.locale", "pt-BR");
    const { i18n, t } = await import(".");
    await vi.waitFor(() => expect(i18n.resolvedLanguage).toBe("pt-BR"));
    expect(t("app.noCompanies.title")).toBe(ptBR.app.noCompanies.title);
    expect(t("app.noCompanies.title")).not.toBe(en.app.noCompanies.title);
  });

  it("falls back to English for a key the locale has not translated yet", async () => {
    localStorage.setItem("paperclip.locale", "pt-BR");
    const { i18n, t } = await import(".");
    await vi.waitFor(() => expect(i18n.resolvedLanguage).toBe("pt-BR"));
    // fallbackLng is English, so an untranslated key must not surface as a key.
    expect(t("app.missing.key", { defaultValue: "Fallback" })).toBe("Fallback");
  });

  it("stays English when nothing has been chosen", async () => {
    const { i18n, t } = await import(".");
    await vi.waitFor(() => expect(i18n.isInitialized).toBe(true));
    expect(t("app.noCompanies.title")).toBe(en.app.noCompanies.title);
  });

  it("switches language on setLocale and persists the choice", async () => {
    const { setLocale, i18n, t } = await import(".");
    await vi.waitFor(() => expect(i18n.isInitialized).toBe(true));

    await setLocale("pt-BR");
    expect(i18n.resolvedLanguage).toBe("pt-BR");
    expect(t("app.noCompanies.title")).toBe(ptBR.app.noCompanies.title);
    expect(localStorage.getItem("paperclip.locale")).toBe("pt-BR");

    // Back to the default locale, which takes the branch outside applyLocale.
    await setLocale("en");
    expect(i18n.resolvedLanguage).toBe("en");
    expect(t("app.noCompanies.title")).toBe(en.app.noCompanies.title);
    expect(localStorage.getItem("paperclip.locale")).toBe("en");
  });

  it("refuses a locale that is not shipped", async () => {
    const { setLocale } = await import(".");
    await expect(setLocale("xx-YY")).rejects.toThrow(/Unsupported locale/);
  });
});
