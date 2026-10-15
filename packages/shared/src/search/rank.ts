/* Совпадение и порядок поиска — правила app.catalog_search (миграция
   20261015090000_catalog_search.sql) на TS: демо-API клиента и подсказки разделов и районов.

   Слово запроса подходит тексту, если
     · word_similarity(слово, текст) ≥ SEARCH_WORD_SIMILARITY — начало слова, почти точное
       совпадение («kor» → «kortej»), или
     · strict_word_similarity(слово, текст) ≥ SEARCH_FUZZY_SIMILARITY — целое слово с опечаткой
       или в другой записи («kartej» → «kortej», «Шайхантахур» → «Shayxontohur»).
   Витрина подходит, если подходят все слова запроса (название, раздел, район, услуги, поля
   витрины и описание вместе).

   Порядок по похожести: у каждого слова —
     3 + похожесть — слово начинает слово названия;
     2 + похожесть — похоже на название;
     1 + похожесть — раздел, район, услуги, поля витрины;
         похожесть — только описание;
   среднее по словам, и ещё 1 — если с запроса начинается название целиком. Оплата, премиум и
   продвижение в порядке не участвуют (правило продукта «место в выдаче не продаётся»). */

import { type SearchQuery, searchNorm } from "./normalize";
import { wordSimilarity } from "./trigram";

/** Порог word_similarity (pg_trgm.word_similarity_threshold в app.catalog_search) */
export const SEARCH_WORD_SIMILARITY = 0.6;
/** Порог strict_word_similarity (pg_trgm.strict_word_similarity_threshold) */
export const SEARCH_FUZZY_SIMILARITY = 0.3;

/** Подходит ли слово запроса тексту (оба — после searchNorm) */
export function tokenMatches(token: string, text: string): boolean {
  return (
    wordSimilarity(token, text) >= SEARCH_WORD_SIMILARITY ||
    wordSimilarity(token, text, true) >= SEARCH_FUZZY_SIMILARITY
  );
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
  if (!searchMatches(query, body)) return null;
  let sum = 0;
  for (const token of query.tokens) {
    if (startsWord(token, doc.name)) sum += 3 + wordSimilarity(token, doc.name);
    else if (tokenMatches(token, doc.name)) sum += 2 + tokenSimilarity(token, doc.name);
    else if (tokenMatches(token, doc.doc)) sum += 1 + tokenSimilarity(token, doc.doc);
    else sum += tokenSimilarity(token, doc.descr);
  }
  const prefix = doc.name.startsWith(query.text) ? 1 : 0;
  return Math.fround(sum / query.tokens.length + prefix);
}

/** Ключ порядка «по похожести» — целое, по возрастанию (как ключи остальных порядков) */
export const relevanceKey = (score: number) => -Math.round(score * 100_000);
