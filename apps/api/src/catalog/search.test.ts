// Поиск в выдаче (q) и подсказки без базы: что уходит в SQL, порядок, total, курсор, подсказки
// разделов и районов. С настоящим Postgres — test/integration/client-api.test.ts и pgTAP
// (supabase/tests/32_catalog_search.test.sql)
import { placeScore, type SearchQuery, searchQuery } from "@bayramm/shared/search";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type RecordedQuery } from "../testing/fake-db";
import { decodeCursor, parseCatalogQuery } from "./query";
import { catalogSuggest, listCatalog } from "./service";

const ID = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;

function cardRow(n: number, patch: Record<string, unknown> = {}) {
  return {
    id: ID(n),
    slug: `hall-${n}`,
    name: `Hall ${n}`,
    category_code: "hall",
    district_code: "chilonzor",
    price_from_uzs: String(100_000 * n),
    price_unit: "per_guest",
    cap_min: 50,
    cap_max: 100 * n,
    cover_key: `listings/${ID(n)}/cover.webp`,
    cover_width: 1600,
    cover_height: 1200,
    photo_count: 3,
    busy: false,
    sort_key: String(-100_000 * n),
    ...patch,
  };
}

const isCatalog = (q: RecordedQuery) => q.sql.includes('from "app"."listings" as "l"');
const params = (values: Record<string, string>) =>
  parseCatalogQuery(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, [v]])));
const query = (raw: string) => searchQuery(raw) as SearchQuery;

afterEach(() => vi.restoreAllMocks());

describe("выдача с q", () => {
  it("соединение с app.catalog_search: нормализованный текст и раздел — параметрами; порядок — похожесть", async () => {
    const fake = fakeDb();
    await listCatalog(fake.db, params({ q: "  Кортеж «Люкс» ", category: "car" }));
    const found = fake.queries.find(isCatalog);
    const sql = found?.sql ?? "";
    expect(sql).toMatch(
      /inner join app\.catalog_search\(\$\d+::text, \$\d+::text, \$\d+::boolean\) as "sr" on "sr"\."listing_id" = "l"\."id"/,
    );
    // Выдача — с пропуском слов, которые ничего не нашли
    expect(found?.parameters).toEqual(expect.arrayContaining(["kortej lyuks", "car", true]));
    // Сырого текста в SQL и параметрах нет — только нормализованный
    expect(JSON.stringify(found)).not.toContain("Кортеж");
    expect(sql.slice(sql.lastIndexOf("order by"))).toContain(
      'order by false::boolean, (-round(sr.score * 100000))::bigint, "l"."id"',
    );
    // Сколько нашлось — окном по всей выдаче, на первой странице
    expect(sql).toContain('(count(*) over ())::int as "total"');
  });

  it("с q остаются все фильтры и выбранный порядок", async () => {
    const fake = fakeDb();
    await listCatalog(
      fake.db,
      params({ q: "versal", category: "hall", district: "chilonzor", guests: "200", sort: "price_desc" }),
    );
    const found = fake.queries.find(isCatalog);
    expect(found?.sql).toContain("app.catalog_search(");
    expect(found?.sql).toMatch(/"l"\."district_code" = \$\d+/);
    expect(found?.sql).toContain("l.cap_max >= ");
    expect(found?.sql).not.toContain("sr.score * 100000");
  });

  it("первая страница несёт total, следующие — нет; курсор помнит запрос", async () => {
    const rows = [cardRow(1, { total: 7 }), cardRow(2, { total: 7 })];
    const fake = fakeDb((q) => (isCatalog(q) ? rows : []));
    const page = await listCatalog(fake.db, params({ q: "versal", limit: "1" }));
    expect(page.total).toBe(7);
    expect(page.items).toHaveLength(1);
    const cursor = decodeCursor(page.nextCursor ?? "");
    expect(cursor).toMatchObject({ sort: "relevance", key: -100_000, id: ID(1) });
    expect(cursor?.print).toEqual(expect.any(Number));

    const next = fakeDb((q) => (isCatalog(q) ? [cardRow(2)] : []));
    const second = await listCatalog(next.db, params({ q: "versal", cursor: page.nextCursor ?? "" }));
    expect(second).not.toHaveProperty("total");
    expect(next.queries.find(isCatalog)?.sql).not.toContain('as "total"');
  });

  it("ничего не нашлось — total 0", async () => {
    const page = await listCatalog(fakeDb().db, params({ q: "versal" }));
    expect(page).toEqual({ items: [], nextCursor: null, total: 0 });
  });

  it("q короче двух символов — обычная выдача, без поиска и total", async () => {
    const fake = fakeDb();
    const page = await listCatalog(fake.db, params({ q: "x" }));
    expect(fake.queries.find(isCatalog)?.sql).not.toContain("catalog_search");
    expect(page).not.toHaveProperty("total");
  });

  it("запрос не пишется в лог", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    await listCatalog(fakeDb().db, params({ q: "Мой номер 901234567" }));
    await catalogSuggest(fakeDb().db, query("Мой номер 901234567"));
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toMatch(/901234567|nomer|номер/);
  });
});

describe("подсказки", () => {
  const CATEGORY_ROWS = [
    { code: "hall", name_ru: "Тойхона", name_uz: "Toʻyxona" },
    { code: "car", name_ru: "Кортеж", name_uz: "Kortej" },
    { code: "photo", name_ru: "Фото и видео", name_uz: "Foto va video" },
  ];
  const DISTRICT_ROWS = [
    { code: "yunusobod", name_ru: "Юнусабад", name_uz: "Yunusobod" },
    { code: "chilonzor", name_ru: "Чиланзар", name_uz: "Chilonzor" },
  ];
  type Count = { category_code: string; district_code: string | null; n: number };
  const isCounts = (q: RecordedQuery) =>
    q.sql.includes('group by "pl"."category_code", "pl"."district_code"');
  const isSearch = (q: RecordedQuery) => q.sql.includes("app.catalog_search(");
  const run = (raw: string, counts: Count[] = [], found: unknown[] = []) => {
    const fake = fakeDb((q) => {
      if (q.sql.includes('from "app"."categories"')) return CATEGORY_ROWS;
      if (q.sql.includes('from "app"."districts"')) return DISTRICT_ROWS;
      if (isCounts(q)) return counts;
      if (isSearch(q)) return found;
      return [];
    });
    return { fake, result: catalogSuggest(fake.db, query(raw)) };
  };

  it("под гостем, в одной транзакции", async () => {
    const { fake, result } = run("kortej");
    await result;
    expect(fake.log[0]).toBe("begin");
    expect(fake.log.at(-1)).toBe("commit");
  });

  it("раздел — по названию на любом языке и в любой записи; только где есть витрины", async () => {
    const { result } = run("кортеж", [{ category_code: "car", district_code: null, n: 3 }]);
    expect((await result).categories).toEqual([
      { code: "car", name: { ru: "Кортеж", uz: "Kortej" }, listings: 3 },
    ]);
    expect((await run("kortej", []).result).categories).toEqual([]);
  });

  it("район — в паре с разделами, где в нём есть витрины (больше — раньше)", async () => {
    const { result } = run("Чиланзар", [
      { category_code: "hall", district_code: "chilonzor", n: 2 },
      { category_code: "photo", district_code: "chilonzor", n: 5 },
    ]);
    const name = { ru: "Чиланзар", uz: "Chilonzor" };
    expect((await result).districts).toEqual([
      { code: "chilonzor", name, category: "photo", listings: 5 },
      { code: "chilonzor", name, category: "hall", listings: 2 },
    ]);
  });

  it("«chilonzor toʻyxona» — район в подошедшем разделе", async () => {
    const { result } = run("chilonzor toʻyxona", [
      { category_code: "hall", district_code: "chilonzor", n: 2 },
      { category_code: "photo", district_code: "chilonzor", n: 5 },
      { category_code: "hall", district_code: "yunusobod", n: 4 },
    ]);
    const body = await result;
    expect(body.categories.map((c) => [c.code, c.listings])).toEqual([["hall", 6]]);
    expect(body.districts.map((d) => [d.code, d.category])).toEqual([["chilonzor", "hall"]]);
  });

  it("из справочников ничего не подошло — витрин не считает; витрины — по похожести, до пяти", async () => {
    const { fake, result } = run("versal", [], [cardRow(1, { slug: "versal", name: "Versal" })]);
    const body = await result;
    expect(fake.queries.some(isCounts)).toBe(false);
    expect(body).toEqual({
      categories: [],
      districts: [],
      listings: [
        {
          id: ID(1),
          slug: "versal",
          name: "Versal",
          categoryCode: "hall",
          districtCode: "chilonzor",
          cover: { key: `listings/${ID(1)}/cover.webp`, width: 1600, height: 1200 },
        },
      ],
    });
    const search = fake.queries.find(isSearch);
    expect(search?.sql).toContain('order by "sr"."score" desc, "l"."id" limit $');
    expect(search?.parameters.at(-1)).toBe(5);
    expect(search?.parameters).toContain("versal");
    // Подсказки на каждую букву — без повторов поиска без слов
    expect(search?.parameters).toContain(false);
  });

  it("оценка названия: начало слова — выше похожего; не подходит — null", () => {
    const car = { ru: "Кортеж", uz: "Kortej" };
    const prefix = placeScore(query("kor"), car);
    const typo = placeScore(query("kartej"), car);
    expect(prefix).not.toBeNull();
    expect(typo).not.toBeNull();
    expect(prefix as number).toBeGreaterThan(typo as number);
    expect(placeScore(query("kor"), { ru: "Цветы", uz: "Gul doʻkoni" })).toBeNull();
  });
});
