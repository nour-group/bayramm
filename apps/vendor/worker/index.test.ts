import { contentSecurityPolicy } from "@bayramm/edge";
import { echoApi, SPA_FILES, spaAssets } from "@bayramm/edge/testing";
import { mediaImageOrigins } from "@bayramm/media";
import { describe, expect, it, vi } from "vitest";

// Под Vitest import.meta.env.DEV = true; проверяем воркер таким, каким он будет в сборке
vi.stubEnv("DEV", false);
const { default: worker } = await import("./index");

const ORIGIN = "https://vendor.bayramm.uz";

function setup() {
  const env = { ASSETS: spaAssets(SPA_FILES), API: echoApi() };
  const get = (path: string, init?: RequestInit) => worker.fetch(new Request(`${ORIGIN}${path}`, init), env);
  return { env, get };
}

describe("воркер кабинета вендора", () => {
  it("/api/* уходит в API без префикса: метод, query и тело сохраняются", async () => {
    const { env, get } = setup();
    const res = await get("/api/vendor/requests/7?status=new", { method: "POST", body: "ok" });
    expect(await res.json()).toEqual({
      method: "POST",
      path: "/vendor/requests/7",
      search: "?status=new",
      body: "ok",
    });
    expect(env.API.requests.map((r) => r.url)).toEqual([`${ORIGIN}/vendor/requests/7?status=new`]);
    expect(env.ASSETS.requests).toEqual([]);
  });

  it.each(["/", "/requests", "/calendar", "/card", "/login", "/calendar/2026-10"])(
    "%s — index.html из ASSETS (фолбэк SPA)",
    async (path) => {
      const { env, get } = setup();
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html");
      expect(await res.text()).toContain('<div id="root">');
      expect(env.API.requests).toEqual([]);
    },
  );

  it("HTML с заголовками безопасности", async () => {
    const { get } = setup();
    const { headers } = await get("/calendar");
    expect(headers.get("content-security-policy")).toBe(
      contentSecurityPolicy({ imageOrigins: mediaImageOrigins() }),
    );
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(headers.get("permissions-policy")).toContain("camera=()");
    expect(headers.get("x-frame-options")).toBe("DENY");
  });

  it("в сборке CSP строгий: без встроенного кода, фрейм запрещён", async () => {
    const { get } = setup();
    const csp = (await get("/")).headers.get("content-security-policy") ?? "";
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("ws:");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain(
      "img-src 'self' data: blob: https://media-staging.bayramm.uz https://media.bayramm.uz;",
    );
    expect(csp).not.toContain("localhost");
  });
});
