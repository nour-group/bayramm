import { hasNonCanonicalApostrophe, LANGS, normalizeUz } from "@bayramm/shared";
import { describe, expect, it } from "vitest";
import { LANG_NAMES, vendorDict } from "./i18n";
import { NAV, ROUTES, type Route } from "./router";

const entries = (lang: keyof typeof vendorDict) => Object.entries(vendorDict[lang]);

describe("словарь кабинета вендора", () => {
  it("одинаковые ключи в одном порядке", () => {
    expect(Object.keys(vendorDict.uz)).toEqual(Object.keys(vendorDict.ru));
  });

  it("у каждого раздела есть название и пояснение", () => {
    for (const lang of LANGS)
      for (const route of Object.keys(ROUTES) as Route[]) {
        expect(vendorDict[lang][route], `${lang}.${route}`).toBeTruthy();
        expect(vendorDict[lang][`${route}Lead`], `${lang}.${route}Lead`).toBeTruthy();
      }
    expect(NAV.every((route) => route in ROUTES)).toBe(true);
  });

  it("нет пустых строк и HTML", () => {
    for (const lang of LANGS)
      for (const [key, text] of entries(lang)) {
        expect(text.trim(), `${lang}.${key}`).not.toBe("");
        expect(text, `${lang}.${key}`).not.toMatch(/<\/?[a-z][^>]*>|&[a-z#][a-z0-9]*;/i);
      }
  });

  it("«заявка, не бронь»: запрещённых слов нет", () => {
    const forbidden = { ru: [/брон/i], uz: [/bron/i, /band\s+qil/i] } as const;
    for (const lang of LANGS)
      for (const [key, text] of entries(lang))
        for (const re of forbidden[lang]) expect(text, `${lang}.${key}`).not.toMatch(re);
  });

  it("узбекский: латиница и только канонические апострофы", () => {
    const texts: [string, string][] = [...entries("uz"), ["LANG_NAMES.uz", LANG_NAMES.uz]];
    for (const [key, text] of texts) {
      expect(text, key).not.toMatch(/[Ѐ-ӿ]/);
      expect(hasNonCanonicalApostrophe(text), key).toBe(false);
      expect(normalizeUz(text), key).toBe(text);
    }
  });
});
