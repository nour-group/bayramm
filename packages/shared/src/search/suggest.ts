/* Подсказки поиска: разделы и районы, чьи названия подходят запросу, — одни правила у API
   (GET /catalog/suggest) и демо-API клиента. Названия короткие, их сравнивает TS по тем же
   правилам, что база — витрины (rank.ts). Витрины в подсказках — app.catalog_search у API и
   searchScore у демо. */

import type { Localized, SuggestCategory, SuggestDistrict } from "../api/client";
import { type SearchQuery, searchNorm } from "./normalize";
import { startsWord, tokenMatches, tokenSimilarity } from "./rank";

/** Сколько разделов, районов и строк «район — раздел» в подсказках */
export const SUGGEST_CATEGORIES = 3;
export const SUGGEST_DISTRICTS = 2;
export const SUGGEST_DISTRICT_ROWS = 4;

/** Справочная запись: раздел или район */
export interface PlaceName {
  readonly code: string;
  readonly name: Localized;
}

/** Сколько витрин в разделе и районе (district null — без района) */
export interface PlaceCount {
  readonly category: string;
  readonly district: string | null;
  readonly listings: number;
}

/**
 * Насколько название подходит запросу: лучшее слово запроса (похожесть, +1 — если слово
 * начинает слово названия); null — ни одно слово не подходит
 */
export function placeScore(q: SearchQuery, name: Localized): number | null {
  const text = searchNorm(`${name.ru} ${name.uz}`);
  let best: number | null = null;
  for (const token of q.tokens) {
    if (!tokenMatches(token, text)) continue;
    const score = tokenSimilarity(token, text) + (startsWord(token, text) ? 1 : 0);
    if (best === null || score > best) best = score;
  }
  return best;
}

/** Подходящие записи: выше оценка — раньше, при равной — в порядке справочника */
export function matchPlaces<T extends PlaceName>(q: SearchQuery, items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index, score: placeScore(q, item.name) }))
    .filter((hit): hit is { item: T; index: number; score: number } => hit.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((hit) => hit.item);
}

/**
 * Разделы и районы для подсказок. categories — включённые, в порядке показа; counts — витрины
 * хотя бы подошедших разделов и районов. Раздел — только где есть витрины. Район — в паре с
 * разделом («Чиланзар — тойханы»): с подошедшим, а если раздел не подошёл — с разделами, где в
 * районе есть витрины (больше — раньше)
 */
export function suggestPlaces(
  q: SearchQuery,
  categories: readonly PlaceName[],
  districts: readonly PlaceName[],
  counts: readonly PlaceCount[],
): { categories: SuggestCategory[]; districts: SuggestDistrict[] } {
  const categoryHits = matchPlaces(q, categories);
  const districtHits = matchPlaces(q, districts).slice(0, SUGGEST_DISTRICTS);
  const order = new Map(categories.map((c, index) => [c.code, index]));
  const inCategory = (code: string) =>
    counts.filter((c) => c.category === code).reduce((sum, c) => sum + c.listings, 0);

  const suggested = categoryHits
    .map((c) => ({ code: c.code, name: c.name, listings: inCategory(c.code) }))
    .filter((c) => c.listings > 0)
    .slice(0, SUGGEST_CATEGORIES);

  const pairs = districtHits
    .flatMap((d) => {
      const here = counts.filter((c) => c.district === d.code && c.listings > 0);
      const chosen =
        categoryHits.length > 0
          ? categoryHits.flatMap((c) => here.filter((h) => h.category === c.code))
          : [...here].sort(
              (a, b) =>
                b.listings - a.listings || (order.get(a.category) ?? 0) - (order.get(b.category) ?? 0),
            );
      return chosen.map((h) => ({ code: d.code, name: d.name, category: h.category, listings: h.listings }));
    })
    .slice(0, SUGGEST_DISTRICT_ROWS);

  return { categories: suggested, districts: pairs };
}
