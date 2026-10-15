/* Совпадение и порядок поиска — правила app.catalog_search (миграция
   20261015090000_catalog_search.sql) на TS: демо-API клиента и подсказки разделов и районов.

   Слово запроса подходит тексту, если
     · word_similarity(слово, текст) ≥ SEARCH_WORD_SIMILARITY — начало слова, почти точное
       совпадение («kor» → «kortej»), или
     · у слова от SEARCH_FUZZY_MIN_LENGTH букв — strict_word_similarity(слово, текст) ≥
       SEARCH_FUZZY_SIMILARITY: целое слово с опечаткой или в другой записи («kartej» → «kortej»,
       «Шайхантахур» → «Shayxontohur»). В базе то же — через словарь слов документов
       (app.search_words: similarity слова запроса и слова витрины), чтобы искать по индексу.
   Витрина подходит, если подходят все слова запроса: почти точное — в названии, разделе, районе,
   услугах, полях витрины и описании; с опечаткой — во всём, кроме описания.

   Порядок по похожести: у каждого слова (ws — word_similarity, sws — strict_word_similarity) —
     3 + ws — слово начинает слово названия;
     2 + ws — почти точно в названии;
     1 + ws — почти точно в разделе, районе, услугах, полях витрины;
     0,5 + ws / 2 — почти точно только в описании;
     sws — с опечаткой в названии; sws / 2 — с опечаткой в остальном
   (опечатка — ниже любого почти точного совпадения); среднее по словам, и ещё 1 — если с
   запроса начинается название целиком. Оплата, премиум и
   продвижение в порядке не участвуют (правило продукта «место в выдаче не продаётся»). */

import { type SearchQuery, searchNorm } from "./normalize";
import { wordSimilarity } from "./trigram";

/** Порог word_similarity (pg_trgm.word_similarity_threshold в app.catalog_search) */
export const SEARCH_WORD_SIMILARITY = 0.6;
/** Порог похожести слова с опечаткой (pg_trgm.strict_word_similarity_threshold и similarity_threshold) */
export const SEARCH_FUZZY_SIMILARITY = 0.3;
/** С опечаткой ищутся слова запроса от стольких букв: короче похожих слов слишком много */
export const SEARCH_FUZZY_MIN_LENGTH = 4;

const fuzzy = (token: string, text: string) =>
  token.length >= SEARCH_FUZZY_MIN_LENGTH && wordSimilarity(token, text, true) >= SEARCH_FUZZY_SIMILARITY;

/** Подходит ли слово запроса тексту (оба — после searchNorm) */
export function tokenMatches(token: string, text: string): boolean {
  return wordSimilarity(token, text) >= SEARCH_WORD_SIMILARITY || fuzzy(token, text);
}

/** Насколько слово похоже на текст: большее из двух похожестей */
export function tokenSimilarity(token: string, text: string): number {
  return Math.max(wordSimilarity(token, text), wordSimilarity(token, text, true));
}

/** Начинает ли слово запроса какое-нибудь слово текста */
export const startsWord = (token: string, text: string) => ` ${text}`.includes(` ${token}`);

/** Подходит ли запрос тексту: все слова (после searchNorm) */
export function searchMatches(query: SearchQuery, text: string): boolean {
  return query.tokens.every((token) => tokenMatches(token, text));
}

/** Документ поиска витрины — как строка app.listing_search, всё после searchNorm */
export interface SearchDoc {
  /** Название */
  readonly name: string;
  /** Название, раздел, район, услуги, поля витрины */
  readonly doc: string;
  /** Описания ru и uz */
  readonly descr: string;
}

/** Что попадает в документ витрины — до нормализации */
export interface SearchSource {
  readonly name: string;
  /** Названия раздела ru и uz */
  readonly category: readonly string[];
  /** Названия района ru и uz (нет района — пусто) */
  readonly district: readonly string[];
  /** Названия активных услуг (у «другой услуги» — своё) ru и uz */
  readonly services: readonly string[];
  /** Текстовые значения полей витрины (listingAttrText) */
  readonly attributes: string;
  readonly descriptions: readonly string[];
}

const join = (parts: readonly string[]) => parts.filter((part) => part !== "").join(" ");

/** Документ поиска витрины: то же, что собирает app.listing_search_refresh */
export function searchDoc(source: SearchSource): SearchDoc {
  return {
    name: searchNorm(source.name),
    doc: searchNorm(
      join([source.name, ...source.category, ...source.district, ...source.services, source.attributes]),
    ),
    descr: searchNorm(join(source.descriptions)),
  };
}

/**
 * Оценка витрины по запросу (больше — выше); null — не подходит. Те же правила, что у
 * app.catalog_search
 */
export function searchScore(doc: SearchDoc, query: SearchQuery): number | null {
  const body = join([doc.doc, doc.descr]);
  const matches = (token: string) =>
    wordSimilarity(token, body) >= SEARCH_WORD_SIMILARITY || fuzzy(token, doc.doc);
  if (!query.tokens.every(matches)) return null;
  const near = (token: string, text: string) => wordSimilarity(token, text) >= SEARCH_WORD_SIMILARITY;
  let sum = 0;
  for (const token of query.tokens) {
    if (startsWord(token, doc.name)) sum += 3 + wordSimilarity(token, doc.name);
    else if (near(token, doc.name)) sum += 2 + wordSimilarity(token, doc.name);
    else if (near(token, doc.doc)) sum += 1 + wordSimilarity(token, doc.doc);
    else if (near(token, doc.descr)) sum += 0.5 + wordSimilarity(token, doc.descr) / 2;
    else if (fuzzy(token, doc.name)) sum += wordSimilarity(token, doc.name, true);
    else if (fuzzy(token, doc.doc)) sum += wordSimilarity(token, doc.doc, true) / 2;
  }
  const prefix = doc.name.startsWith(query.text) ? 1 : 0;
  return Math.fround(sum / query.tokens.length + prefix);
}

/** Ключ порядка «по похожести» — целое, по возрастанию (как ключи остальных порядков) */
export const relevanceKey = (score: number) => -Math.round(score * 100_000);
