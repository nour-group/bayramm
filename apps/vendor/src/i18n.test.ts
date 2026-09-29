import { hasNonCanonicalApostrophe, LANGS, normalizeUz } from "@bayramm/shared";
import { DECLINE_REASONS } from "@bayramm/shared/api/vendor";
import { describe, expect, it } from "vitest";
import { fill, LANG_NAMES, textOf, vendorDict } from "./i18n";
import { NAV } from "./router";

/** Все строки словаря: у массивов — каждый элемент */
const texts = (lang: keyof typeof vendorDict): [string, string][] =>
  Object.entries(vendorDict[lang]).flatMap(([key, value]): [string, string][] =>
    typeof value === "string"
      ? [[key, value]]
      : value.map((item, i): [string, string] => [`${key}[${i}]`, item]),
  );

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(([, name]) => name).sort();

// Коды, из которых экраны собирают ключи (st_ + статус и т. д.): у каждого — текст
const CODES = {
  st: ["new", "viewed", "contacted", "deal", "declined", "withdrawn", "expired"],
  reason: DECLINE_REASONS,
  by: ["client", "vendor_user", "staff", "system"],
  ls: ["lead", "draft", "review", "active", "suspended", "rejected"],
  // app.listing_publish_blockers
  blocker: [
    "price",
    "capacity",
    "district",
    "descriptions",
    "phone",
    "packages",
    "photos",
    "contract",
    "stir",
    "contacts",
    "pd_consent",
  ],
  // справочники из миграции foundation
  occ: ["toy", "beshik", "bd", "corp", "small"],
  dist: [
    "yunusobod",
    "mirzo_ulugbek",
    "chilonzor",
    "yakkasaroy",
    "shayxontohur",
    "mirobod",
    "sergeli",
    "uchtepa",
    "olmazor",
    "yashnobod",
    "bektemir",
    "yangihayot",
  ],
} as const;

describe("словарь кабинета вендора", () => {
  it("одинаковые ключи в одном порядке", () => {
    expect(Object.keys(vendorDict.uz)).toEqual(Object.keys(vendorDict.ru));
  });

  it("у каждого раздела нижней панели есть название", () => {
    for (const lang of LANGS) for (const section of NAV) expect(vendorDict[lang][section]).toBeTruthy();
  });

  it("у каждого кода из API есть текст на обоих языках", () => {
    for (const lang of LANGS)
      for (const [prefix, codes] of Object.entries(CODES))
        for (const code of codes) {
          expect(textOf(vendorDict[lang], `${prefix}_${code}`), `${lang}.${prefix}_${code}`).not.toBe(
            `${prefix}_${code}`,
          );
        }
  });

  it("недели, месяцы — полные списки", () => {
    for (const lang of LANGS) {
      expect(vendorDict[lang].weekdays).toHaveLength(7);
      expect(vendorDict[lang].months).toHaveLength(12);
      expect(vendorDict[lang].monthsOf).toHaveLength(12);
    }
  });

  it("нет пустых строк и HTML", () => {
    for (const lang of LANGS)
      for (const [key, text] of texts(lang)) {
        expect(text.trim(), `${lang}.${key}`).not.toBe("");
        expect(text, `${lang}.${key}`).not.toMatch(/<\/?[a-z][^>]*>|&[a-z#][a-z0-9]*;/i);
      }
  });

  it("подстановки в обоих языках одни и те же", () => {
    const uz = new Map(texts("uz"));
    for (const [key, text] of texts("ru"))
      expect(placeholders(uz.get(key) ?? ""), key).toEqual(placeholders(text));
  });

  it("«заявка, не бронь»: запрещённых слов нет", () => {
    const forbidden = { ru: [/брон/i], uz: [/bron/i, /band\s+qil/i] } as const;
    for (const lang of LANGS)
      for (const [key, text] of texts(lang))
        for (const re of forbidden[lang]) expect(text, `${lang}.${key}`).not.toMatch(re);
  });

  it("клиент не платит: ни комиссий, ни оплаты", () => {
    for (const [key, text] of texts("ru")) expect(text, key).not.toMatch(/комисси|оплат/i);
    for (const [key, text] of texts("uz")) expect(text, key).not.toMatch(/komissiya|toʻlov/i);
  });

  it("узбекский: латиница и только канонические апострофы", () => {
    const all: [string, string][] = [...texts("uz"), ["LANG_NAMES.uz", LANG_NAMES.uz]];
    for (const [key, text] of all) {
      expect(text, key).not.toMatch(/[Ѐ-ӿ]/);
      expect(hasNonCanonicalApostrophe(text), key).toBe(false);
      expect(normalizeUz(text), key).toBe(text);
    }
  });

  it("fill подставляет значения, неизвестное оставляет как есть", () => {
    expect(fill("{n} из {m}", { n: 1, m: "2" })).toBe("1 из 2");
    expect(fill("{n} и {x}", { n: 1 })).toBe("1 и {x}");
  });
});
