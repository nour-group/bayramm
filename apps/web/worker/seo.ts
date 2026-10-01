import type { FetcherLike } from "@bayramm/edge";
import { LANGS } from "@bayramm/shared";
import type { CatalogCategories, CatalogPage, ListingDetail } from "@bayramm/shared/api";
import { CATEGORY_CODES, DEFAULT_CATEGORY, hrefFor, matchRoute } from "../src/routes";
import { escapeHtml, PRODUCTION_HOST, type VenueLookup } from "./meta";

/* robots.txt, sitemap.xml и данные площадки для разметки её страницы. Всё из API по
   сервисной привязке (пути без /api) и с кэшем Cloudflare: поисковик не дёргает базу на
   каждый запрос, а API недоступно — страница всё равно отдаётся, просто без деталей. */

/** Сколько ждать API ради разметки страницы: дольше — отдаём страницу без деталей площадки */
const VENUE_TIMEOUT_MS = 1500;
/** Данные площадки для разметки и sitemap.xml живут в кэше, секунд */
const VENUE_TTL_S = 300;
const SITEMAP_TTL_S = 3600;
/** Страниц выдачи для sitemap.xml: 50 × 20 = до 1000 площадок */
const SITEMAP_PAGES = 20;
const SITEMAP_PAGE_SIZE = 50;

/** Закрытые от поисковиков разделы: личное, форма заявки и вход */
const PRIVATE_PATHS = ["/auth", "/profile", "/requests", "/favorites", "/venue/*/request"] as const;

/** robots.txt: с индексацией — всё, кроме личного; без неё (staging, боевой до запуска) — ничего */
export function robotsTxt(url: URL, indexing = false): string {
  if (!indexing || url.hostname !== PRODUCTION_HOST) return "User-agent: *\nDisallow: /\n";
  return [
    "User-agent: *",
    ...PRIVATE_PATHS.map((path) => `Disallow: ${path}`),
    "Allow: /",
    "",
    `Sitemap: ${url.origin}/sitemap.xml`,
    "",
  ].join("\n");
}

/** Кэш Cloudflare (caches.default); в тестах и вне Workers его нет — тогда без кэша */
function edgeCache(): Cache | null {
  const store = (globalThis as { caches?: CacheStorage & { default?: Cache } }).caches;
  return store?.default ?? null;
}

async function cached(key: string, ttl: number, load: () => Promise<Response>): Promise<Response> {
  const cache = edgeCache();
  const hit = await cache?.match(key).catch(() => undefined);
  if (hit) return hit;
  const fresh = await load();
  if (fresh.ok && cache) {
    const copy = new Response(fresh.clone().body, fresh);
    copy.headers.set("Cache-Control", `public, max-age=${ttl}`);
    await cache.put(key, copy).catch(() => {});
  }
  return fresh;
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
}

/** Площадка для разметки её страницы: данные, «нет такой» или null (API не ответило) */
export async function lookupVenue(
  api: FetcherLike | undefined,
  origin: string,
  slug: string,
): Promise<VenueLookup> {
  if (!api) return null;
  const target = `${origin}/catalog/listings/${encodeURIComponent(slug)}`;
  try {
    const res = await cached(`${origin}/__seo/venue/${slug}`, VENUE_TTL_S, () =>
      api.fetch(
        new Request(target, {
          headers: { accept: "application/json" },
          signal: timeoutSignal(VENUE_TIMEOUT_MS),
        }),
      ),
    );
    if (res.status === 404) return "missing";
    if (!res.ok) return null;
    const body = (await res.json()) as ListingDetail;
    return typeof body?.name === "string" && typeof body.slug === "string" ? body : null;
  } catch {
    return null;
  }
}

/**
 * Категории с опубликованными витринами (GET /catalog/categories), только известные клиенту;
 * API не ответило — только залы (страница каталога по умолчанию есть всегда)
 */
async function liveCategories(api: FetcherLike, origin: string): Promise<string[]> {
  const res = await api.fetch(
    new Request(`${origin}/catalog/categories`, { headers: { accept: "application/json" } }),
  );
  if (!res.ok) return [DEFAULT_CATEGORY];
  const body = (await res.json()) as CatalogCategories;
  return (body.items ?? [])
    .filter((c) => c.listings > 0 && (CATEGORY_CODES as readonly string[]).includes(c.code))
    .map((c) => c.code);
}

/** Адреса опубликованных витрин категории: выдача каталога по курсору */
async function venueSlugs(
  api: FetcherLike,
  origin: string,
  category: string,
  limit: number,
): Promise<string[]> {
  const slugs: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < limit; page++) {
    const target = new URL(`${origin}/catalog/listings`);
    target.searchParams.set("category", category);
    target.searchParams.set("limit", String(SITEMAP_PAGE_SIZE));
    if (cursor) target.searchParams.set("cursor", cursor);
    const res = await api.fetch(new Request(target, { headers: { accept: "application/json" } }));
    if (!res.ok) break;
    const body = (await res.json()) as CatalogPage;
    for (const item of body.items ?? [])
      if (matchRoute(`/venue/${item.slug}`)?.name === "venue") slugs.push(item.slug);
    cursor = body.nextCursor ?? null;
    if (!cursor) break;
  }
  return slugs;
}

/** Одна страница в sitemap.xml: адрес по умолчанию и языковые версии */
function entry(origin: string, path: string): string {
  const loc = `${origin}${path}`;
  const join = loc.includes("?") ? "&" : "?";
  const alternates = [
    ...LANGS.map((lang) => [lang, `${loc}${join}lang=${lang}`] as const),
    ["x-default", loc] as const,
  ].map(
    ([hreflang, href]) => `<xhtml:link rel="alternate" hreflang="${hreflang}" href="${escapeHtml(href)}"/>`,
  );
  return `<url><loc>${escapeHtml(loc)}</loc>${alternates.join("")}</url>`;
}

/**
 * sitemap.xml: лендинг, каталог и страницы категорий с витринами, документы и опубликованные
 * витрины всех категорий (из API, с кэшем на час)
 */
export async function sitemapXml(api: FetcherLike | undefined, url: URL): Promise<Response> {
  const build = async () => {
    const pages = [hrefFor({ name: "home" }), hrefFor({ name: "catalog" }), hrefFor({ name: "docs" })];
    // API не ответило — карта без категорий и витрин, но страницы сайта в ней есть
    const categories = api ? await liveCategories(api, url.origin).catch(() => [DEFAULT_CATEGORY]) : [];
    for (const category of categories)
      if (category !== DEFAULT_CATEGORY) pages.push(hrefFor({ name: "catalog" }, { category }));
    // Страниц выдачи на категорию — поровну, всего не больше SITEMAP_PAGES
    const perCategory = Math.max(1, Math.floor(SITEMAP_PAGES / Math.max(1, categories.length)));
    for (const category of categories) {
      const slugs = api ? await venueSlugs(api, url.origin, category, perCategory).catch(() => []) : [];
      for (const slug of slugs) pages.push(hrefFor({ name: "venue", slug }));
    }
    const body = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
      ...pages.map((path) => entry(url.origin, path)),
      "</urlset>",
      "",
    ].join("\n");
    return new Response(body, {
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": `public, max-age=${SITEMAP_TTL_S}`,
      },
    });
  };
  return cached(`${url.origin}/__seo/sitemap.xml`, SITEMAP_TTL_S, build);
}
