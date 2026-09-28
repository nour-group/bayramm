import { describe, expect, it } from "vitest";
import { apiPath, proxyToApi } from "./api-proxy";
import { echoApi } from "./testing";

describe("apiPath", () => {
  it.each([
    ["/api", "/"],
    ["/api/", "/"],
    ["/api/health", "/health"],
    ["/api/v1/vendors/42", "/v1/vendors/42"],
  ])("%s → %s", (input, expected) => {
    expect(apiPath(input)).toBe(expected);
  });

  it.each(["/", "/apix", "/api-docs", "/calendar", "/assets/api.js", "/API/health"])(
    "%s — не API",
    (input) => {
      expect(apiPath(input)).toBeNull();
    },
  );
});

describe("proxyToApi", () => {
  it("снимает префикс и сохраняет query, метод, заголовки и тело", async () => {
    const api = echoApi();
    const request = new Request("https://vendor.example/api/requests/7?status=new", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer t" },
      body: '{"reply":"ok"}',
    });
    const res = await proxyToApi(request, "/requests/7", api);
    expect(await res.json()).toEqual({
      method: "POST",
      path: "/requests/7",
      search: "?status=new",
      body: '{"reply":"ok"}',
    });
    const forwarded = api.requests[0];
    expect(forwarded?.url).toBe("https://vendor.example/requests/7?status=new");
    expect(forwarded?.headers.get("authorization")).toBe("Bearer t");
  });

  it("без привязки — 503 с понятной ошибкой", async () => {
    const res = await proxyToApi(new Request("https://vendor.example/api/health"), "/health", undefined);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "api_unavailable" });
  });
});
