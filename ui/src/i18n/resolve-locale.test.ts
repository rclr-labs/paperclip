import { describe, expect, it } from "vitest";
import { matchLocale, resolveLocale } from "./resolve-locale";

const SUPPORTED = ["en", "es", "pt-BR", "pt-PT", "zh-CN"];

describe("matchLocale", () => {
  it("prefers an exact match regardless of case", () => {
    expect(matchLocale(["PT-br"], SUPPORTED)).toBe("pt-BR");
  });

  it("falls back to the first shipped locale sharing the base language", () => {
    expect(matchLocale(["pt"], SUPPORTED)).toBe("pt-BR");
  });

  it("resolves an unshipped region to the same base language", () => {
    expect(matchLocale(["pt-AO"], SUPPORTED)).toBe("pt-BR");
  });

  it("walks the preference order instead of stopping at the first miss", () => {
    expect(matchLocale(["ja", "ko", "es"], SUPPORTED)).toBe("es");
  });

  it("returns null when nothing matches", () => {
    expect(matchLocale(["ja", "ko"], SUPPORTED)).toBeNull();
  });
});

describe("resolveLocale", () => {
  it("lets an explicit stored choice outrank the browser", () => {
    expect(resolveLocale({ stored: "es", preferred: ["pt-BR"], supported: SUPPORTED })).toBe("es");
  });

  it("ignores a stored locale that is no longer shipped", () => {
    expect(resolveLocale({ stored: "xx-YY", preferred: ["pt-BR"], supported: SUPPORTED })).toBe("pt-BR");
  });

  it("falls back to the default locale when nothing matches", () => {
    expect(resolveLocale({ stored: null, preferred: ["ja"], supported: SUPPORTED })).toBe("en");
  });

  it("falls back to the default locale when the browser reports nothing", () => {
    expect(resolveLocale({ stored: null, preferred: [], supported: SUPPORTED })).toBe("en");
  });
});
