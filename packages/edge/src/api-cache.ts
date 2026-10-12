/* Кэш на краю для анонимных GET к API.

   Запрос уходит в API по сервисной привязке — а она в CDN Cloudflare не кэшируется. Каждый
   холодный заход шёл бы в воркер API (он закреплён за одним регионом) и в базу, даже за
   справочником, который меняется миграцией. Поэтому воркер приложения держит ответ сам, в
   caches.default (общий кэш дата-центра): повторный запрос отдаётся на месте, без API и без
   базы. Кэш — только для того, что API само объявило общим, и только когда запрос не может
   быть личным.

   Кладём в кэш, только если выполнено всё:
     · запрос — GET, без Authorization и без Cookie (сессия — всегда в Authorization);
     · ответ — 200, Cache-Control содержит public и не содержит private, no-store и no-cache,
       Set-Cookie нет, Vary — не больше Accept-Encoding (иначе ответ зависит от заголовков,
       которых в ключе нет);
     · срок жизни на краю — s-maxage, а без него max-age; ноль и «нет срока» — не кэшируем.
   Ключ — полный адрес запроса (с query), без заголовков. Всё, чего API не объявило public, —
   вход, кабинет, панель, личное, POST — идёт насквозь, как раньше.

   Сроки задаёт API (apps/api/src/routes): браузеру — max-age, краю — s-maxage. Каталог и
   витрина — 30 секунд и там и там (занятость меняется не за секунду, но и не за час: итого
   устаревание не больше минуты); справочники — как в браузере, десять минут; тексты согласий
   на краю не живут вовсе (s-maxage=0): новую версию текста клиент должен увидеть сразу.

   X-Bayramm-Cache: hit | miss — только у запросов, которые кэш мог бы обслужить; по нему
   видно, работает ли кэш (в Workers Logs и в браузере). */

/** Нужная часть Cache API (caches.default); в тестах — подделка */
export interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export interface ApiCacheOptions {
  readonly cache: EdgeCache;
  /** ctx.waitUntil: запись в кэш не задерживает ответ. Нет его — записываем до ответа */
  readonly waitUntil?: (promise: Promise<unknown>) => void;
  /** Часы для тестов */
  readonly now?: () => number;
}

/** Заголовок ответа: попал ли запрос в кэш края */
export const CACHE_STATUS_HEADER = "X-Bayramm-Cache";

/** Дольше этого на краю не держим, что бы ни объявил API: ошибка в заголовке не залежится */
export const EDGE_MAX_TTL_SECONDS = 3600;

/** Служебная метка в сохранённой копии: когда положили (мс). Наружу не отдаётся */
const STORED_AT = "X-Bayramm-Stored-At";

type Directives = ReadonlyMap<string, string>;

function parseCacheControl(value: string | null): Directives {
  const out = new Map<string, string>();
  for (const part of (value ?? "").split(",")) {
    const [name = "", ...rest] = part.trim().split("=");
    const key = name.trim().toLowerCase();
    if (key) out.set(key, rest.join("=").trim().replace(/^"|"$/g, ""));
  }
  return out;
}

function seconds(value: string | undefined): number | null {
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
}

/** Может ли запрос вообще обслуживаться из кэша: анонимный GET без Range */
export function isAnonymousGet(request: Request): boolean {
  return (
    request.method === "GET" &&
    !request.headers.has("Authorization") &&
    !request.headers.has("Cookie") &&
    !request.headers.has("Range")
  );
}

/** Браузер просит свежее (перезагрузка, no-cache): из кэша не отвечаем, но свежее положим */
function wantsFresh(request: Request): boolean {
  const cc = parseCacheControl(request.headers.get("Cache-Control"));
  return (
    cc.has("no-cache") || cc.has("no-store") || cc.get("max-age") === "0" || request.headers.has("Pragma")
  );
}

/** Меняется ли ответ от чего-либо, кроме кодирования (его сжатие — дело самого края) */
function variesOnRequest(response: Response): boolean {
  const vary = response.headers.get("Vary");
  if (vary === null) return false;
  return vary
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .some((token) => token !== "" && token !== "accept-encoding");
}

/**
 * Сколько секунд ответ можно держать на краю; null — нельзя. Правила — в шапке модуля.
 * Не знает про запрос: анонимность проверяет isAnonymousGet
 */
export function edgeTtl(response: Response): number | null {
  if (response.status !== 200) return null;
  if (response.headers.has("Set-Cookie") || variesOnRequest(response)) return null;
  const cc = parseCacheControl(response.headers.get("Cache-Control"));
  if (!cc.has("public") || cc.has("private") || cc.has("no-store") || cc.has("no-cache")) return null;
  const ttl = seconds(cc.get("s-maxage")) ?? seconds(cc.get("max-age"));
  if (ttl === null || ttl <= 0) return null;
  return Math.min(ttl, EDGE_MAX_TTL_SECONDS);
}

/** If-None-Match запроса совпал с ETag ответа (слабое сравнение, список, «*») */
function etagMatches(request: Request, response: Response): boolean {
  const etag = response.headers.get("ETag");
  const wanted = request.headers.get("If-None-Match");
  if (etag === null || wanted === null) return false;
  if (wanted.trim() === "*") return true;
  const bare = (tag: string) => tag.trim().replace(/^W\//, "");
  return wanted.split(",").some((tag) => bare(tag) === bare(etag));
}

/** Ответ клиенту: 304, если он уже держит эту версию, иначе сам ответ; с пометкой кэша */
function answer(request: Request, response: Response, status: "hit" | "miss"): Response {
  const matches = etagMatches(request, response);
  const out = matches
    ? new Response(null, {
        status: 304,
        headers: pick(response.headers, ["ETag", "Cache-Control", "Vary"]),
      })
    : new Response(response.body, response);
  out.headers.delete(STORED_AT);
  out.headers.set(CACHE_STATUS_HEADER, status);
  return out;
}

function pick(headers: Headers, names: readonly string[]): Headers {
  const out = new Headers();
  for (const name of names) {
    const value = headers.get(name);
    if (value !== null) out.set(name, value);
  }
  return out;
}

/**
 * Ответ API на запрос через кэш края. forward — настоящий вызов API (с путём без префикса),
 * request — исходный запрос приложения: его адрес и заголовки решают, кэшируемо ли это.
 * Запрос, который кэш обслужить не может (не GET, есть Authorization или Cookie), идёт
 * насквозь, без пометки
 */
export async function throughEdgeCache(
  request: Request,
  forward: (request: Request) => Promise<Response>,
  { cache, waitUntil, now = Date.now }: ApiCacheOptions,
): Promise<Response> {
  if (!isAnonymousGet(request)) return forward(request);

  const key = new Request(request.url, { method: "GET" });
  if (!wantsFresh(request)) {
    const hit = await cache.match(key);
    if (hit) return answer(request, hit, "hit");
  }

  // Условные заголовки на API не отдаём: на «не менялось» (304) в кэш нечего положить.
  // Решает ли браузеру 304 — answer, по ETag полного ответа
  const upstream = new Request(request);
  upstream.headers.delete("If-None-Match");
  upstream.headers.delete("If-Modified-Since");
  const response = await forward(upstream);

  if (edgeTtl(response) !== null) {
    // Копия без пометки miss: в кэше она не нужна и не должна переехать к следующему
    const stored = new Response(response.clone().body, response);
    stored.headers.set(STORED_AT, String(now()));
    const write = cache.put(key, stored).catch(() => {});
    if (waitUntil) waitUntil(write);
    else await write;
  }
  return answer(request, response, "miss");
}
