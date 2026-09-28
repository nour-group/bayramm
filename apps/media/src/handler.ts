// Воркер media: варианты фото листингов по ширине и формату.
//
//   GET /<ширина>/listings/<листинг>/<фото>.<webp|jpg|png>
//
// Оригинал лежит в публичном бакете Supabase Storage. Воркер берёт его через
// fetch с cf.image (Cloudflare Image Transformations): уменьшает до ширины
// (scale-down — никогда не увеличивает), кодирует в AVIF или WebP — что
// принимает браузер по заголовку Accept (иначе JPEG), без метаданных.
// Результат Cloudflare кэширует сам; браузеру — на год: ключи неизменяемы
// (новое фото — новый UUID, перезапись в бакете запрещена).
//
// Если преобразование не удалось (квота бесплатного тарифа, преобразования
// выключены в зоне, локальный запуск) — отдаём оригинал с коротким кэшем:
// он уже не больше 2560 px и без метаданных. Нет такого объекта — 404.
//
// Ширины и формат пути — из @bayramm/media: только 320/640/960/1280/1920 и
// только ключи фото листингов. Всё прочее — 404 без похода в хранилище: воркер
// не прокси для чего угодно и не расходует квоту преобразований на мусор.

import { LISTING_PHOTOS_BUCKET, MEDIA_QUALITY, parseMediaPath } from "@bayramm/media";
import { trimTrailingSlashes } from "@bayramm/shared";

export interface MediaBindings {
  /** Адрес проекта Supabase, например https://<ref>.supabase.co */
  readonly SUPABASE_URL: string;
}

export type Fetch = (input: string, init?: RequestInit<RequestInitCfProperties>) => Promise<Response>;

type OutputFormat = "avif" | "webp" | "jpeg";

/** Преобразованный вариант: адрес неизменяем — год и immutable */
export const CACHE_VARIANT = "public, max-age=31536000, immutable";
/** Оригинал вместо варианта: ненадолго, чтобы вернуться к варианту, когда преобразования заработают */
export const CACHE_FALLBACK = "public, max-age=3600";
export const CACHE_NOT_FOUND = "public, max-age=60";

const IMAGE_TYPES = /^image\/(avif|webp|jpeg|png)$/;

/** Формат по Accept: AVIF, если браузер его принимает, затем WebP; старым — JPEG. */
export function negotiateFormat(accept: string | null): OutputFormat {
  const value = (accept ?? "").toLowerCase();
  if (value.includes("image/avif")) return "avif";
  if (value.includes("image/webp")) return "webp";
  return "jpeg";
}

export function originUrl(supabaseUrl: string, key: string): string {
  return `${trimTrailingSlashes(supabaseUrl)}/storage/v1/object/public/${LISTING_PHOTOS_BUCKET}/${key}`;
}

function isImage(response: Response): boolean {
  return IMAGE_TYPES.test((response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "");
}

// Ошибку преобразования Cloudflare помечает заголовком Cf-Resized: err=…
function transformed(response: Response): boolean {
  return response.ok && isImage(response) && !/err=/.test(response.headers.get("cf-resized") ?? "");
}

function baseHeaders(cacheControl: string): Headers {
  return new Headers({
    "cache-control": cacheControl,
    // Формат зависит от Accept — кэши обязаны это учитывать
    vary: "Accept",
    "x-content-type-options": "nosniff",
    // Картинки встраивают web, кабинет, админка, а при разработке — localhost
    "cross-origin-resource-policy": "cross-origin",
    "access-control-allow-origin": "*",
    // Ответ — только картинка: даже если что-то пойдёт не так, в нём нечему исполняться
    "content-security-policy": "default-src 'none'; sandbox",
  });
}

async function image(request: Request, upstream: Response, cacheControl: string): Promise<Response> {
  const headers = baseHeaders(cacheControl);
  // Из ответа хранилища — только описание содержимого, без его служебных заголовков
  for (const name of ["content-type", "content-length", "etag", "last-modified"]) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (request.method === "HEAD") {
    await upstream.body?.cancel();
    return new Response(null, { status: 200, headers });
  }
  return new Response(upstream.body, { status: 200, headers });
}

function plain(status: number, text: string, cacheControl: string, extra: Record<string, string> = {}) {
  const headers = baseHeaders(cacheControl);
  headers.set("content-type", "text/plain; charset=utf-8");
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return new Response(text, { status, headers });
}

export const notFound = () => plain(404, "Not found", CACHE_NOT_FOUND);

const badGateway = () => plain(502, "Bad gateway", "no-store");

export function createMediaHandler(fetcher: Fetch = (input, init) => fetch(input, init)) {
  async function serve(request: Request, key: string, width: number, supabaseUrl: string): Promise<Response> {
    const origin = originUrl(supabaseUrl, key);
    const format = negotiateFormat(request.headers.get("accept"));

    const variant = await fetcher(origin, {
      cf: {
        image: {
          width,
          fit: "scale-down",
          quality: MEDIA_QUALITY,
          format,
          metadata: "none",
          anim: false,
        },
      },
    });
    if (transformed(variant)) return image(request, variant, CACHE_VARIANT);
    await variant.body?.cancel();

    // Преобразование не удалось: либо объекта нет, либо недоступны сами преобразования
    const original = await fetcher(origin);
    if (original.ok && isImage(original)) {
      console.warn("media: отдаём оригинал", {
        status: variant.status,
        resized: variant.headers.get("cf-resized"),
      });
      return image(request, original, CACHE_FALLBACK);
    }
    await original.body?.cancel();

    // Supabase отвечает на отсутствующий объект 400 или 404 (зависит от версии Storage)
    if (original.status >= 400 && original.status < 500) return notFound();
    console.error("media: хранилище не отвечает", { status: original.status });
    return badGateway();
  }

  return async function handle(request: Request, env: MediaBindings): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return plain(405, "Method not allowed", "no-store", { allow: "GET, HEAD" });
    }
    const target = parseMediaPath(new URL(request.url).pathname);
    if (!target) return notFound();
    try {
      return await serve(request, target.key, target.width, env.SUPABASE_URL);
    } catch (err) {
      // Сеть до хранилища: наружу — 502 без подробностей, в лог — причина
      console.error("media: запрос к хранилищу упал", err);
      return badGateway();
    }
  };
}
