import { describe, expect, it } from "vitest";
import { type Dict, dictionaries, LANGS, type Lang, ru, ruPlural, uz } from "./index";
import { hasNonCanonicalApostrophe, normalizeUz } from "./uz-apostrophe";

type AnyFn = (...args: unknown[]) => unknown;

const KEYS = Object.keys(ru) as (keyof Dict)[];

// Значения для вызова функций-ключей: числа на все формы склонения и строка
const SAMPLE_NUMBERS = [0, 1, 2, 5, 11, 21, 22, 101];
const SAMPLE_TEXT = "Bayram";

/** Весь текст значения: строки, элементы массивов, блоки, результаты функций */
function texts(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (typeof value === "function") {
    const fn = value as AnyFn;
    for (const n of SAMPLE_NUMBERS) texts(fn(...Array(fn.length).fill(n)), out);
    texts(fn(...Array(fn.length).fill(SAMPLE_TEXT)), out);
  } else if (Array.isArray(value)) for (const item of value) texts(item, out);
  else if (value && typeof value === "object")
    for (const [field, item] of Object.entries(value)) if (field !== "kind") texts(item, out);
  return out;
}

/** Вид значения: строка, функция с числом параметров, массив строк, блоки */
function shape(value: unknown): string {
  if (typeof value === "string") return "string";
  if (typeof value === "function") return `fn/${value.length}`;
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string")) return `strings/${value.length}`;
    return `blocks/${value.map((b: { kind: string; items?: unknown[] }) => b.kind + (b.items ? b.items.length : "")).join(",")}`;
  }
  return typeof value;
}

const allTexts = (lang: Lang) =>
  KEYS.flatMap((key) => texts(dictionaries[lang][key]).map((text) => ({ key, text })));

describe("словарь: паритет ru/uz", () => {
  it("одинаковый набор ключей в одном порядке", () => {
    expect(Object.keys(uz)).toEqual(Object.keys(ru));
    expect(KEYS.length).toBeGreaterThan(0);
  });

  it("у каждого ключа один вид значения; у функций одинаковое число параметров", () => {
    const mismatched = KEYS.filter((key) => shape(ru[key]) !== shape(uz[key])).map(
      (key) => `${key}: ru ${shape(ru[key])}, uz ${shape(uz[key])}`,
    );
    expect(mismatched).toEqual([]);
  });

  it("функции возвращают текст без undefined, NaN и [object …]", () => {
    for (const lang of LANGS)
      for (const { key, text } of allTexts(lang))
        expect(text, `${lang}.${key}`).not.toMatch(/undefined|NaN|\[object/);
  });

  it("тип Dict не пропускает лишний или пропущенный ключ", () => {
    // @ts-expect-error — лишний ключ
    const extra: Dict = { ...uz, extraKey: "x" };
    const { cats: _cats, ...withoutCats } = uz;
    // @ts-expect-error — пропущенный ключ
    const missing: Dict = withoutCats;
    expect(Object.keys(extra).length - Object.keys(missing).length).toBe(2);
  });
});

describe("словарь: правила продукта", () => {
  const FORBIDDEN: Record<Lang, RegExp[]> = {
    // «Заявка, не бронь»: ни «забронировать», ни «бронь», ни однокоренных; оплаченное — «Реклама»
    ru: [/брон/i, /продвижен/i],
    uz: [/bron/i, /band\s+qil/i],
  };

  for (const lang of LANGS)
    it(`${lang}: нет запрещённых слов`, () => {
      const hits = allTexts(lang).filter(({ text }) => FORBIDDEN[lang].some((re) => re.test(text)));
      expect(hits).toEqual([]);
    });

  it("оплаченный блок помечен словом «Реклама»", () => {
    expect(ru.promo).toBe("Реклама");
    expect(ru.adLabel).toBe("Реклама");
    expect(uz.promo).toBe("Reklama");
    expect(uz.adLabel).toBe("Reklama");
  });

  for (const lang of LANGS)
    it(`${lang}: нет HTML-тегов и сущностей`, () => {
      const hits = allTexts(lang).filter(({ text }) => /<\/?[a-z][^>]*>|&[a-z#][a-z0-9]*;/i.test(text));
      expect(hits).toEqual([]);
    });
});

describe("словарь: узбекский", () => {
  it("латиница, без кириллицы", () => {
    expect(allTexts("uz").filter(({ text }) => /[\u0400-\u04FF]/.test(text))).toEqual([]);
  });

  it("апострофы только U+02BB и U+02BC, текст уже нормализован", () => {
    const hits = allTexts("uz").filter(
      ({ text }) => hasNonCanonicalApostrophe(text) || normalizeUz(text) !== text,
    );
    expect(hits).toEqual([]);
  });

  it("апострофы в словаре действительно есть (нормализация не выбросила их)", () => {
    const joined = allTexts("uz")
      .map(({ text }) => text)
      .join(" ");
    expect(joined).toContain("oʻ");
    expect(joined).toContain("gʻ");
    expect(joined).toContain("maʼlumot");
  });
});

describe("normalizeUz", () => {
  it.each([
    ["O'zbekiston", "Oʻzbekiston"],
    ["g'alaba", "gʻalaba"],
    ["G‘isht", "Gʻisht"],
    ["so'm", "soʻm"],
    ["so‘m", "soʻm"],
    ["so’m", "soʻm"],
    ["so`m", "soʻm"],
    ["so´m", "soʻm"],
    ["soʼm", "soʻm"],
    ["soʻm", "soʻm"],
    ["ma'lumot", "maʼlumot"],
    ["ma’lumot", "maʼlumot"],
    ["maʻlumot", "maʼlumot"],
    ["e'lon", "eʼlon"],
    ["san'at", "sanʼat"],
    ["Ro'yxatga qo'shildi", "Roʻyxatga qoʻshildi"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeUz(input)).toBe(expected);
  });

  it("разные написания запроса дают одну строку для поиска", () => {
    const variants = ["Navro'z", "Navro‘z", "Navro’z", "Navro`z", "Navroʻz"];
    expect(new Set(variants.map(normalizeUz)).size).toBe(1);
  });

  it("повторная нормализация ничего не меняет", () => {
    const text = "Qo'ng'iroq qilgan ma'qul, so‘rov yo’q";
    expect(normalizeUz(normalizeUz(text))).toBe(normalizeUz(text));
  });

  it("не трогает кириллицу, регистр и апостроф не после буквы", () => {
    expect(normalizeUz("Ташкент")).toBe("Ташкент");
    expect(normalizeUz("'Toshkent'")).toBe("'Toshkentʼ");
    expect(normalizeUz("TOSHKENT")).toBe("TOSHKENT");
  });

  it("hasNonCanonicalApostrophe видит прямые и типографские апострофы", () => {
    expect(hasNonCanonicalApostrophe("so'm")).toBe(true);
    expect(hasNonCanonicalApostrophe("so‘m")).toBe(true);
    expect(hasNonCanonicalApostrophe("so’m")).toBe(true);
    expect(hasNonCanonicalApostrophe("soʻm maʼlumot")).toBe(false);
  });
});

describe("ruPlural", () => {
  it.each([
    [0, "дней"],
    [1, "день"],
    [2, "дня"],
    [4, "дня"],
    [5, "дней"],
    [11, "дней"],
    [12, "дней"],
    [14, "дней"],
    [21, "день"],
    [22, "дня"],
    [25, "дней"],
    [101, "день"],
    [111, "дней"],
  ])("%i %s", (n, form) => {
    expect(ruPlural(n, "день", "дня", "дней")).toBe(form);
  });

  it("склонение в словаре", () => {
    expect(ru.go(1)).toBe("Показать 1 вариант");
    expect(ru.go(3)).toBe("Показать 3 варианта");
    expect(ru.calBusyN(11)).toBe("занято 11 дней");
    expect(uz.go(3)).toBe("3 ta variantni koʻrsatish");
  });
});

describe("размеченный текст", () => {
  it("выделение даты в pickDate — данными, а не тегом", () => {
    expect(ru.pickDate("12 мая")).toEqual([
      "Дата поиска: ",
      { strong: "12 мая" },
      ". Проверьте остальных вендоров на этот день.",
    ]);
  });

  it("справочные окна разбиты на блоки", () => {
    expect(ru.i_ver_b.map((block) => block.kind)).toEqual(["p", "list", "warn", "p"]);
    expect(uz.i_wipe_b.map((block) => block.kind)).toEqual(["p", "list", "warn", "p"]);
  });
});
