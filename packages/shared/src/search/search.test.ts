import { describe, expect, it } from "vitest";
import { CATEGORIES } from "../categories/config";
import {
  attrTextPaths,
  listingAttrText,
  MATCH_VECTORS,
  MISMATCH_VECTORS,
  NORM_VECTORS,
  relevanceKey,
  SEARCH_MAX_TOKENS,
  searchDoc,
  searchMatches,
  searchNorm,
  searchQuery,
  searchScore,
  searchSql,
  searchTokens,
  searchVectorsCount,
  searchVectorsSql,
  similarity,
  wordSimilarity,
} from ".";

const query = (raw: string) => {
  const q = searchQuery(raw);
  if (q === null) throw new Error(`не запрос: ${raw}`);
  return q;
};

describe("searchNorm — общие векторы с app.search_norm", () => {
  it.each(NORM_VECTORS)("%j → %j", (input, expected) => {
    expect(searchNorm(input)).toBe(expected);
  });

  it("равенства из постановки: oʻ = o' = o, кириллица = латиница", () => {
    expect(searchNorm("Toʻyxona")).toBe(searchNorm("to'yxona"));
    expect(searchNorm("to'yxona")).toBe(searchNorm("toyxona"));
    expect(searchNorm("кортеж")).toBe(searchNorm("kortej"));
  });

  it("результат — только [a-z0-9 ] без двойных пробелов и пробелов по краям", () => {
    for (const [input] of NORM_VECTORS) expect(searchNorm(input)).toMatch(/^(?:[a-z0-9]+(?: [a-z0-9]+)*)?$/);
  });
});

describe("слова запроса", () => {
  it("различные, от двух символов, по порядку", () => {
    expect(searchTokens("kortej a kortej s class mercedes")).toEqual(["kortej", "class", "mercedes"]);
  });

  it("не больше SEARCH_MAX_TOKENS", () => {
    expect(searchTokens("aa bb cc dd ee ff gg hh")).toHaveLength(SEARCH_MAX_TOKENS);
  });

  it("короче двух символов или без слов — не запрос", () => {
    expect(searchQuery("ж")).toBeNull();
    // Длина — после нормализации: «я» — уже два символа
    expect(searchQuery("я")).toEqual({ text: "ya", tokens: ["ya"] });
    expect(searchQuery(" ' ")).toBeNull();
    expect(searchQuery("a b c")).toBeNull();
    expect(searchQuery("Ко")).toEqual({ text: "ko", tokens: ["ko"] });
  });
});

describe("триграммы — как pg_trgm", () => {
  // Значения — из pg_trgm 1.6 (Postgres 17): similarity, word_similarity, strict_word_similarity
  it.each([
    ["word", "two words", 0.363636, 0.8, 0.571429],
    ["kartej", "kortej", 0.4, 0.428571, 0.4],
    ["shayxantaxur", "shayxontohur", 0.3, 0.384615, 0.3],
    ["versl", "versal", 0.444444, 0.666667, 0.444444],
    ["kor", "kortej toyxona", 0.1875, 0.75, 0.375],
    ["zal", "zags", 0.285714, 0.5, 0.285714],
    ["chilonzor", "test hall b1 toyxona chilanzar chilonzor banket", 0.238095, 1, 1],
    [
      "mercedes s class",
      "auto lux kortej mercedes benz s class chevrolet malibu",
      0.320755,
      0.772727,
      0.772727,
    ],
    ["ab", "abc abd xyz", 0.181818, 0.666667, 0.4],
    ["toyxona versal", "versal toyxona chilonzor", 0.6, 1, 1],
  ])("%s ~ %s", (a, b, sml, word, strict) => {
    expect(similarity(a, b)).toBeCloseTo(sml, 5);
    expect(wordSimilarity(a, b)).toBeCloseTo(word, 5);
    expect(wordSimilarity(a, b, true)).toBeCloseTo(strict, 5);
  });

  it("пустые строки — ноль", () => {
    expect(similarity("", "abc")).toBe(0);
    expect(wordSimilarity("abc", "")).toBe(0);
  });
});

describe("совпадение — общие векторы с app.search_matches", () => {
  it.each(MATCH_VECTORS)("%s подходит %s", (q, text) => {
    expect(searchMatches(query(q), searchNorm(text))).toBe(true);
  });

  it.each(MISMATCH_VECTORS)("%s не подходит %s", (q, text) => {
    expect(searchMatches(query(q), searchNorm(text))).toBe(false);
  });
});

describe("порядок", () => {
  const doc = (name: string, district: string[] = [], descriptions: string[] = []) =>
    searchDoc({
      name,
      category: ["Тойхона", "Toʻyxona"],
      district,
      services: ["Банкет — будни Banket — ish kunlari"],
      attributes: "",
      descriptions,
    });

  it("начало названия > район > описание; неподходящая — null", () => {
    const q = query("chilonzor");
    const palace = searchScore(doc("Chilonzor Palace", ["Юнусабад", "Yunusobod"]), q);
    const inDistrict = searchScore(doc("Versal", ["Чиланзар", "Chilonzor"]), q);
    const inText = searchScore(
      doc("Grand", ["Сергели", "Sergeli"], ["Рядом с Чиланзаром", "Chilonzor yonida"]),
      q,
    );
    const other = searchScore(doc("Oqsaroy", ["Сергели", "Sergeli"]), q);
    expect(palace).not.toBeNull();
    expect(inDistrict).not.toBeNull();
    expect(inText).not.toBeNull();
    expect(other).toBeNull();
    expect(palace as number).toBeGreaterThan(inDistrict as number);
    expect(inDistrict as number).toBeGreaterThan(inText as number);
  });

  it("похоже на название — выше, чем совпадение в услугах", () => {
    const q = query("banketi");
    const byName = searchScore(doc("Banket Hall"), q) as number;
    const byService = searchScore(doc("Oqsaroy"), q) as number;
    expect(byName).toBeGreaterThan(byService);
  });

  it("ключ порядка — целое по возрастанию: выше оценка — меньше ключ", () => {
    expect(relevanceKey(4.5)).toBeLessThan(relevanceKey(2.1));
    expect(Number.isSafeInteger(relevanceKey(4.123456))).toBe(true);
  });
});

describe("поля витрины в документе", () => {
  it("текстовые поля — значения; коды вариантов — нет", () => {
    const text = listingAttrText("car", {
      fleet: [
        { model: "Mercedes-Benz S-Class", class: "premium" },
        { model: "Chevrolet Malibu", class: "business" },
      ],
    });
    expect(text).toBe("Mercedes-Benz S-Class Chevrolet Malibu");
  });

  it("текст на двух языках — ru, затем uz", () => {
    expect(listingAttrText("studio", { zones: { uz: "Ikki zal", ru: "Два зала" } })).toBe(
      "Два зала Ikki zal",
    );
  });

  it("одна запись вместо списка — как lax-режим JSONPath", () => {
    expect(listingAttrText("car", { fleet: { model: "Lada" } })).toBe("Lada");
  });

  it("неизвестный раздел и не объект — пусто", () => {
    expect(listingAttrText("nope", { fleet: [] })).toBe("");
    expect(listingAttrText("car", null)).toBe("");
  });

  it("у автопарка ищется марка", () => {
    const car = CATEGORIES.find((c) => c.code === "car");
    expect(car && attrTextPaths(car)).toContainEqual({ key: "fleet", sub: "model", localized: false });
  });
});

describe("SQL из TS", () => {
  it("функции: начало и конец блока, тело без чужих апострофов", () => {
    const sql = searchSql();
    expect(sql.startsWith("-- search-sql:begin")).toBe(true);
    expect(sql.endsWith("-- search-sql:end")).toBe(true);
    expect(sql).toContain("create or replace function app.search_norm(p_text text)");
    expect(sql).toContain(`'$."fleet"[*]."model"'`);
  });

  it("векторы: по проверке на каждый", () => {
    const lines = searchVectorsSql()
      .split("\n")
      .filter((line) => line.startsWith("select "));
    expect(lines).toHaveLength(searchVectorsCount());
  });
});
