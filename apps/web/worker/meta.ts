import { isListingPhotoKey, mediaUrl } from "@bayramm/media";
import { type Dict, dictionaries, LANGS, type Lang } from "@bayramm/shared";
import type { ListingDetail } from "@bayramm/shared/api";
import { formatPriceFrom } from "../src/format";
import { mediaEnvFor } from "../src/media";
import { hrefFor, isIndexable, type Match, matchRoute } from "../src/routes";

/* Разметка страницы для поисковиков и превью ссылок (Telegram, соцсети): заголовок,
   описание, canonical, языковые версии, Open Graph — на сервере, в HTML первой загрузки.
   Ботам JS не нужен; приложение потом меняет заголовок само при переходах (hooks.ts).

   Язык страницы — ?lang=ru|uz (языковые версии для hreflang); без параметра — узбекский,
   как у приложения по умолчанию (x-default). Индексируется только боевой домен: staging и
   локальная разработка — noindex везде. */

export const PRODUCTION_HOST = "bayramm.uz";

/** Пускать ли поисковики: только боевой домен и только с SEARCH_INDEXING=on (wrangler.jsonc) */
export const indexingAllowed = (url: URL, flag: string | undefined): boolean =>
  url.hostname === PRODUCTION_HOST && flag === "on";

/** Картинка превью ссылки по умолчанию (public/og.png): 1200×630 */
export const OG_IMAGE = { path: "/og.png", width: 1200, height: 630 } as const;

const DEFAULT_LANG: Lang = "uz";
const OG_LOCALE: Readonly<Record<Lang, string>> = { ru: "ru_RU", uz: "uz_UZ" };
/** Описание страницы — не длиннее, чем показывают выдача и превью */
const DESCRIPTION_MAX = 200;

const isLang = (value: string | null): value is Lang => LANGS.includes(value as Lang);

/** Язык страницы из адреса */
export function pageLang(url: URL): { readonly lang: Lang; readonly explicit: boolean } {
  const value = url.searchParams.get("lang");
  return isLang(value) ? { lang: value, explicit: true } : { lang: DEFAULT_LANG, explicit: false };
}

/** Площадка для разметки: данные, «нет такой» (404) или не узнали (API недоступно) */
export type VenueLookup = ListingDetail | "missing" | null;

export interface PageMeta {
  readonly lang: Lang;
  readonly status: 200 | 404;
  readonly title: string;
  readonly description: string;
  readonly index: boolean;
  /** Адрес страницы без фильтров; у ненайденной — null */
  readonly canonical: string | null;
  /** Языковые версии (hreflang): ru, uz и x-default */
  readonly alternates: readonly { readonly hreflang: string; readonly href: string }[];
  readonly image: { readonly url: string; readonly width: number; readonly height: number };
}

function clip(text: string, max = DESCRIPTION_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max / 2))}…`;
}

const pick = (value: { ru: string; uz: string }, lang: Lang) =>
  value[lang] || value[lang === "ru" ? "uz" : "ru"];

/** Заголовок и описание экрана; venue — только для площадки */
function texts(match: Match | null, t: Dict, lang: Lang, venue: VenueLookup) {
  const site = (title: string) => `${title} · Bayramm`;
  switch (match?.name) {
    case "home":
      return { title: t.metaHomeTitle, description: t.metaHomeDesc };
    case "catalog":
      return { title: site(t.hallsTitle), description: t.metaCatalogDesc };
    case "docs":
      return { title: site(t.meDocs), description: t.metaDocsDesc };
    case "favorites":
      return { title: site(t.svTitle), description: t.metaHomeDesc };
    case "requests":
      return { title: site(t.mrTitle), description: t.metaHomeDesc };
    case "profile":
      return { title: site(t.navProfile), description: t.metaHomeDesc };
    case "auth":
    case "authTelegram":
      return { title: site(t.authTitle), description: t.metaHomeDesc };
    case "request":
    case "venue": {
      if (venue === "missing") return { title: site(t.venueGoneH), description: t.venueGoneP };
      if (venue === null) return { title: site(t.hallsTitle), description: t.metaCatalogDesc };
      const price = formatPriceFrom(venue.priceFromUzs, venue.priceUnit, t);
      const facts = [
        pick(venue.address, lang),
        t.people(venue.capMax),
        [price.amount, price.unit].filter(Boolean).join(" "),
      ].filter(Boolean);
      const title = match.name === "request" ? `${t.rqTitle}: ${venue.name}` : venue.name;
      return { title: site(title), description: t.metaVenueDesc(facts.join(" · ")) };
    }
    default:
      return { title: site(t.notFoundH), description: t.notFoundP };
  }
}

/** Обложка площадки для превью: вариант 1280px с воркера media */
function venueImage(venue: VenueLookup, hostname: string) {
  if (venue === null || venue === "missing" || !venue.cover || !isListingPhotoKey(venue.cover.key))
    return null;
  const { key, width, height } = venue.cover;
  return {
    url: mediaUrl(key, 1280, mediaEnvFor(hostname)),
    width: 1280,
    height: width > 0 ? Math.round((height * 1280) / width) : 853,
  };
}

/** Разметка страницы по адресу; для площадки — с её данными */
export function pageMeta(url: URL, venue: VenueLookup = null, indexing = false): PageMeta {
  const match = matchRoute(url.pathname);
  const { lang, explicit } = pageLang(url);
  const t = dictionaries[lang];
  const missing =
    match === null || ((match.name === "venue" || match.name === "request") && venue === "missing");
  const status = missing ? 404 : 200;
  const { title, description } = texts(match, t, lang, venue);
  const index = indexing && url.hostname === PRODUCTION_HOST && status === 200 && isIndexable(match);
  const base = match && !missing ? `${url.origin}${hrefFor(match)}` : null;
  const withLang = (code: Lang) => `${base}?lang=${code}`;
  return {
    lang,
    status,
    title,
    description: clip(description),
    index,
    canonical: base === null ? null : explicit ? withLang(lang) : base,
    alternates:
      base !== null && isIndexable(match)
        ? [
            ...LANGS.map((code) => ({ hreflang: code, href: withLang(code) })),
            { hreflang: "x-default", href: base },
          ]
        : [],
    image: venueImage(venue, url.hostname) ?? {
      url: `${url.origin}${OG_IMAGE.path}`,
      width: OG_IMAGE.width,
      height: OG_IMAGE.height,
    },
  };
}

/** Текст для атрибута и узла HTML: данные площадки пишет партнёр — экранируем всё */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Теги <head>: без скриптов и стилей (CSP их не пустит) */
export function headTags(meta: PageMeta): string {
  const e = escapeHtml;
  const tags = [
    `<title>${e(meta.title)}</title>`,
    `<meta name="description" content="${e(meta.description)}" />`,
    `<meta name="robots" content="${meta.index ? "index, follow" : "noindex, nofollow"}" />`,
    meta.canonical ? `<link rel="canonical" href="${e(meta.canonical)}" />` : "",
    ...meta.alternates.map(
      (alt) => `<link rel="alternate" hreflang="${e(alt.hreflang)}" href="${e(alt.href)}" />`,
    ),
    `<meta property="og:site_name" content="Bayramm" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:locale" content="${OG_LOCALE[meta.lang]}" />`,
    `<meta property="og:title" content="${e(meta.title)}" />`,
    `<meta property="og:description" content="${e(meta.description)}" />`,
    meta.canonical ? `<meta property="og:url" content="${e(meta.canonical)}" />` : "",
    `<meta property="og:image" content="${e(meta.image.url)}" />`,
    `<meta property="og:image:width" content="${meta.image.width}" />`,
    `<meta property="og:image:height" content="${meta.image.height}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
  ];
  return tags.filter(Boolean).join("\n    ");
}

/** Текст первого экрана для тех, кто без JS: заголовок и описание страницы */
function noscript(meta: PageMeta): string {
  return `<noscript><main><h1>${escapeHtml(meta.title)}</h1><p>${escapeHtml(meta.description)}</p></main></noscript>`;
}

const TITLE_RE = /<title>[^<]*<\/title>/;
const ROBOTS_RE = /\s*<meta name="robots"[^>]*>/;
const DESCRIPTION_RE = /\s*<meta name="description"[^>]*>/;

/**
 * HTML приложения с разметкой страницы: <html lang>, теги вместо <title> из index.html,
 * текст для тех, кто без JS, — после #root. Чего нет в шаблоне — HTML как есть
 */
export function injectMeta(html: string, meta: PageMeta): string {
  if (!TITLE_RE.test(html)) return html;
  return html
    .replace(/<html lang="[a-z]+"/, `<html lang="${meta.lang}"`)
    .replace(ROBOTS_RE, "")
    .replace(DESCRIPTION_RE, "")
    .replace(TITLE_RE, () => headTags(meta))
    .replace('<div id="root"></div>', () => `<div id="root"></div>${noscript(meta)}`);
}
