import { contentSecurityPolicy } from "@bayramm/edge";
import { echoApi, SPA_FILES, spaAssets } from "@bayramm/edge/testing";
import { mediaImageOrigins } from "@bayramm/media";
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
    const res = await get("/api/auth/staff/webapp?x=1", {
      method: "POST",
      headers: { authorization: "Bearer token" },
      body: '{"id":"1"}',
    });
    expect(await res.json()).toMatchObject({
      method: "POST",
      path: "/auth/staff/webapp",
      search: "?x=1",
      body: '{"id":"1"}',
    });
    const forwarded = env.API.requests[0];
    expect(forwarded?.url).toBe(`${ORIGIN}/auth/staff/webapp?x=1`);
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
    "/auth/callback?code=abc&state=def",
  ])("%s — index.html из ASSETS (фолбэк SPA)", async (path) => {
    const { env, get } = setup();
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="root">');
    expect(env.API.requests).toEqual([]);
  });

  it("HTML со строгими заголовками; из внешнего — только SDK Mini App, фрейм — только Telegram Web", async () => {
    const { get } = setup();
    const { headers } = await get("/login");
    const csp = headers.get("content-security-policy") ?? "";
    expect(csp).toBe(
      contentSecurityPolicy({
        telegramWebApp: true,
        frameAncestors: ["https://web.telegram.org"],
        imageOrigins: mediaImageOrigins(),
      }),
    );
    expect(csp).toContain(
      "img-src 'self' data: blob: https://media-staging.bayramm.uz https://media.bayramm.uz;",
    );
    expect(csp).not.toContain("localhost");
    expect(csp).toContain("script-src 'self' https://telegram.org/js/telegram-web-app.js;");
    expect(csp).not.toContain("telegram-widget.js");
    expect(csp).not.toContain("oauth.telegram.org");
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("connect-src 'self';");
    expect(csp).toContain("frame-ancestors https://web.telegram.org");
    expect(headers.get("x-frame-options")).toBeNull();
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(headers.get("permissions-policy")).toContain("camera=()");
  });
});
