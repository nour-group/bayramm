/* Кэш статики сборки Vite для браузера и CDN. ASSETS сам отдаёт всё с проверкой при каждом
   запросе — воркер уточняет, что можно держать долго.

   · /assets/* — файлы с хэшем содержимого в имени (скрипты, стили, шрифты из fonts.css):
     новое содержимое — новый адрес, поэтому год и immutable. Пути, которого нет в сборке
     (старая вкладка после выкладки), ASSETS отдал бы как index.html (фолбэк SPA) — такой
     ответ под адресом файла закэшировался бы на год, а модульный скрипт с HTML упал бы
     невнятно. Поэтому — 404 без кэша;
   · страница (HTML) — no-cache: каждый раз сверить с сервером по ETag, новая выкладка видна
     сразу. Разметку страниц клиента (meta, пререндер) воркер сайта ставит сам и тоже с no-cache;
   · шрифты и картинки вне /assets (og.png, иконки) — сутки: имя без хэша, меняются редко;
   · остальные файлы без хэша (boot.js, boot.css, robots.txt) — no-cache: их меняет любая выкладка.

   Только ответы 200 и 304 (у 304 — тот же заголовок, что у ответа, который он подтверждает);
   ошибки — как есть. Сервер разработки Vite кэшем управляет сам. */

export const ASSETS_PREFIX = "/assets/";
/** Файл с хэшем содержимого в имени */
export const CACHE_IMMUTABLE = "public, max-age=31536000, immutable";
/** Страница и файлы без хэша: хранить можно, но перед показом — сверить */
export const CACHE_REVALIDATE = "no-cache";
/** Шрифты и картинки без хэша в имени */
export const CACHE_STATIC = "public, max-age=86400";
/** Нет такого файла сборки */
export const CACHE_NONE = "no-store";

const FONT_OR_IMAGE = /\.(woff2?|ttf|otf|png|jpe?g|webp|avif|gif|svg|ico)$/i;

const isHtml = (response: Response) => (response.headers.get("content-type") ?? "").includes("text/html");

/** Путь файла сборки с хэшем в имени */
export const isBuildAsset = (pathname: string) => pathname.startsWith(ASSETS_PREFIX);

/** Фолбэк SPA под адресом файла сборки: такого файла нет */
export function isMissingAsset(pathname: string, response: Response): boolean {
  return isBuildAsset(pathname) && response.status === 200 && isHtml(response);
}

/** Cache-Control для ответа ASSETS по пути; null — оставить как есть */
export function cacheControlFor(pathname: string, response: Response): string | null {
  if (response.status !== 200 && response.status !== 304) return null;
  if (isBuildAsset(pathname)) return CACHE_IMMUTABLE;
  if (isHtml(response)) return CACHE_REVALIDATE;
  return FONT_OR_IMAGE.test(pathname) ? CACHE_STATIC : CACHE_REVALIDATE;
}

/** Ответ на путь файла сборки, которого нет: 404 без кэша, а не index.html */
export function missingAsset(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": CACHE_NONE },
  });
}
