import { describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "./security-headers";
import { createSiteWorker } from "./site-worker";
import { echoApi, SPA_FILES, spaAssets } from "./testing";

const ORIGIN = "https://app.example";

function setup(options: Parameters<typeof createSiteWorker>[0] = {}) {
  const env = { ASSETS: spaAssets(SPA_FILES), API: echoApi() };
  const worker = createSiteWorker(options);
  const get = (path: string, init?: RequestInit) => worker.fetch(new Request(`${ORIGIN}${path}`, init), env);
  return { env, get };
}

describe("createSiteWorker", () => {
  it("/api/* уходит в API без префикса и не трогает статику", async () => {
    const { env, get } = setup();
    const res = await get("/api/health?full=1");
    expect(await res.json()).toMatchObject({ path: "/health", search: "?full=1" });
    expect(env.API.requests.map((r) => r.url)).toEqual([`${ORIGIN}/health?full=1`]);
    expect(env.ASSETS.requests).toEqual([]);
  });

  it("ответ API отдаётся как есть: заголовки ему ставит само API", async () => {
    const { get } = setup();
    const res = await get("/api/health");
    expect(res.headers.get("content-security-policy")).toBeNull();
  });

  it("неизвестный путь — index.html из ASSETS (фолбэк SPA) с заголовками", async () => {
    const { env, get } = setup();
    const res = await get("/calendar/2026-10");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html");
    expect(await res.text()).toContain('<div id="root">');
    expect(res.headers.get("content-security-policy")).toBe(contentSecurityPolicy());
    // Путь не переписывается: решение о фолбэке остаётся за ASSETS
    expect(env.ASSETS.requests.map((r) => r.url)).toEqual([`${ORIGIN}/calendar/2026-10`]);
    expect(env.API.requests).toEqual([]);
  });

  it("похожие на API пути остаются в SPA", async () => {
    const { env, get } = setup();
    await get("/apix");
    await get("/api-docs");
    expect(env.API.requests).toEqual([]);
    expect(env.ASSETS.requests).toHaveLength(2);
  });

  it("файлы сборки тоже получают nosniff", async () => {
    const { get } = setup();
    const res = await get("/assets/index.js");
    expect(res.headers.get("content-type")).toBe("text/javascript");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("before отвечает раньше API и статики", async () => {
    const { env, get } = setup({
      before: (url) => (url.pathname === "/old" ? Response.redirect(`${ORIGIN}/new`, 301) : null),
    });
    const res = await get("/old");
    expect(res.status).toBe(301);
    expect(env.ASSETS.requests).toEqual([]);
    expect((await get("/")).status).toBe(200);
  });

  it("параметры безопасности доходят до заголовков", async () => {
    const { get } = setup({ frameAncestors: ["https://web.telegram.org"] });
    const res = await get("/");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors https://web.telegram.org");
    expect(res.headers.get("x-frame-options")).toBeNull();
  });
});
