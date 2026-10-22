/* Поиск по каталогу — @bayramm/shared/search.

   Что где:
     normalize.ts  — searchNorm (= app.search_norm), слова запроса, пределы длины;
     trigram.ts    — similarity и word_similarity как у pg_trgm (для TS без базы);
     rank.ts       — совпадение и порядок (= app.catalog_search), документ витрины;
     attributes.ts — текстовые поля витрины в документе (= app.listing_attrs_text);
     suggest.ts    — подсказки: разделы и районы по названию (API и демо-API);
     vectors.ts    — общие тест-векторы TS и pgTAP;
     sql.ts        — SQL функций и векторов (pnpm --filter @bayramm/shared search:sql).
   Запросы поиска нигде не сохраняются и не пишутся в лог: в них бывают имя или телефон. */

export { attrTextJsonPath, attrTextPaths, listingAttrText } from "./attributes";
export {
  isCheapWord,
  type QueryWord,
  SEARCH_APOSTROPHES,
  SEARCH_CHEAP_PREFIXES,
  SEARCH_MAX_LENGTH,
  SEARCH_MAX_TOKENS,
  SEARCH_MIN_LENGTH,
  SEARCH_RAW_MAX_LENGTH,
  SEARCH_STOP_WORDS,
  type SearchQuery,
  searchNorm,
  searchQuery,
  searchTokens,
  splitDropped,
} from "./normalize";
export {
  relevanceKey,
  SEARCH_FORGIVE_MAX_TOKENS,
  SEARCH_FUZZY_MIN_LENGTH,
  SEARCH_FUZZY_SIMILARITY,
  SEARCH_WORD_SIMILARITY,
  type SearchDoc,
  type SearchResult,
  type SearchSource,
  searchAll,
  searchDoc,
  searchMatches,
  searchScore,
  startsWord,
  tokenMatches,
  tokenSimilarity,
} from "./rank";
export {
  SEARCH_SQL_BEGIN,
  SEARCH_SQL_END,
  SEARCH_VECTORS_BEGIN,
  SEARCH_VECTORS_END,
  searchSql,
  searchVectorsCount,
  searchVectorsSql,
} from "./sql";
export {
  matchPlaces,
  type PlaceCount,
  type PlaceName,
  placeScore,
  SUGGEST_CATEGORIES,
  SUGGEST_DISTRICT_ROWS,
  SUGGEST_DISTRICTS,
  suggestPlaces,
} from "./suggest";
export { similarity, wordSimilarity } from "./trigram";
export { MATCH_VECTORS, MISMATCH_VECTORS, NORM_VECTORS } from "./vectors";
