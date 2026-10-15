import { readFileSync } from "node:fs";
import { recordingFetcher, spaAssets } from "@bayramm/edge/testing";
import { listingPhotoKey, mediaImageOrigins, mediaUrl } from "@bayramm/media";
import type { ListingDetail } from "@bayramm/shared/api";
import { describe, expect, it, vi } from "vitest";
import { allDemoListings, demoListings } from "../src/api/mock";
import { browserLang, escapeHtml, injectMeta, keepFontsOf, pageMeta } from "./meta";
import { robotsTxt } from "./seo";

// Под Vitest import.meta.env.DEV = true; проверяем воркер таким, каким он будет в сборке
vi.stubEnv("DEV", false);
const { default: worker } = await import("./index");

/* Разметка страниц для поисковиков и превью ссылок, robots.txt и sitemap.xml */

const PROD = "https://bayramm.uz";
const STAGING = "https://staging.bayramm.uz";
const INDEX_HTML = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const [LOLA, SECOND] = demoListings("2026-10-01");
if (!LOLA || !SECOND) throw new Error("нет демо-площадок");
const CAR = allDemoListings("2026-10-01").find((l) => l.categoryCode === "car");
if (!CAR) throw new Error("нет демо-кортежа");

/**
 * API: карточка по slug, категории с числом витрин и выдача категории (без параметра — залы)
 * в две страницы
 */
function fakeApi(listings: readonly ListingDetail[] = [LOLA, SECOND], fail = false) {
  return recordingFetcher((request) => {
    const url = new URL(request.url);
    if (fail) return Response.json({ error: { code: "internal_error", message: "" } }, { status: 500 });
    const slug = /^\/catalog\/listings\/([a-z0-9-]+)$/.exec(url.pathname)?.[1];
    if (slug) {
      const listing = listings.find((l) => l.slug === slug);
      return listing
        ? Response.json(listing)
        : Response.json({ error: { code: "not_found", message: "" } }, { status: 404 });
    }
    if (url.pathname === "/catalog/categories") {
      const codes = ["hall", "car", "cake"];
      return Response.json({
        items: codes.map((code) => ({
          code,
          name: { ru: code, uz: code },
          listings: listings.filter((l) => l.categoryCode === code).length,
        })),
      });
    }
    if (url.pathname === "/catalog/listings") {
      const category = url.searchParams.get("category") ?? "hall";
      const own = listings.filter((l) => l.categoryCode === category);
      const cursor = url.searchParams.get("cursor");
      const items = cursor ? own.slice(1) : own.slice(0, 1);
      return Response.json({ items, nextCursor: cursor || own.length < 2 ? null : "next" });
    }
    return new Response("not found", { status: 404 });
  });
}

function setup(api = fakeApi(), indexing: "on" | "off" = "on") {
  const env = {
    SEARCH_INDEXING: indexing,
    ASSETS: spaAssets({
      "/index.html": { body: INDEX_HTML, type: "text/html" },
      "/og.png": { body: "png", type: "image/png" },
    }),
    API: api,
  };
  const get = (url: string, init?: RequestInit) => worker.fetch(new Request(url, init), env);
  const html = async (url: string) => {
    const res = await get(url);
    return { res, body: await res.text() };
  };
  return { env, get, html };
}

const tag = (body: string, re: RegExp) => re.exec(body)?.[1] ?? null;
const title = (body: string) => tag(body, /<title>([^<]*)<\/title>/);
const metaContent = (body: string, attr: "name" | "property", name: string) => {
  for (const [, kind, key, content] of body.matchAll(/<meta (name|property)="([^"]+)" content="([^"]*)"/g))
    if (kind === attr && key === name) return content ?? null;
  return null;
};
const canonical = (body: string) => tag(body, /<link rel="canonical" href="([^"]*)"/);
const hreflangs = (body: string) =>
  [...body.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)"/g)].map(([, lang, href]) => [
    lang,
    href,
  ]);

describe("разметка страниц", () => {
  it("лендинг на боевом домене: индексируется, canonical, языковые версии, Open Graph", async () => {
    const { res, body } = await setup().html(`${PROD}/`);
    expect(res.status).toBe(200);
    expect(title(body)).toBe("Bayramm — Toshkentda bayram uchun hammasi");
    expect(metaContent(body, "name", "robots")).toBe("index, follow");
    expect(body.match(/<meta name="robots"/g)).toHaveLength(1);
    expect(body.match(/<title>/g)).toHaveLength(1);
    expect(canonical(body)).toBe(`${PROD}/`);
    expect(hreflangs(body)).toEqual([
      ["ru", `${PROD}/?lang=ru`],
      ["uz", `${PROD}/?lang=uz`],
      ["x-default", `${PROD}/`],
    ]);
    expect(metaContent(body, "property", "og:image")).toBe(`${PROD}/og.png`);
    expect(metaContent(body, "property", "og:url")).toBe(`${PROD}/`);
    expect(metaContent(body, "name", "twitter:card")).toBe("summary_large_image");
    expect(body).toContain('<html lang="uz"');
    // Без JS — заголовок и описание страницы; встроенных скриптов и стилей нет
    expect(body).toMatch(/<div id="root"><\/div><noscript><main><h1>Bayramm — /);
    expect(body).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(body).not.toMatch(/<style|style=/);
    // Заголовки безопасности на месте, HTML не кэшируется как общий index.html
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("etag")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("?lang=ru — русская версия: язык страницы, тексты и canonical на неё саму", async () => {
    const { body } = await setup().html(`${PROD}/catalog?lang=ru&date=2026-10-20`);
    expect(body).toContain('<html lang="ru"');
    // Каталог без раздела — все разделы; заголовок — как в приложении: вкладка не меняется после загрузки
    expect(title(body)).toBe("Каталог: всё для праздника · Bayramm");
    expect(metaContent(body, "property", "og:locale")).toBe("ru_RU");
    // Фильтры в canonical не попадают
    expect(canonical(body)).toBe(`${PROD}/catalog?lang=ru`);
  });

  it("каталог категории — своя страница: заголовок, описание, canonical и языковые версии с категорией", async () => {
    const { body } = await setup().html(
      `${PROD}/catalog?category=car&lang=ru&date=2026-10-20&a.decoration=1`,
    );
    expect(title(body)).toBe("Кортежи в Ташкенте · Bayramm");
    expect(metaContent(body, "name", "description")).toContain("Кортежи в Ташкенте: цены «от»");
    expect(canonical(body)).toBe(`${PROD}/catalog?category=car&amp;lang=ru`);
    expect(hreflangs(body)).toEqual([
      ["ru", `${PROD}/catalog?category=car&amp;lang=ru`],
      ["uz", `${PROD}/catalog?category=car&amp;lang=uz`],
      ["x-default", `${PROD}/catalog?category=car`],
    ]);
    // Залы — тоже свой раздел; неизвестная категория — общая страница каталога
    const hall = await setup().html(`${PROD}/catalog?category=hall&lang=ru`);
    expect(title(hall.body)).toBe("Тойханы в Ташкенте · Bayramm");
    // Описание раздела — та же строка, что на плитке лендинга
    expect(metaContent(hall.body, "name", "description")).toContain(
      "Банкетные залы для свадьбы и плова — по вместимости, меню и свободной дате.",
    );
    expect(canonical(hall.body)).toBe(`${PROD}/catalog?category=hall&amp;lang=ru`);
    const other = await setup().html(`${PROD}/catalog?category=spaceships`);
    expect(canonical(other.body)).toBe(`${PROD}/catalog`);
  });

  it("выдача поиска (?q=) — noindex, canonical — каталог раздела без запроса", async () => {
    const { body } = await setup().html(`${PROD}/catalog?category=car&q=${encodeURIComponent("кортеж")}`);
    expect(metaContent(body, "name", "robots")).toBe("noindex, nofollow");
    expect(canonical(body)).toBe(`${PROD}/catalog?category=car`);
    const all = await setup().html(`${PROD}/catalog?q=versal&lang=uz`);
    expect(metaContent(all.body, "name", "robots")).toBe("noindex, nofollow");
    expect(canonical(all.body)).toBe(`${PROD}/catalog?lang=uz`);
    // Пустой q — обычный каталог
    const empty = await setup().html(`${PROD}/catalog?q=`);
    expect(metaContent(empty.body, "name", "robots")).toBe("index, follow");
  });

  it("витрина: в описании — категория и цена с единицей", async () => {
    const { body } = await setup(fakeApi([CAR])).html(`${PROD}/venue/${CAR.slug}?lang=ru`);
    expect(metaContent(body, "name", "description")).toContain("Кортеж");
    expect(metaContent(body, "name", "description")).toContain("за час");
  });

  it("staging и разработка — noindex на всех страницах", async () => {
    for (const path of ["/", "/catalog", `/venue/${LOLA.slug}`]) {
      const { body } = await setup().html(`${STAGING}${path}`);
      expect(metaContent(body, "name", "robots"), path).toBe("noindex, nofollow");
      expect(canonical(body), path).toMatch(/^https:\/\/staging\.bayramm\.uz\//);
    }
  });

  it("площадка: название, факты и обложка из API; данные партнёра экранированы", async () => {
    const evil = { ...LOLA, name: 'Зал "<script>alert(1)</script>"' };
    const api = fakeApi([evil]);
    const { res, body } = await setup(api).html(`${PROD}/venue/${LOLA.slug}?date=2026-10-20`);
    expect(res.status).toBe(200);
    expect(api.requests.map((r) => new URL(r.url).pathname)).toEqual([`/catalog/listings/${LOLA.slug}`]);
    expect(title(body)).toBe("Зал &quot;&lt;script&gt;alert(1)&lt;/script&gt;&quot; · Bayramm");
    expect(body).not.toContain("<script>alert");
    expect(metaContent(body, "name", "description")).toContain("mehmongacha");
    expect(metaContent(body, "property", "og:image")).toBe(
      `https://media.bayramm.uz/1280/${LOLA.cover?.key}`,
    );
    expect(canonical(body)).toBe(`${PROD}/venue/${LOLA.slug}`);
    expect(metaContent(body, "name", "robots")).toBe("index, follow");
  });

  it("снятая с публикации или несуществующая площадка — 404 и noindex", async () => {
    const { res, body } = await setup().html(`${PROD}/venue/net-takoy`);
    expect(res.status).toBe(404);
    expect(metaContent(body, "name", "robots")).toBe("noindex, nofollow");
    expect(canonical(body)).toBeNull();
    expect(hreflangs(body)).toEqual([]);
    expect(body).toContain('<div id="root">');
  });

  it("API не ответило — страница площадки всё равно отдаётся, с общей разметкой", async () => {
    const { res, body } = await setup(fakeApi([], true)).html(`${PROD}/venue/${LOLA.slug}`);
    expect(res.status).toBe(200);
    expect(title(body)).toBe("Katalog · Bayramm");
  });

  it("личное, форма заявки и вход — noindex; неизвестный путь — 404", async () => {
    const { html } = setup();
    for (const path of ["/favorites", "/requests", "/profile", `/venue/${LOLA.slug}/request`, "/auth"]) {
      const { res, body } = await html(`${PROD}${path}`);
      expect(res.status, path).toBe(200);
      expect(metaContent(body, "name", "robots"), path).toBe("noindex, nofollow");
      expect(hreflangs(body), path).toEqual([]);
    }
    const missing = await html(`${PROD}/nope`);
    expect(missing.res.status).toBe(404);
    expect(title(missing.body)).toBe("Sahifa topilmadi · Bayramm");
  });

  it("условные заголовки не доходят до ASSETS: у каждой страницы свой HTML", async () => {
    const { env, get } = setup();
    const res = await get(`${PROD}/catalog`, { headers: { "If-None-Match": '"123"' } });
    expect(res.status).toBe(200);
    expect(env.ASSETS.requests[0]?.headers.get("if-none-match")).toBeNull();
  });

  it("файлы сборки идут как есть, без разметки", async () => {
    const { get } = setup();
    const res = await get(`${PROD}/og.png`);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(await res.text()).toBe("png");
  });

  it("injectMeta не трогает HTML без <title>; escapeHtml экранирует всё опасное", () => {
    expect(injectMeta("<p>x</p>", pageMeta(new URL(`${PROD}/`)))).toBe("<p>x</p>");
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });

  it("описание не длиннее 200 знаков и обрезано по слову", () => {
    const long = {
      ...LOLA,
      address: { ru: "очень длинный адрес ".repeat(20), uz: "juda uzun manzil ".repeat(20) },
    };
    const meta = pageMeta(new URL(`${PROD}/venue/${LOLA.slug}`), long);
    expect(meta.description.length).toBeLessThanOrEqual(200);
    expect(meta.description.endsWith("…")).toBe(true);
  });
});

describe("шрифты и соединение с media", () => {
  const preloads = (body: string) =>
    [...body.matchAll(/<link rel="preload"[^>]*href="[^"]*\/([a-z-]+)\.woff2"/g)].map((m) => m[1]);

  it("в HTML остаются шрифты языка страницы: русской — кириллица, узбекской — латиница Unbounded", async () => {
    const { html } = setup();
    expect(preloads((await html(`${PROD}/?lang=ru`)).body)).toEqual([
      "manrope-latin",
      "manrope-cyrillic",
      "unbounded-cyrillic",
    ]);
    expect(preloads((await html(`${PROD}/?lang=uz`)).body)).toEqual(["manrope-latin", "unbounded-latin"]);
    // Без ?lang — язык по Accept-Language, как у пререндера и <html lang>
    const ru = await setup().get(`${PROD}/catalog`, { headers: { "Accept-Language": "ru-RU,ru;q=0.9" } });
    const body = await ru.text();
    expect(body).toContain('<html lang="ru"');
    expect(preloads(body)).toEqual(["manrope-latin", "manrope-cyrillic", "unbounded-cyrillic"]);
    // Служебная пометка языка из index.html — только у тех, кого оставили
    expect(body.match(/data-font-lang="ru"/g)).toHaveLength(2);
    expect(body).not.toContain('data-font-lang="uz"');
  });

  it("то же у страниц-заглушек и 404: язык определён всегда", async () => {
    const { html } = setup();
    const missing = await html(`${PROD}/nope?lang=ru`);
    expect(missing.res.status).toBe(404);
    expect(preloads(missing.body)).toEqual(["manrope-latin", "manrope-cyrillic", "unbounded-cyrillic"]);
  });

  it("keepFontsOf: свой язык и теги без языка остаются, чужой уходит; HTML без пометок — как был", () => {
    const html = [
      '<link rel="preload" href="/a.woff2" />',
      '<link rel="preload" href="/b.woff2" crossorigin data-font-lang="ru" />',
      '<link rel="preload" data-font-lang="uz" href="/c.woff2" />',
      "<p>x</p>",
    ].join("\n    ");
    expect(keepFontsOf(html, "ru")).toBe(
      [
        '<link rel="preload" href="/a.woff2" />',
        '<link rel="preload" href="/b.woff2" crossorigin data-font-lang="ru" />',
        "<p>x</p>",
      ].join("\n    "),
    );
    expect(keepFontsOf("<p>x</p>", "uz")).toBe("<p>x</p>");
  });

  it("страницы с фото просят соединение с media своего окружения заранее; без фото — нет", async () => {
    const preconnect = (body: string) => body.match(/<link rel="preconnect" href="([^"]+)"/g);
    for (const [origin, media] of [
      [PROD, "https://media.bayramm.uz"],
      [STAGING, "https://media-staging.bayramm.uz"],
      ["http://localhost:5173", "http://localhost:8790"],
    ] as const) {
      for (const path of ["/", "/catalog", "/favorites", `/venue/${LOLA.slug}`]) {
        const { body } = await setup().html(`${origin}${path}`);
        expect(preconnect(body), `${origin}${path}`).toEqual([`<link rel="preconnect" href="${media}"`]);
      }
    }
    for (const path of ["/docs", "/profile", "/auth", "/nope"]) {
      expect(preconnect((await setup().html(`${PROD}${path}`)).body), path).toBeNull();
    }
    // Снятая с публикации площадка: 404 — фото не будет
    expect(preconnect((await setup().html(`${PROD}/venue/no-such-hall`)).body)).toBeNull();
  });

  it("адрес preconnect — тот же origin, что в адресах фото и в CSP", async () => {
    const meta = pageMeta(new URL(`${PROD}/catalog`));
    expect(meta.mediaOrigin).toBe("https://media.bayramm.uz");
    const key = listingPhotoKey(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "webp",
    );
    expect(mediaUrl(key, 640, "production").startsWith(`${meta.mediaOrigin}/`)).toBe(true);
    expect(mediaImageOrigins()).toContain(meta.mediaOrigin);
    expect(pageMeta(new URL(`${PROD}/docs`)).mediaOrigin).toBeNull();
  });
});

describe("browserLang", () => {
  it.each([
    ["ru-RU,ru;q=0.9,en;q=0.8", "ru"],
    ["en-US,en;q=0.9,uz;q=0.8,ru;q=0.7", "uz"],
    ["ru;q=0.5,uz;q=0.8", "uz"],
    ["uz-Latn-UZ", "uz"],
    ["ru;q=0", null],
    ["en, de", null],
    ["", null],
    [null, null],
  ] as const)("%s → %s", (header, lang) => {
    expect(browserLang(header)).toBe(lang);
  });
});

describe("robots.txt и sitemap.xml", () => {
  it("robots.txt: боевой домен — всё, кроме личного, и карта сайта; staging — ничего", async () => {
    const { get } = setup();
    const res = await get(`${PROD}/robots.txt`);
    // Те же заголовки безопасности, что у страниц
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("strict-transport-security")).toBe("max-age=31536000");
    const prod = await res.text();
    expect(prod).toContain("Allow: /");
    for (const path of ["/auth", "/profile", "/requests", "/favorites", "/venue/*/request"])
      expect(prod).toContain(`Disallow: ${path}\n`);
    expect(prod).toContain(`Sitemap: ${PROD}/sitemap.xml`);
    expect(robotsTxt(new URL(`${STAGING}/robots.txt`))).toBe("User-agent: *\nDisallow: /\n");
  });

  it("SEARCH_INDEXING=off: боевой домен закрыт целиком — robots.txt и noindex на страницах", async () => {
    const { get, html } = setup(fakeApi(), "off");
    expect(await (await get(`${PROD}/robots.txt`)).text()).toBe("User-agent: *\nDisallow: /\n");
    expect((await get(`${PROD}/sitemap.xml`)).status).toBe(404);
    for (const path of ["/", "/catalog", `/venue/${LOLA.slug}`]) {
      const { res, body } = await html(`${PROD}${path}`);
      expect(res.status, path).toBe(200);
      expect(metaContent(body, "name", "robots"), path).toBe("noindex, nofollow");
    }
  });

  it("sitemap.xml: лендинг, каталог и категории с витринами, документы, все витрины по курсору", async () => {
    const api = fakeApi([LOLA, SECOND, CAR]);
    const res = await setup(api).get(`${PROD}/sitemap.xml`);
    expect(res.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    const xml = await res.text();
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, loc]) => loc);
    // Торты без витрин — страницы категории в карте нет
    expect(locs).toEqual([
      `${PROD}/`,
      `${PROD}/catalog`,
      `${PROD}/docs`,
      `${PROD}/catalog?category=hall`,
      `${PROD}/catalog?category=car`,
      `${PROD}/venue/${LOLA.slug}`,
      `${PROD}/venue/${SECOND.slug}`,
      `${PROD}/venue/${CAR.slug}`,
    ]);
    expect(xml).toContain(`<xhtml:link rel="alternate" hreflang="ru" href="${PROD}/catalog?lang=ru"/>`);
    expect(xml).toContain(
      `<xhtml:link rel="alternate" hreflang="uz" href="${PROD}/catalog?category=car&amp;lang=uz"/>`,
    );
    expect(api.requests.map((r) => `${new URL(r.url).pathname}${new URL(r.url).search}`)).toEqual([
      "/catalog/categories",
      "/catalog/listings?category=hall&limit=50",
      "/catalog/listings?category=hall&limit=50&cursor=next",
      "/catalog/listings?category=car&limit=50",
    ]);
  });

  it("sitemap.xml без API — только страницы сайта", async () => {
    const res = await setup(fakeApi([], true)).get(`${PROD}/sitemap.xml`);
    expect(res.status).toBe(200);
    expect([...(await res.text()).matchAll(/<loc>/g)]).toHaveLength(3);
  });
});
