// Параметры каталога и курсор выдачи: разбор и проверка до базы.
//
// Курсор — непрозрачная строка для клиента: base64url от JSON-массива
// [версия, сортировка, дата, гости, занята, ключ, id] последней карточки страницы.
// Выдача упорядочена по (занята, ключ сортировки, id) — ключ у каждой
// сортировки свой (сравнимая цена, минус она, минус вместимость; сравнимая цена
// зависит от числа гостей), поэтому страница продолжается строго после курсора
// без смещений. Курсор от другой сортировки, даты или числа гостей не подходит —
// 400 invalid_cursor: ключи там другие.

import type { CatalogSort } from "@bayramm/shared/api";
import { ApiError } from "../errors";
import { isIsoDate } from "../time";

export const CATALOG_SORTS: readonly CatalogSort[] = ["price_asc", "price_desc", "capacity_desc"];
export const DEFAULT_SORT: CatalogSort = "price_asc";
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;
export const MAX_GUESTS = 5000;

const CODE_RE = /^[a-z_]{2,30}$/;
const POSITIVE_INT_RE = /^[1-9][0-9]{0,5}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]{1,512}$/;
// 2 — в курсоре появилось число гостей (сравнимая цена зависит от него)
const CURSOR_VERSION = 2;

/** Позиция последней карточки страницы */
export interface CatalogCursor {
  readonly sort: CatalogSort;
  readonly date: string | null;
  readonly guests: number | null;
  readonly busy: boolean;
  /** Ключ сортировки: сравнимая цена, минус она или минус вместимость (целое) */
  readonly key: number;
  readonly id: string;
}

export interface CatalogParams {
  readonly category: string | null;
  readonly district: string | null;
  readonly date: string | null;
  readonly guests: number | null;
  readonly sort: CatalogSort;
  readonly limit: number;
  readonly after: CatalogCursor | null;
}

export const invalidRequest = (details: string[], message = "Invalid request") =>
  new ApiError(400, "invalid_request", message, details);
export const invalidCursor = () => new ApiError(400, "invalid_cursor", "Invalid cursor");

/** Параметры строки запроса как их отдаёт c.req.queries(): имя → все значения */
export type QueryValues = Readonly<Record<string, readonly string[] | undefined>>;

/**
 * Одно значение параметра. Нет или пусто — null (клиент мог сериализовать
 * undefined как «?date=»); повторён — ошибка: какое из значений брать, неясно.
 */
export function single(query: QueryValues, name: string, bad: string[]): string | null {
  const values = query[name];
  if (values === undefined || values.length === 0) return null;
  if (values.length > 1) {
    bad.push(name);
    return null;
  }
  const value = values[0] ?? "";
  return value === "" ? null : value;
}

function code(query: QueryValues, name: string, bad: string[]): string | null {
  const value = single(query, name, bad);
  if (value !== null && !CODE_RE.test(value)) {
    bad.push(name);
    return null;
  }
  return value;
}

function int(query: QueryValues, name: string, max: number, bad: string[]): number | null {
  const value = single(query, name, bad);
  if (value === null) return null;
  const n = POSITIVE_INT_RE.test(value) ? Number(value) : Number.NaN;
  if (!(n <= max)) {
    bad.push(name);
    return null;
  }
  return n;
}

/** Параметр date (каталог и карточка): существующий день "YYYY-MM-DD" или null */
export function dateParam(query: QueryValues, bad: string[]): string | null {
  const value = single(query, "date", bad);
  if (value !== null && !isIsoDate(value)) {
    bad.push("date");
    return null;
  }
  return value;
}

/** GET /catalog/listings: всё проверено, неверное — 400 со списком параметров */
export function parseCatalogQuery(query: QueryValues): CatalogParams {
  const bad: string[] = [];
  const category = code(query, "category", bad);
  const district = code(query, "district", bad);
  const date = dateParam(query, bad);
  const guests = int(query, "guests", MAX_GUESTS, bad);
  const limit = int(query, "limit", MAX_LIMIT, bad) ?? DEFAULT_LIMIT;

  const sortValue = single(query, "sort", bad);
  let sort = DEFAULT_SORT;
  if (sortValue !== null) {
    if ((CATALOG_SORTS as readonly string[]).includes(sortValue)) sort = sortValue as CatalogSort;
    else bad.push("sort");
  }

  const cursorValue = single(query, "cursor", bad);
  if (bad.length > 0) throw invalidRequest(bad, "Invalid query parameters");

  let after: CatalogCursor | null = null;
  if (cursorValue !== null) {
    after = decodeCursor(cursorValue);
    // Курсор другой сортировки, даты или числа гостей указывает в другую выдачу
    if (after === null || after.sort !== sort || after.date !== date || after.guests !== guests)
      throw invalidCursor();
  }
  return { category, district, date, guests, sort, limit, after };
}

// ── курсор ─────────────────────────────────────────────────────────────────

function toBase64Url(text: string): string {
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string | null {
  if (!BASE64URL_RE.test(value)) return null;
  try {
    return atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  } catch {
    return null;
  }
}

export function encodeCursor(cursor: CatalogCursor): string {
  // В курсоре только ASCII: коды, дата, число, uuid — btoa хватает
  return toBase64Url(
    JSON.stringify([
      CURSOR_VERSION,
      cursor.sort,
      cursor.date,
      cursor.guests,
      cursor.busy ? 1 : 0,
      cursor.key,
      cursor.id,
    ]),
  );
}

/** Разбор курсора; всё, что не собрано encodeCursor, — null */
export function decodeCursor(value: string): CatalogCursor | null {
  const json = fromBase64Url(value);
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 7) return null;
  const [version, sort, date, guests, busy, key, id] = parsed as unknown[];
  if (version !== CURSOR_VERSION) return null;
  if (typeof sort !== "string" || !(CATALOG_SORTS as readonly string[]).includes(sort)) return null;
  if (date !== null && (typeof date !== "string" || !isIsoDate(date))) return null;
  const guestsOk =
    typeof guests === "number" && Number.isInteger(guests) && guests >= 1 && guests <= MAX_GUESTS;
  if (guests !== null && !guestsOk) return null;
  if (busy !== 0 && busy !== 1) return null;
  if (typeof key !== "number" || !Number.isSafeInteger(key)) return null;
  if (typeof id !== "string" || !UUID_RE.test(id)) return null;
  return { sort: sort as CatalogSort, date, guests: guests as number | null, busy: busy === 1, key, id };
}
