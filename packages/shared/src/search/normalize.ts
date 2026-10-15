/* Нормализация текста поиска — одна функция в двух реализациях: searchNorm здесь и
   app.search_norm(text) в базе (её тело собирает sql.ts из этих же таблиц). Тест-векторы
   (vectors.ts) проверяются в обеих: vitest здесь, pgTAP — supabase/tests/32_catalog_search.

   Шаги (порядок важен, в SQL — тот же):
     1. строчные;
     2. кириллица (русская и узбекская) → узбекская латиница: ш → sh, ч → ch, ж → j, ё → yo,
        ю → yu, я → ya, ц → ts, щ → sh, х → x, ў → o, қ → q, ғ → g, ҳ → h, й → y; ъ и ь — без
        следа (таблица — CYRILLIC_LATIN, общая с адресом витрины);
     3. апострофы ʻ ʼ ' ` ’ ‘ ´ — без следа: «oʻ» = «o'» = «o»;
     4. диакритика — без знаков (NFKD и снятие комбинируемых знаков): «café» = «cafe»;
     5. всё, кроме a–z и 0–9, — пробел; пробелы не двоятся, по краям их нет.
   Получается строка из [a-z0-9 ] — её и сравнивает pg_trgm. */

import { CYRILLIC_LATIN } from "../slug";

/** Короче — не поиск (у API — без q, у поля — без подсказок) */
export const SEARCH_MIN_LENGTH = 2;
/** Длиннее (после нормализации) — 400 invalid_request */
export const SEARCH_MAX_LENGTH = 64;
/** Сколько символов строки запроса разбираем вообще; длиннее — 400 до нормализации */
export const SEARCH_RAW_MAX_LENGTH = 200;
/** Сколько слов запроса сравниваем (первые различные, от двух символов) */
export const SEARCH_MAX_TOKENS = 6;

/** Апострофы и их подделки: U+02BB, U+02BC, U+0027, U+0060, U+2019, U+2018, U+00B4 */
export const SEARCH_APOSTROPHES = "ʻʼ'`’‘´";

/** Комбинируемые знаки после NFKD — те же диапазоны в SQL */
export const SEARCH_MARK_RANGES: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x20d0, 0x20ff],
  [0xfe20, 0xfe2f],
];

const hex = (n: number) => n.toString(16).padStart(4, "0");
const APOSTROPHES_RE = new RegExp(`[${SEARCH_APOSTROPHES}]`, "g");
const MARKS_RE = new RegExp(
  `[${SEARCH_MARK_RANGES.map(([a, b]) => `\\u${hex(a)}-\\u${hex(b)}`).join("")}]`,
  "g",
);

/** Текст → строка поиска: [a-z0-9 ], одиночные пробелы, без пробелов по краям */
export function searchNorm(text: string): string {
  let latin = "";
  for (const ch of text.toLowerCase()) latin += CYRILLIC_LATIN[ch] ?? ch;
  return latin
    .replace(APOSTROPHES_RE, "")
    .normalize("NFKD")
    .replace(MARKS_RE, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Запрос поиска: нормализованная строка и её слова для сравнения */
export interface SearchQuery {
  /** Весь запрос после searchNorm */
  readonly text: string;
  /** Различные слова от двух символов, по порядку, не больше SEARCH_MAX_TOKENS */
  readonly tokens: readonly string[];
}

/** Слова запроса: различные, от двух символов, первые SEARCH_MAX_TOKENS — как в SQL */
export function searchTokens(normalized: string): string[] {
  const tokens: string[] = [];
  for (const word of normalized.split(" ")) {
    if (word.length < SEARCH_MIN_LENGTH || tokens.includes(word)) continue;
    tokens.push(word);
    if (tokens.length === SEARCH_MAX_TOKENS) break;
  }
  return tokens;
}

/**
 * Разбор строки запроса: null — не поиск (короче SEARCH_MIN_LENGTH после нормализации или нет
 * ни одного слова от двух символов). Длину сверх SEARCH_MAX_LENGTH проверяет вызывающий
 */
export function searchQuery(raw: string): SearchQuery | null {
  const text = searchNorm(raw);
  if (text.length < SEARCH_MIN_LENGTH) return null;
  const tokens = searchTokens(text);
  return tokens.length === 0 ? null : { text, tokens };
}
