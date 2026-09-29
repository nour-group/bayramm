// Параметры каталога и курсор — без базы
import { describe, expect, it } from "vitest";
import { ApiError } from "../errors";
import { type CatalogCursor, decodeCursor, encodeCursor, parseCatalogQuery, type QueryValues } from "./query";

const ID = "aaaaaaaa-0000-4000-8000-000000000101";

function q(params: Record<string, string | string[]>): QueryValues {
  return Object.fromEntries(Object.entries(params).map(([k, v]) => [k, Array.isArray(v) ? v : [v]]));
}

function rejection(run: () => unknown): ApiError {
  try {
    run();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("ожидался отказ");
}

describe("parseCatalogQuery", () => {
  it("без параметров — умолчания: price_asc, 20 на страницу, без фильтров", () => {
    expect(parseCatalogQuery({})).toEqual({
      category: null,
      district: null,
      date: null,
      guests: null,
      sort: "price_asc",
      limit: 20,
      after: null,
    });
  });

  it("все параметры", () => {
    expect(
      parseCatalogQuery(
        q({
          category: "hall",
          district: "mirzo_ulugbek",
          date: "2026-10-03",
          guests: "250",
          sort: "capacity_desc",
          limit: "50",
        }),
      ),
    ).toEqual({
      category: "hall",
      district: "mirzo_ulugbek",
      date: "2026-10-03",
      guests: 250,
      sort: "capacity_desc",
      limit: 50,
      after: null,
    });
  });

  it("пустое значение — как отсутствующее; неизвестные параметры не мешают", () => {
    expect(parseCatalogQuery(q({ date: "", guests: "", sort: "", _: "123" }))).toMatchObject({
      date: null,
      guests: null,
      sort: "price_asc",
    });
  });

  it.each<[string, Record<string, string | string[]>, string[]]>([
    ["guests не число", { guests: "abc" }, ["guests"]],
    ["guests = 0", { guests: "0" }, ["guests"]],
    ["guests больше 5000", { guests: "5001" }, ["guests"]],
    ["guests с ведущим нулём и дробью", { guests: "0100" }, ["guests"]],
    ["guests отрицательный", { guests: "-5" }, ["guests"]],
    ["limit больше 50", { limit: "51" }, ["limit"]],
    ["limit = 0", { limit: "0" }, ["limit"]],
    ["неизвестная сортировка", { sort: "rating" }, ["sort"]],
    ["платной сортировки нет", { sort: "promo" }, ["sort"]],
    ["несуществующий день", { date: "2026-02-30" }, ["date"]],
    ["дата не в формате", { date: "03.10.2026" }, ["date"]],
    ["код категории с заглавными", { category: "Hall" }, ["category"]],
    ["код района с SQL", { district: "x' or 1=1" }, ["district"]],
    ["параметр повторён", { guests: ["100", "200"] }, ["guests"]],
    ["несколько сразу", { guests: "x", sort: "y", date: "z" }, ["date", "guests", "sort"]],
  ])("%s — 400 invalid_request", (_, params, details) => {
    const err = rejection(() => parseCatalogQuery(q(params)));
    expect(err.status).toBe(400);
    expect(err.code).toBe("invalid_request");
    expect(err.details).toEqual(details);
  });
});

describe("курсор", () => {
  const cursor: CatalogCursor = { sort: "price_desc", date: "2026-10-03", busy: true, key: -150000, id: ID };

  it("туда и обратно; строка — base64url без дополнения", () => {
    const encoded = encodeCursor(cursor);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(encoded)).toEqual(cursor);
    expect(decodeCursor(encodeCursor({ ...cursor, date: null, busy: false, key: 0 }))).toEqual({
      ...cursor,
      date: null,
      busy: false,
      key: 0,
    });
  });

  it("параметр cursor продолжает ту же выдачу", () => {
    const params = parseCatalogQuery(
      q({ sort: "price_desc", date: "2026-10-03", cursor: encodeCursor(cursor) }),
    );
    expect(params.after).toEqual(cursor);
  });

  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

  it.each<[string, string]>([
    ["не base64url", "not a cursor!"],
    ["не JSON", Buffer.from("{oops").toString("base64url")],
    ["объект вместо массива", b64({ sort: "price_asc" })],
    ["другая версия", b64([2, "price_desc", "2026-10-03", 1, -150000, ID])],
    ["неизвестная сортировка", b64([1, "promo", "2026-10-03", 1, -150000, ID])],
    ["кривая дата", b64([1, "price_desc", "2026-02-30", 1, -150000, ID])],
    ["busy не 0/1", b64([1, "price_desc", "2026-10-03", true, -150000, ID])],
    ["ключ дробный", b64([1, "price_desc", "2026-10-03", 1, 1.5, ID])],
    ["ключ строкой", b64([1, "price_desc", "2026-10-03", 1, "1; drop table", ID])],
    ["id не uuid", b64([1, "price_desc", "2026-10-03", 1, -150000, "1 or 1=1"])],
    ["лишнее поле", b64([1, "price_desc", "2026-10-03", 1, -150000, ID, 0])],
    ["слишком длинный", "A".repeat(600)],
  ])("%s — null, в запросе — 400 invalid_cursor", (_, value) => {
    expect(decodeCursor(value)).toBeNull();
    const err = rejection(() =>
      parseCatalogQuery(q({ sort: "price_desc", date: "2026-10-03", cursor: value })),
    );
    expect(err).toMatchObject({ status: 400, code: "invalid_cursor" });
  });

  it("курсор другой сортировки или даты — 400 invalid_cursor", () => {
    const encoded = encodeCursor(cursor);
    const variants: Record<string, string>[] = [
      { sort: "price_asc", date: "2026-10-03" },
      { sort: "price_desc", date: "2026-10-04" },
      { sort: "price_desc" },
    ];
    for (const params of variants) {
      const err = rejection(() => parseCatalogQuery(q({ ...params, cursor: encoded })));
      expect(err.code, JSON.stringify(params)).toBe("invalid_cursor");
    }
  });

  it("сначала — ошибки параметров, курсор разбирается после", () => {
    const err = rejection(() => parseCatalogQuery(q({ guests: "0", cursor: "garbage" })));
    expect(err.code).toBe("invalid_request");
  });
});
