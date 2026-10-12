import { describe, expect, it } from "vitest";
import {
  CACHE_STATUS_HEADER,
  EDGE_MAX_TTL_SECONDS,
  type EdgeCache,
  edgeTtl,
  throughEdgeCache,
} from "./api-cache";
import { proxyToApi } from "./api-proxy";
import { createSiteWorker } from "./site-worker";
import { recordingFetcher, SPA_FILES, spaAssets } from "./testing";

/* Кэш края для анонимных GET к API: что кладём, что нет, и что не должно утечь другому */

const ORIGIN = "https://bayramm.example";
const PUBLIC = "public, max-age=30, s-maxage=30, stale-while-revalidate=60";

/** Подделка caches.default: ключ — адрес, копия ответа на каждый match, как у настоящего */
function fakeCache() {
  const store = new Map<string, Response>();
  const puts: string[] = [];
  const cache: EdgeCache = {
    async match(request) {
      return store.get(request.url)?.clone();
    },
    async put(request, response) {
      puts.push(request.url);
      store.set(request.url, response.clone());
    },
  };
  return { cache, store, puts };
}

interface ApiReply {
  readonly body?: unknown;
  readonly status?: number;
  readonly headers?: Record<string, string>;
}

/** API, которое отвечает по очереди заданным и считает вызовы */
function api(
  reply: (n: number) => ApiReply = (n) => ({ body: { n }, headers: { "Cache-Control": PUBLIC } }),
) {
  let n = 0;
  const fetcher = recordingFetcher((request) => {
    n++;
    const { body = { n }, status = 200, headers = { "Cache-Control": PUBLIC } } = reply(n);
    // Новый объект на каждый вызов: тело читается один раз
    return new Response(JSON.stringify({ ...(body as object), path: new URL(request.url).pathname }), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });
  });
  return fetcher;
}

const get = (path: string, init?: RequestInit) => new Request(`${ORIGIN}/api${path}`, init);

function setup(reply?: Parameters<typeof api>[0]) {
  const fake = fakeCache();
  const upstream = api(reply);
  const waited: Promise<unknown>[] = [];
  const call = (request: Request) =>
    proxyToApi(request, new URL(request.url).pathname.replace(/^\/api/, ""), upstream, {
      cache: fake.cache,
      waitUntil: (promise) => waited.push(promise),
    });
  return { ...fake, upstream, call, settle: () => Promise.all(waited) };
}

describe("edgeTtl", () => {
  const ttl = (cacheControl: string | null, init: ResponseInit = {}) =>
    edgeTtl(
      new Response(init.status === 304 ? null : "{}", {
        ...init,
        headers: { ...(cacheControl ? { "Cache-Control": cacheControl } : {}), ...init.headers },
      }),
    );

  it("s-maxage важнее max-age; без него — max-age", () => {
    expect(ttl("public, max-age=30, s-maxage=90")).toBe(90);
    expect(ttl("public, max-age=600")).toBe(600);
    expect(ttl("public, max-age=30, stale-while-revalidate=60")).toBe(30);
    expect(ttl("PUBLIC, MAX-AGE=45")).toBe(45);
  });

  it("не дольше предела, что бы ни объявили", () => {
    expect(ttl("public, s-maxage=999999")).toBe(EDGE_MAX_TTL_SECONDS);
  });

  it.each([
    ["нет Cache-Control", null],
    ["нет public", "max-age=30"],
    ["private", "private, max-age=30"],
    ["public и private вместе", "public, private, max-age=30"],
    ["no-store", "public, no-store"],
    ["no-cache", "public, no-cache, max-age=30"],
    ["срока нет", "public"],
    ["max-age=0", "public, max-age=0"],
    ["краю — ноль (тексты согласий)", "public, max-age=300, s-maxage=0"],
    ["срок не число", "public, max-age=abc"],
  ])("не кэшируем: %s", (_name, cacheControl) => {
    expect(ttl(cacheControl)).toBeNull();
  });

  it("только 200; Set-Cookie и Vary от запроса — нет", () => {
    expect(ttl(PUBLIC, { status: 404 })).toBeNull();
    expect(ttl(PUBLIC, { status: 500 })).toBeNull();
    expect(ttl(PUBLIC, { status: 304 })).toBeNull();
    expect(ttl(PUBLIC, { headers: { "Set-Cookie": "a=1" } })).toBeNull();
    expect(ttl(PUBLIC, { headers: { Vary: "Accept-Language" } })).toBeNull();
    expect(ttl(PUBLIC, { headers: { Vary: "Accept-Encoding, Origin" } })).toBeNull();
    expect(ttl(PUBLIC, { headers: { Vary: "*" } })).toBeNull();
    // Кодирование края не зависит от нас
    expect(ttl(PUBLIC, { headers: { Vary: "Accept-Encoding" } })).toBe(30);
  });
});

describe("proxyToApi с кэшем края", () => {
  it("первый запрос — в API (miss) и в кэш, второй — из кэша (hit), API не зовут", async () => {
    const { call, upstream, puts, settle } = setup();
    const first = await call(get("/catalog/listings?category=hall"));
    expect(first.headers.get(CACHE_STATUS_HEADER)).toBe("miss");
    expect(await first.json()).toEqual({ n: 1, path: "/catalog/listings" });
    await settle();
    expect(puts).toEqual([`${ORIGIN}/api/catalog/listings?category=hall`]);

    const second = await call(get("/catalog/listings?category=hall"));
    expect(second.headers.get(CACHE_STATUS_HEADER)).toBe("hit");
    expect(await second.json()).toEqual({ n: 1, path: "/catalog/listings" });
    expect(second.headers.get("Cache-Control")).toBe(PUBLIC);
    expect(upstream.requests).toHaveLength(1);
    // В API ушёл путь без префикса, query сохранён
    expect(upstream.requests[0]?.url).toBe(`${ORIGIN}/catalog/listings?category=hall`);
  });

  it("ключ — полный адрес: другой query (категория, дата, id) — другая запись, не чужой ответ", async () => {
    const { call, upstream, settle } = setup();
    const urls = [
      "/catalog/listings?category=hall",
      "/catalog/listings?category=car",
      "/catalog/listings?category=hall&date=2026-10-20",
      "/catalog/cards?ids=a",
      "/catalog/cards?ids=b",
    ];
    for (const url of urls) {
      const res = await call(get(url));
      expect(res.headers.get(CACHE_STATUS_HEADER), url).toBe("miss");
      await res.arrayBuffer();
    }
    await settle();
    expect(upstream.requests).toHaveLength(urls.length);
    const counts: number[] = [];
    for (const url of urls) {
      const res = await call(get(url));
      expect(res.headers.get(CACHE_STATUS_HEADER), url).toBe("hit");
      counts.push(((await res.json()) as { n: number }).n);
    }
    // Каждому адресу — свой ответ (n — номер вызова API)
    expect(counts).toEqual([1, 2, 3, 4, 5]);
  });

  it("запись идёт через waitUntil и не держит ответ", async () => {
    const fake = fakeCache();
    let release: () => void = () => {};
    const slow: EdgeCache = {
      match: fake.cache.match,
      put: (request, response) =>
        new Promise<void>((resolve) => {
          release = () => resolve(void fake.cache.put(request, response));
        }),
    };
    const waited: Promise<unknown>[] = [];
    const res = await proxyToApi(get("/catalog/categories"), "/catalog/categories", api(), {
      cache: slow,
      waitUntil: (p) => waited.push(p),
    });
    // Ответ уже у нас, запись ещё не закончилась, но передана воркеру на дожидание
    expect(res.status).toBe(200);
    expect(waited).toHaveLength(1);
    expect(fake.store.size).toBe(0);
    release();
    await Promise.all(waited);
    expect(fake.store.size).toBe(1);
  });

  it("без waitUntil запись дожидаемся до ответа", async () => {
    const fake = fakeCache();
    await proxyToApi(get("/catalog/categories"), "/catalog/categories", api(), { cache: fake.cache });
    expect(fake.store.size).toBe(1);
  });

  it("сбой записи в кэш не ломает ответ", async () => {
    const broken: EdgeCache = {
      match: async () => undefined,
      put: async () => {
        throw new Error("cache down");
      },
    };
    const res = await proxyToApi(get("/catalog/categories"), "/catalog/categories", api(), { cache: broken });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ n: 1 });
  });

  it("служебная метка времени и пометка miss в кэш не попадают и клиенту не отдаются", async () => {
    const { call, store, settle } = setup();
    const res = await call(get("/catalog/categories"));
    await res.arrayBuffer();
    await settle();
    const stored = store.get(`${ORIGIN}/api/catalog/categories`);
    expect(stored?.headers.get(CACHE_STATUS_HEADER)).toBeNull();
    const hit = await call(get("/catalog/categories"));
    expect(hit.headers.get("X-Bayramm-Stored-At")).toBeNull();
    expect(hit.headers.get(CACHE_STATUS_HEADER)).toBe("hit");
  });
});

describe("что идёт насквозь", () => {
  it.each([
    ["Authorization (сессия клиента, кабинета, панели)", { headers: { Authorization: "Bearer t" } }],
    ["Cookie", { headers: { Cookie: "a=1" } }],
    ["Range", { headers: { Range: "bytes=0-9" } }],
    ["POST", { method: "POST", body: "{}" }],
    ["HEAD", { method: "HEAD" }],
  ])("запрос с %s не читает кэш и не пишет в него", async (_name, init) => {
    const { call, upstream, puts, store, settle } = setup();
    // Кто-то до этого положил общий ответ — личному запросу он не должен достаться
    const warm = await call(get("/catalog/listings"));
    await warm.arrayBuffer();
    await settle();
    const before = store.size;

    const res = await call(get("/catalog/listings", init));
    expect(res.headers.get(CACHE_STATUS_HEADER)).toBeNull();
    expect(upstream.requests).toHaveLength(2);
    await settle();
    expect(puts).toHaveLength(before);
  });

  it("ответ API на личный запрос в кэш не попадает, даже если API назвало его public", async () => {
    const { call, store, settle } = setup();
    const res = await call(get("/me", { headers: { Authorization: "Bearer t" } }));
    await res.arrayBuffer();
    await settle();
    expect(store.size).toBe(0);
    // Анонимный запрос на тот же адрес получает своё, а не чужое
    const anon = await call(get("/me"));
    expect(anon.headers.get(CACHE_STATUS_HEADER)).toBe("miss");
  });

  it.each([
    ["404", { status: 404 }],
    ["500", { status: 500 }],
    ["no-store", { headers: { "Cache-Control": "no-store" } }],
    ["private", { headers: { "Cache-Control": "private, max-age=30" } }],
    ["без Cache-Control", { headers: {} }],
    ["Set-Cookie", { headers: { "Cache-Control": PUBLIC, "Set-Cookie": "s=1" } }],
    ["Vary: Accept-Language", { headers: { "Cache-Control": PUBLIC, Vary: "Accept-Language" } }],
    ["s-maxage=0", { headers: { "Cache-Control": "public, max-age=300, s-maxage=0" } }],
  ] as const)("ответ %s не кэшируется: следующий запрос снова в API", async (_name, reply) => {
    const { call, upstream, store, settle } = setup(() => reply as ApiReply);
    for (let i = 0; i < 2; i++) {
      const res = await call(get("/catalog/categories"));
      expect(res.headers.get(CACHE_STATUS_HEADER)).toBe("miss");
      await res.arrayBuffer();
    }
    await settle();
    expect(store.size).toBe(0);
    expect(upstream.requests).toHaveLength(2);
  });

  it("запрос, который просит свежее (Cache-Control: no-cache), кэш не читает, но обновляет", async () => {
    const { call, upstream, settle } = setup();
    await (await call(get("/dictionaries"))).arrayBuffer();
    await settle();
    const reload = await call(get("/dictionaries", { headers: { "Cache-Control": "no-cache" } }));
    expect(reload.headers.get(CACHE_STATUS_HEADER)).toBe("miss");
    expect(await reload.json()).toMatchObject({ n: 2 });
    await settle();
    expect(upstream.requests).toHaveLength(2);
    // Следующий обычный запрос получает уже обновлённое
    const next = await call(get("/dictionaries"));
    expect(next.headers.get(CACHE_STATUS_HEADER)).toBe("hit");
    expect(await next.json()).toMatchObject({ n: 2 });
  });
});

describe("условные запросы (ETag)", () => {
  const etagged = () => api(() => ({ body: { n: 1 }, headers: { "Cache-Control": PUBLIC, ETag: '"abc"' } }));

  function setupEtag() {
    const fake = fakeCache();
    const upstream = etagged();
    const call = (request: Request) =>
      throughEdgeCache(
        request,
        (req) => {
          const target = new URL(req.url);
          target.pathname = target.pathname.replace(/^\/api/, "");
          return upstream.fetch(new Request(target, req));
        },
        { cache: fake.cache },
      );
    return { ...fake, upstream, call };
  }

  it("на промахе If-None-Match в API не уходит (304 в кэш не положить); браузеру — 304 по ETag полного ответа", async () => {
    const { call, upstream, store } = setupEtag();
    const res = await call(get("/dictionaries", { headers: { "If-None-Match": '"abc"' } }));
    expect(res.status).toBe(304);
    expect(res.headers.get("ETag")).toBe('"abc"');
    expect(res.headers.get(CACHE_STATUS_HEADER)).toBe("miss");
    expect(upstream.requests[0]?.headers.get("if-none-match")).toBeNull();
    // Полный ответ при этом в кэше есть
    expect(store.size).toBe(1);
  });

  it("на попадании: совпал ETag — 304 без тела, не совпал — 200", async () => {
    const { call } = setupEtag();
    await (await call(get("/dictionaries"))).arrayBuffer();

    const same = await call(get("/dictionaries", { headers: { "If-None-Match": 'W/"abc", "zzz"' } }));
    expect(same.status).toBe(304);
    expect(same.headers.get(CACHE_STATUS_HEADER)).toBe("hit");
    expect(await same.text()).toBe("");

    const other = await call(get("/dictionaries", { headers: { "If-None-Match": '"old"' } }));
    expect(other.status).toBe(200);
    expect(await other.json()).toMatchObject({ n: 1 });
  });
});

describe("воркер сайта", () => {
  function site(options: Parameters<typeof createSiteWorker>[0] = {}) {
    const fake = fakeCache();
    const worker = createSiteWorker({ apiCache: fake.cache, ...options });
    const env = { ASSETS: spaAssets(SPA_FILES), API: api() };
    const waited: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void waited.push(p) };
    const fetch = (path: string, init?: RequestInit) =>
      worker.fetch(new Request(`${ORIGIN}${path}`, init), env, ctx);
    return { ...fake, env, fetch, settle: () => Promise.all(waited) };
  }

  it("публичный GET /api/* кэшируется через ctx.waitUntil; страницы и статика — нет", async () => {
    const { fetch, env, settle, store } = site();
    await (await fetch("/api/catalog/categories")).arrayBuffer();
    await settle();
    const hit = await fetch("/api/catalog/categories");
    expect(hit.headers.get(CACHE_STATUS_HEADER)).toBe("hit");
    expect(env.API.requests).toHaveLength(1);

    await (await fetch("/")).arrayBuffer();
    await (await fetch("/assets/index.js")).arrayBuffer();
    await settle();
    expect([...store.keys()]).toEqual([`${ORIGIN}/api/catalog/categories`]);
  });

  it("запрос с Authorization идёт в API каждый раз", async () => {
    const { fetch, env, settle } = site();
    for (let i = 0; i < 2; i++) {
      await (await fetch("/api/vendor/me", { headers: { Authorization: "Bearer t" } })).arrayBuffer();
    }
    await settle();
    expect(env.API.requests).toHaveLength(2);
  });

  it("в разработке и с apiCache: false кэша нет", async () => {
    for (const options of [{ dev: true }, { apiCache: false as const }]) {
      const { fetch, env, settle, store } = site(options);
      await (await fetch("/api/catalog/categories")).arrayBuffer();
      await settle();
      const again = await fetch("/api/catalog/categories");
      expect(again.headers.get(CACHE_STATUS_HEADER)).toBeNull();
      expect(env.API.requests).toHaveLength(2);
      expect(store.size).toBe(0);
    }
  });
});
