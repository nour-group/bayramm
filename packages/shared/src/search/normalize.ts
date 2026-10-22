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

/**
 * Служебные слова — в запросе не ищутся, если есть другие: «зал на Чиланзаре», «торт для
 * свадьбы», «toʻy uchun». Одно такое слово — ищется: «за» — начало «ЗАГС». Как после searchNorm;
 * однобуквенные («в», «с», «и») отсекает и так длина слова
 */
export const SEARCH_STOP_WORDS: readonly string[] = [
  "na",
  "vo",
  "dlya",
  "so",
  "po",
  "ko",
  "ob",
  "ot",
  "iz",
  "za",
  "do",
  "bez",
  "pod",
  "pri",
  "pro",
  "ili",
  "no",
  "uchun",
  "va",
  "bilan",
  "ham",
  "yoki",
];

/**
 * Слова о цене не ищутся, а меняют порядок — сначала дешевле: «недорогой зал», «arzon tort».
 * Начала слов после searchNorm: дешёвый, дёшево, недорогой, бюджетный, эконом, arzon, hamyonbop
 */
export const SEARCH_CHEAP_PREFIXES: readonly string[] = [
  "deshe",
  "deshyo",
  "dyoshe",
  "nedorog",
  "byudjet",
  "ekonom",
  "arzon",
  "hamyonbop",
];

/** Слово о цене (после searchNorm) */
export const isCheapWord = (word: string): boolean => SEARCH_CHEAP_PREFIXES.some((p) => word.startsWith(p));

/** Слово запроса ищется: от двух символов, не служебное и не о цене */
const searchable = (word: string) =>
  word.length >= SEARCH_MIN_LENGTH && !SEARCH_STOP_WORDS.includes(word) && !isCheapWord(word);

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
  /**
   * Различные слова от двух символов, кроме слов о цене и служебных (если есть другие), по
   * порядку, не больше SEARCH_MAX_TOKENS
   */
  readonly tokens: readonly string[];
  /** В запросе есть слово о цене («недорогой», «arzon»): порядок по умолчанию — сначала дешевле */
  readonly cheap: boolean;
}

/**
 * Слова запроса: различные, от двух символов, кроме слов о цене и служебных (если есть другие),
 * первые SEARCH_MAX_TOKENS — как app.search_query_words
 */
export function searchTokens(normalized: string): string[] {
  const words: string[] = [];
  for (const word of normalized.split(" ")) {
    if (word.length < SEARCH_MIN_LENGTH || isCheapWord(word) || words.includes(word)) continue;
    words.push(word);
  }
  const meaningful = words.filter((word) => !SEARCH_STOP_WORDS.includes(word));
  return (meaningful.length > 0 ? meaningful : words).slice(0, SEARCH_MAX_TOKENS);
}

/**
 * Разбор строки запроса: null — не поиск (короче SEARCH_MIN_LENGTH после нормализации или нет
 * ни одного слова от двух символов). Длину сверх SEARCH_MAX_LENGTH проверяет вызывающий
 */
export function searchQuery(raw: string): SearchQuery | null {
  const text = searchNorm(raw);
  if (text.length < SEARCH_MIN_LENGTH) return null;
  const tokens = searchTokens(text);
  return tokens.length === 0 ? null : { text, tokens, cheap: text.split(" ").some(isCheapWord) };
}

/** Слово запроса как ввели и его слова после нормализации */
export interface QueryWord {
  readonly raw: string;
  readonly norm: readonly string[];
}

/**
 * Что из запроса не нашлось: слова как ввели — найденные и пропущенные (dropped — слова после
 * нормализации из ответа выдачи). Служебные слова и слова о цене — ни там ни там
 */
export function splitDropped(
  raw: string,
  dropped: readonly string[],
): { readonly found: string; readonly missed: string } {
  const words: QueryWord[] = raw
    .split(/\s+/)
    .filter((w) => w !== "")
    .map((w) => ({ raw: w, norm: searchNorm(w).split(" ").filter(searchable) }))
    .filter((w) => w.norm.length > 0);
  const missed = words.filter((w) => w.norm.every((n) => dropped.includes(n)));
  const found = words.filter((w) => !missed.includes(w));
  return { found: found.map((w) => w.raw).join(" "), missed: missed.map((w) => w.raw).join(" ") };
}
