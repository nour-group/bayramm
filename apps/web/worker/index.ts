import { createSiteWorker, httpsRedirect } from "@bayramm/edge";
import { mediaImageOrigins } from "@bayramm/media";
import { matchRoute } from "../src/routes";
import { taklifnomaRedirect } from "./legacy";
import { indexingAllowed, injectMeta, pageMeta, type VenueLookup } from "./meta";
import { applyPrerender, wantsPrerender } from "./prerender";
import { lookupVenue, robotsTxt, sitemapXml } from "./seo";

// Vite подставляет значение при сборке: в dist всегда false, строгий CSP
const dev = import.meta.env?.DEV === true;

const site = createSiteWorker({
  dev,
  // Фото площадок — с воркера media
  imageOrigins: mediaImageOrigins(dev),
  // Mini App в Telegram Web открывается во фрейме web.telegram.org — встраивать разрешено только ему
  frameAncestors: ["https://web.telegram.org"],
  // SDK Mini App: telegram-web-app.js в script-src. Грузит его код приложения и только
  // внутри Telegram (loadTelegramWebApp в @bayramm/tg/webapp); в index.html его нет
  telegramWebApp: true,
  // Хаб входа (/auth): виджет входа Telegram — только на его страницах. У бота в @BotFather
  // /setdomain — домен сайта окружения; остальные страницы сайта виджета не пускают
  telegramLoginPaths: ["/auth"],
  // Проверка «не робот» (Cloudflare Turnstile) перед кодом на телефон — тоже только в хабе:
  // скрипт и фрейм challenges.cloudflare.com, остальные страницы сайта их не пускают
  turnstilePaths: ["/auth"],
  before: taklifnomaRedirect,
});

/** Путь страницы, а не файла: у файлов сборки есть расширение (/assets/index-….js, /og.png) */
const isPagePath = (pathname: string) => !/\.[a-z0-9]+$/i.test(pathname) && !pathname.startsWith("/api");

/**
 * Страница приложения (index.html из ASSETS) с разметкой для поисковиков и превью ссылок,
 * у главной — с пререндером лендинга (worker/prerender.ts).
 * Условные заголовки не передаём: у каждой страницы свой HTML, а 304 от ASSETS относился бы
 * к общему index.html. Неизвестный путь и снятая с публикации площадка — 404 (тот же SPA
 * покажет «Не найдено»), а не 200
 */
async function page(request: Request, env: Env, url: URL): Promise<Response> {
  const plain = new Request(request);
  plain.headers.delete("If-None-Match");
  plain.headers.delete("If-Modified-Since");
  const res = await site.fetch(plain, env);
  if (!res.ok || !res.headers.get("content-type")?.includes("text/html")) return res;

  const match = matchRoute(url.pathname);
  const slug = match?.name === "venue" || match?.name === "request" ? match.slug : null;
  const venue: VenueLookup = slug ? await lookupVenue(env.API, url.origin, slug) : null;
  const meta = pageMeta(
    url,
    venue,
    indexingAllowed(url, env.SEARCH_INDEXING),
    request.headers.get("Accept-Language"),
  );
  const headers = new Headers(res.headers);
  headers.delete("ETag");
  headers.delete("Content-Length");
  headers.set("Cache-Control", "no-cache");
  // Без ?lang язык страницы — по Accept-Language: кэшам это нужно знать
  headers.append("Vary", "Accept-Language");
  if (request.method === "HEAD") return new Response(null, { status: meta.status, headers });
  // Главная — с лендингом на языке страницы прямо в HTML; шаблоны пререндера — ни у кого
  const lang = meta.status === 200 && wantsPrerender(url) ? meta.lang : null;
  const { html, prerendered } = applyPrerender(await res.text(), lang);
  return new Response(injectMeta(html, meta, { prerendered }), { status: meta.status, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // По http — только редирект на https, и для robots.txt и карты сайта тоже (packages/edge, https.ts)
    const insecure = dev ? null : httpsRedirect(request);
    if (insecure) return insecure;
    const url = new URL(request.url);
    const read = request.method === "GET" || request.method === "HEAD";
    if (read && url.pathname === "/robots.txt")
      return new Response(robotsTxt(url, indexingAllowed(url, env.SEARCH_INDEXING)), {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    // Карта сайта — только когда поисковиков пускают (как robots.txt); иначе её нет
    if (read && url.pathname === "/sitemap.xml")
      return indexingAllowed(url, env.SEARCH_INDEXING)
        ? sitemapXml(env.API, url)
        : new Response("Not found", {
            status: 404,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
    if (read && isPagePath(url.pathname) && !taklifnomaRedirect(url)) return page(request, env, url);
    return site.fetch(request, env);
  },
} satisfies ExportedHandler<Env>;
