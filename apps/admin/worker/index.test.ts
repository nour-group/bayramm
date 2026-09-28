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
    const res = await get("/api/admin/vendors/3/approve?note=ok", {
      method: "POST",
      headers: { "cf-access-jwt-assertion": "jwt" },
    });
    expect(await res.json()).toMatchObject({
      method: "POST",
      path: "/admin/vendors/3/approve",
      search: "?note=ok",
    });
    const forwarded = env.API.requests[0];
    expect(forwarded?.url).toBe(`${ORIGIN}/admin/vendors/3/approve?note=ok`);
    expect(forwarded?.headers.get("cf-access-jwt-assertion")).toBe("jwt");
    expect(env.ASSETS.requests).toEqual([]);
  });

  it.each(["/", "/vendors", "/moderation", "/requests", "/clients", "/vendors/3"])(
    "%s — index.html из ASSETS (фолбэк SPA)",
    async (path) => {
      const { env, get } = setup();
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<div id="root">');
      expect(env.API.requests).toEqual([]);
    },
  );

  it("HTML со строгими заголовками безопасности", async () => {
    const { get } = setup();
    const { headers } = await get("/moderation");
    const csp = headers.get("content-security-policy") ?? "";
    expect(csp).toBe(contentSecurityPolicy());
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(headers.get("x-frame-options")).toBe("DENY");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(headers.get("permissions-policy")).toContain("camera=()");
  });
});
