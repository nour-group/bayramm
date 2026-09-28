import { contentSecurityPolicy } from "@bayramm/edge";
import { echoApi, SPA_FILES, spaAssets } from "@bayramm/edge/testing";
import { describe, expect, it, vi } from "vitest";

// Под Vitest import.meta.env.DEV = true; проверяем воркер таким, каким он будет в сборке
vi.stubEnv("DEV", false);
const { default: worker } = await import("./index");

const ORIGIN = "https://bayramm.uz";

function setup() {
  const env = { ASSETS: spaAssets(SPA_FILES), API: echoApi() };
  const get = (path: string, init?: RequestInit) => worker.fetch(new Request(`${ORIGIN}${path}`, init), env);
  return { env, get };
}

describe("воркер клиента", () => {
  it("старые ссылки taklifnoma по-прежнему уходят на поддомен", async () => {
    const { env, get } = setup();
    const res = await get("/classic.html?to=Aziza");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://taklifnoma.bayramm.uz/classic.html?to=Aziza");
    expect(env.ASSETS.requests).toEqual([]);
  });

  it("/api/* уходит в API без префикса", async () => {
    const { env, get } = setup();
    const res = await get("/api/health?x=1");
    expect(await res.json()).toMatchObject({ method: "GET", path: "/health", search: "?x=1" });
    expect(env.API.requests.map((r) => r.url)).toEqual([`${ORIGIN}/health?x=1`]);
  });

  it("неизвестный путь — index.html (фолбэк SPA) с заголовками безопасности", async () => {
    const { get } = setup();
    const res = await get("/vendor/42");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="root">');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("permissions-policy")).toContain("camera=()");
  });

  it("в сборке CSP строгий, встраивать может только Telegram Web", async () => {
    const { get } = setup();
    const csp = (await get("/")).headers.get("content-security-policy");
    expect(csp).toBe(contentSecurityPolicy({ frameAncestors: ["https://web.telegram.org"] }));
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).toContain("frame-ancestors https://web.telegram.org");
  });
});
