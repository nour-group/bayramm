import { contentSecurityPolicy } from "@bayramm/edge";
import { echoApi, SPA_FILES, spaAssets } from "@bayramm/edge/testing";
import { describe, expect, it, vi } from "vitest";

// Под Vitest import.meta.env.DEV = true; проверяем воркер таким, каким он будет в сборке
vi.stubEnv("DEV", false);
const { default: worker } = await import("./index");

const ORIGIN = "https://admin.example";

function setup() {
  const env = { ASSETS: spaAssets(SPA_FILES), API: echoApi() };
  const get = (path: string, init?: RequestInit) => worker.fetch(new Request(`${ORIGIN}${path}`, init), env);
  return { env, get };
}

describe("воркер панели оператора", () => {
  it("/api/* уходит в API без префикса, заголовки запроса сохраняются", async () => {
    const { env, get } = setup();
    const res = await get("/api/auth/staff/telegram?x=1", {
      method: "POST",
      headers: { authorization: "Bearer token" },
      body: '{"id":"1"}',
    });
    expect(await res.json()).toMatchObject({
      method: "POST",
      path: "/auth/staff/telegram",
      search: "?x=1",
      body: '{"id":"1"}',
    });
    const forwarded = env.API.requests[0];
    expect(forwarded?.url).toBe(`${ORIGIN}/auth/staff/telegram?x=1`);
    expect(forwarded?.headers.get("authorization")).toBe("Bearer token");
    expect(env.ASSETS.requests).toEqual([]);
  });

  it.each([
    "/",
    "/vendors",
    "/moderation",
    "/requests",
    "/clients",
    "/vendors/3",
    "/login",
    "/login/telegram?id=1&auth_date=2&hash=3",
  ])("%s — index.html из ASSETS (фолбэк SPA)", async (path) => {
    const { env, get } = setup();
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="root">');
    expect(env.API.requests).toEqual([]);
  });

  it("HTML со строгими заголовками; из внешнего — только виджет входа Telegram", async () => {
    const { get } = setup();
    const { headers } = await get("/login");
    const csp = headers.get("content-security-policy") ?? "";
    expect(csp).toBe(contentSecurityPolicy({ telegramLogin: true }));
    expect(csp).toContain("script-src 'self' https://telegram.org/js/telegram-widget.js;");
    expect(csp).toContain("frame-src https://oauth.telegram.org;");
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("connect-src 'self';");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(headers.get("x-frame-options")).toBe("DENY");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(headers.get("permissions-policy")).toContain("camera=()");
  });
});
