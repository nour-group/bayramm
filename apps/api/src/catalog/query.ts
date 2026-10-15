// Параметры каталога и курсор выдачи: разбор и проверка до базы.
//
// Курсор — непрозрачная строка для клиента: base64url от JSON-массива
// [версия, сортировка, дата, гости, занята, ключ, id] последней карточки страницы, с поиском —
// ещё отпечаток запроса (не сам текст: курсор не носит запрос дальше адреса).
// Выдача упорядочена по (занята, ключ сортировки, id) — ключ у каждой
// сортировки свой (сравнимая цена, минус она, минус вместимость; сравнимая цена
// зависит от числа гостей), поэтому страница продолжается строго после курсора
// без смещений. Курсор от другой сортировки, даты или числа гостей не подходит —
// 400 invalid_cursor: ключи там другие. Фильтры по полям витрины (a.*) ключ не
// меняют — курсор от выдачи без них продолжает и выдачу с ними. Курсор другого запроса поиска —
// 400 invalid_cursor: и подходящие, и ключи «по похожести» там другие.
//
// q — поиск (@bayramm/shared/search): короче SEARCH_MIN_LENGTH после нормализации — не поиск (q
// не учитывается, как пустой: так поле, пока в нём одна буква, не ломает выдачу); длиннее
// SEARCH_MAX_LENGTH или сырой строки больше SEARCH_RAW_MAX_LENGTH — 400 invalid_request. С q
// порядок по умолчанию — relevance; relevance без q — порядок по умолчанию (price_asc).
//
// Без category — залы (hall), как в v0.1 (старые сборки клиента). category=all — все включённые
// категории одной выдачей (раздел «Все»): цены разных единиц сравниваются как есть. Фильтры
// «a.<поле>» — из конфигурации категории (@bayramm/shared/categories), неизвестный — 400
// invalid_request; у «all» их нет. part (morning | day | evening | whole) — только вместе с
// date: без даты время не действует; ключ сортировки он не меняет (отсекает, как фильтры).

import type { CatalogPart, CatalogSort } from "@bayramm/shared/api";
import { type AttributeFilter, categoryConfig, parseAttributeFilters } from "@bayramm/shared/categories";
import {
  SEARCH_MAX_LENGTH,
  SEARCH_RAW_MAX_LENGTH,
  type SearchQuery,
  searchNorm,
  searchQuery,
} from "@bayramm/shared/search";
import { ApiError } from "../errors";
import { isIsoDate } from "../time";

export const CATALOG_SORTS: readonly CatalogSort[] = [
  "price_asc",
  "price_desc",
  "capacity_desc",
  "relevance",
];
/** Фильтр «Время»: часть дня или весь день */
export const CATALOG_PARTS: readonly CatalogPart[] = ["morning", "day", "evening", "whole"];
export const DEFAULT_SORT: CatalogSort = "price_asc";
/** Порядок по умолчанию с поиском */
export const SEARCH_SORT: CatalogSort = "relevance";
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;
export const MAX_GUESTS = 5000;
/** Категория выдачи без параметра category — залы, как в v0.1 */
export const DEFAULT_CATEGORY = "hall";
/** Все включённые категории одной выдачей */
export const ALL_CATEGORIES = "all";

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
  /** Отпечаток запроса поиска (queryPrint); без поиска — null */
  readonly print: number | null;
}

export interface CatalogParams {
  readonly category: string;
  /** Поиск: нормализованный запрос и его слова; null — без поиска */
  readonly q: SearchQuery | null;
  /** Фильтры по полям витрины категории */
  readonly filters: readonly AttributeFilter[];
  /** Город: его районы и витрины без района (выездные) */
  readonly city: string | null;
  /** Район: только витрины в нём */
  readonly district: string | null;
  readonly date: string | null;
  /** Свободные в эту часть дня (или весь день) — только с датой */
  readonly part: CatalogPart | null;
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

/**
 * Параметр q (выдача и подсказки): запрос поиска; null — не поиск (нет, пусто, короче
 * SEARCH_MIN_LENGTH после нормализации). Длиннее пределов — имя в bad
 */
export function searchParam(query: QueryValues, bad: string[]): SearchQuery | null {
  const raw = single(query, "q", bad);
  if (raw === null) return null;
  if (raw.length > SEARCH_RAW_MAX_LENGTH || searchNorm(raw).length > SEARCH_MAX_LENGTH) {
    bad.push("q");
    return null;
  }
  return searchQuery(raw);
}

/**
 * Отпечаток запроса для курсора: FNV-1a (32 бита) нормализованного текста. Не секрет и не
 * хранилище — только «курсор от того же запроса»
 */
export function queryPrint(q: SearchQuery): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < q.text.length; i++) {
    hash ^= q.text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** GET /catalog/listings: всё проверено, неверное — 400 со списком параметров */
export function parseCatalogQuery(query: QueryValues): CatalogParams {
  const bad: string[] = [];
  const category = code(query, "category", bad) ?? DEFAULT_CATEGORY;
  // Фильтры — только известные категории; у неизвестной выдача и так пустая
  const config = categoryConfig(category);
  let filters: readonly AttributeFilter[] = [];
  if (config !== undefined) {
    const parsed = parseAttributeFilters(config, query);
    if (parsed.ok) filters = parsed.value;
    else bad.push(...parsed.errors);
  } else {
    bad.push(...Object.keys(query).filter((name) => name.startsWith("a.")));
  }
  const city = code(query, "city", bad);
  const district = code(query, "district", bad);
  const date = dateParam(query, bad);
  const partValue = single(query, "part", bad);
  let part: CatalogPart | null = null;
  if (partValue !== null) {
    if ((CATALOG_PARTS as readonly string[]).includes(partValue)) part = partValue as CatalogPart;
    else bad.push("part");
  }
  const guests = int(query, "guests", MAX_GUESTS, bad);
  const limit = int(query, "limit", MAX_LIMIT, bad) ?? DEFAULT_LIMIT;
  const q = searchParam(query, bad);

  const sortValue = single(query, "sort", bad);
  let sort = q === null ? DEFAULT_SORT : SEARCH_SORT;
  if (sortValue !== null) {
    if ((CATALOG_SORTS as readonly string[]).includes(sortValue)) sort = sortValue as CatalogSort;
    else bad.push("sort");
  }
  // «По похожести» без запроса — не о чем: как без sort
  if (sort === "relevance" && q === null) sort = DEFAULT_SORT;

  const cursorValue = single(query, "cursor", bad);
  if (bad.length > 0) throw invalidRequest(bad, "Invalid query parameters");

  let after: CatalogCursor | null = null;
  if (cursorValue !== null) {
    after = decodeCursor(cursorValue);
    // Курсор другой сортировки, даты, числа гостей или запроса указывает в другую выдачу
    if (
      after === null ||
      after.sort !== sort ||
      after.date !== date ||
      after.guests !== guests ||
      after.print !== (q === null ? null : queryPrint(q))
    )
      throw invalidCursor();
  }
  return {
    category,
    q,
    filters,
    city,
    district,
    date,
    part: date === null ? null : part,
    guests,
    sort,
    limit,
    after,
  };
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
  const fields: unknown[] = [
    CURSOR_VERSION,
    cursor.sort,
    cursor.date,
    cursor.guests,
    cursor.busy ? 1 : 0,
    cursor.key,
    cursor.id,
  ];
  // Без поиска — как раньше (семь полей): курсоры старых страниц остаются верными
  if (cursor.print !== null) fields.push(cursor.print);
  return toBase64Url(JSON.stringify(fields));
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
  if (!Array.isArray(parsed) || (parsed.length !== 7 && parsed.length !== 8)) return null;
  const [version, sort, date, guests, busy, key, id, print = null] = parsed as unknown[];
  if (version !== CURSOR_VERSION) return null;
  if (typeof sort !== "string" || !(CATALOG_SORTS as readonly string[]).includes(sort)) return null;
  if (date !== null && (typeof date !== "string" || !isIsoDate(date))) return null;
  const guestsOk =
    typeof guests === "number" && Number.isInteger(guests) && guests >= 1 && guests <= MAX_GUESTS;
  if (guests !== null && !guestsOk) return null;
  if (busy !== 0 && busy !== 1) return null;
  if (typeof key !== "number" || !Number.isSafeInteger(key)) return null;
  if (typeof id !== "string" || !UUID_RE.test(id)) return null;
  const printOk = typeof print === "number" && Number.isInteger(print) && print >= 0 && print <= 0xffffffff;
  if (parsed.length === 8 && !printOk) return null;
  return {
    sort: sort as CatalogSort,
    date,
    guests: guests as number | null,
    busy: busy === 1,
    key,
    id,
    print: parsed.length === 8 ? (print as number) : null,
  };
}
