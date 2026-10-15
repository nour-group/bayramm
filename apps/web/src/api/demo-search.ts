import type { CatalogSuggest, Dictionaries, ListingDetail } from "@bayramm/shared/api";
import { CATEGORIES, categoryTexts } from "@bayramm/shared/categories";
import {
  listingAttrText,
  type PlaceCount,
  type SearchDoc,
  type SearchQuery,
  searchDoc,
  searchScore,
  suggestPlaces,
} from "@bayramm/shared/search";

/* Поиск демо-API (VITE_API=mock) — как у сервера, на TS: документ витрины собирается из тех же
   частей, что app.listing_search_refresh (название, раздел, район, услуги, текстовые поля,
   описание), совпадение и порядок — searchScore (@bayramm/shared/search), подсказки разделов и
   районов — suggestPlaces, общие с API. */

const docs = new WeakMap<ListingDetail, SearchDoc>();

/** Документ поиска демо-витрины (один раз на витрину) */
function docOf(listing: ListingDetail, dictionaries: Dictionaries): SearchDoc {
  const cached = docs.get(listing);
  if (cached) return cached;
  const category = CATEGORIES.find((c) => c.code === listing.categoryCode);
  const categoryName = category ? categoryTexts(category.label) : null;
  const district = dictionaries.districts.find((d) => d.code === listing.districtCode);
  const doc = searchDoc({
    name: listing.name,
    category: categoryName ? [categoryName.ru, categoryName.uz] : [],
    district: district ? [district.name.ru, district.name.uz] : [],
    services: listing.services.flatMap((s) => [s.name.ru, s.name.uz]),
    attributes: listingAttrText(listing.categoryCode, listing.attributes),
    descriptions: [listing.description.ru, listing.description.uz],
  });
  docs.set(listing, doc);
  return doc;
}

/** Оценки подходящих витрин (id → оценка); неподходящих в ответе нет */
export function demoSearch(
  listings: readonly ListingDetail[],
  dictionaries: Dictionaries,
  q: SearchQuery,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const listing of listings) {
    const score = searchScore(docOf(listing, dictionaries), q);
    if (score !== null) scores.set(listing.id, score);
  }
  return scores;
}

/** Подсказки, как GET /catalog/suggest: разделы, районы в разделах, до пяти витрин по похожести */
export function demoSuggest(
  listings: readonly ListingDetail[],
  dictionaries: Dictionaries,
  q: SearchQuery,
  limit: number,
): CatalogSuggest {
  const counts = new Map<string, PlaceCount>();
  for (const l of listings) {
    const key = `${l.categoryCode}|${l.districtCode ?? ""}`;
    const prev = counts.get(key);
    counts.set(key, {
      category: l.categoryCode,
      district: l.districtCode,
      listings: (prev?.listings ?? 0) + 1,
    });
  }
  const places = suggestPlaces(q, dictionaries.categories, dictionaries.districts, [...counts.values()]);
  const scores = demoSearch(listings, dictionaries, q);
  const found = listings
    .filter((l) => scores.has(l.id))
    .sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0) || a.id.localeCompare(b.id))
    .slice(0, limit);
  return {
    ...places,
    listings: found.map((l) => ({
      id: l.id,
      slug: l.slug,
      name: l.name,
      categoryCode: l.categoryCode,
      districtCode: l.districtCode,
      cover: l.cover,
    })),
  };
}
