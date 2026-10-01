import { describe, expect, it } from "vitest";
import {
  CACHE_IMMUTABLE,
  CACHE_NONE,
  CACHE_REVALIDATE,
  CACHE_STATIC,
  cacheControlFor,
  isMissingAsset,
  missingAsset,
} from "./cache-headers";
import { createSiteWorker } from "./site-worker";
import { echoApi, recordingFetcher, SPA_FILES, spaAssets } from "./testing";

const ORIGIN = "https://app.example";
const response = (type: string, status = 200) =>
  new Response(status === 304 ? null : "x", { status, headers: { "content-type": type } });

describe("cacheControlFor", () => {
  it("файлы сборки — год и immutable, в том числе 304", () => {
    expect(cacheControlFor("/assets/index-Ab12.js", response("text/javascript"))).toBe(CACHE_IMMUTABLE);
    expect(cacheControlFor("/assets/manrope-latin-Cq3x8a.woff2", response("font/woff2"))).toBe(
      CACHE_IMMUTABLE,
    );
    expect(cacheControlFor("/assets/index-Ab12.js", new Response(null, { status: 304 }))).toBe(
      CACHE_IMMUTABLE,
    );
  });

  it("страница — со сверкой; файлы без хэша — со сверкой, шрифты и картинки — сутки", () => {
    expect(cacheControlFor("/", response("text/html; charset=utf-8"))).toBe(CACHE_REVALIDATE);
    expect(cacheControlFor("/calendar/2026-10", new Response(null, { status: 304 }))).toBe(CACHE_REVALIDATE);
    expect(cacheControlFor("/boot.js", response("text/javascript"))).toBe(CACHE_REVALIDATE);
    expect(cacheControlFor("/robots.txt", response("text/plain"))).toBe(CACHE_REVALIDATE);
    expect(cacheControlFor("/og.png", response("image/png"))).toBe(CACHE_STATIC);
    expect(cacheControlFor("/favicon.ico", response("image/x-icon"))).toBe(CACHE_STATIC);
  });

  it("ошибки — как есть", () => {
    expect(cacheControlFor("/assets/index.js", response("text/plain", 404))).toBeNull();
    expect(cacheControlFor("/", response("text/plain", 500))).toBeNull();
  });

  it("фолбэк SPA под адресом файла сборки — «нет файла»", () => {
    expect(isMissingAsset("/assets/old-Zz99.js", response("text/html"))).toBe(true);
    expect(isMissingAsset("/assets/index.js", response("text/javascript"))).toBe(false);
    expect(isMissingAsset("/calendar", response("text/html"))).toBe(false);
    const missing = missingAsset();
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe(CACHE_NONE);
  });
});

describe("createSiteWorker: кэш", () => {
  function setup(dev = false) {
    const env = { ASSETS: spaAssets(SPA_FILES), API: echoApi() };
    const worker = createSiteWorker({ dev });
    const get = (path: string) => worker.fetch(new Request(`${ORIGIN}${path}`), env);
    return { env, get };
  }

  it("файл сборки — immutable, заголовки безопасности на месте", async () => {
    const { get } = setup();
    for (const path of ["/assets/index.js", "/assets/manrope-latin-Cq3x8a.woff2"]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("cache-control"), path).toBe(CACHE_IMMUTABLE);
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
    }
  });

  it("страница и фолбэк SPA — no-cache, ETag остаётся для сверки", async () => {
    const { get } = setup();
    for (const path of ["/", "/calendar/2026-10"]) {
      const res = await get(path);
      expect(res.headers.get("content-type"), path).toBe("text/html");
      expect(res.headers.get("cache-control"), path).toBe(CACHE_REVALIDATE);
      expect(res.headers.get("etag"), path).not.toBeNull();
      expect(res.headers.get("content-security-policy"), path).toContain("default-src 'self'");
    }
  });

  it("файлы public без хэша: картинка — сутки, остальное — со сверкой", async () => {
    const { get } = setup();
    expect((await get("/og.png")).headers.get("cache-control")).toBe(CACHE_STATIC);
    expect((await get("/robots.txt")).headers.get("cache-control")).toBe(CACHE_REVALIDATE);
  });

  it("нет такого файла сборки — 404 без кэша, а не index.html", async () => {
    const { get } = setup();
    const res = await get("/assets/index-old.js");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe(CACHE_NONE);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).not.toContain('<div id="root">');
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  });

  it("304 файла сборки — с тем же Cache-Control", async () => {
    const assets = recordingFetcher(() => new Response(null, { status: 304, headers: { etag: '"1"' } }));
    const worker = createSiteWorker();
    const res = await worker.fetch(new Request(`${ORIGIN}/assets/index.js`), { ASSETS: assets });
    expect(res.status).toBe(304);
    expect(res.headers.get("cache-control")).toBe(CACHE_IMMUTABLE);
  });

  it("API кэш не трогает", async () => {
    const { get } = setup();
    expect((await get("/api/health")).headers.get("cache-control")).toBeNull();
  });

  it("сервер разработки: кэша нет, фолбэк SPA — как отдал ASSETS", async () => {
    const { get } = setup(true);
    expect((await get("/assets/index.js")).headers.get("cache-control")).toBeNull();
    expect((await get("/assets/index-old.js")).status).toBe(200);
  });
});
