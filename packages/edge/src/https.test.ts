import { describe, expect, it } from "vitest";
import { HSTS, httpsRedirect, isLoopback } from "./https";

describe("httpsRedirect", () => {
  it("GET и HEAD по http — 301 на тот же адрес с https", () => {
    for (const method of ["GET", "HEAD"]) {
      const res = httpsRedirect(new Request("http://bayramm.uz/catalog?category=car", { method }));
      expect(res?.status, method).toBe(301);
      expect(res?.headers.get("location")).toBe("https://bayramm.uz/catalog?category=car");
    }
  });

  it("POST и прочие — 308: метод и тело сохраняются", () => {
    const res = httpsRedirect(new Request("http://api.bayramm.uz/auth/phone/send", { method: "POST" }));
    expect(res?.status).toBe(308);
    expect(res?.headers.get("location")).toBe("https://api.bayramm.uz/auth/phone/send");
  });

  it("по https — ничего", () => {
    expect(httpsRedirect(new Request("https://bayramm.uz/"))).toBeNull();
  });

  it("свой компьютер по http — без редиректа (wrangler dev, тесты)", () => {
    for (const host of ["localhost:8787", "127.0.0.1:5173", "[::1]:5174", "web.localhost"]) {
      expect(httpsRedirect(new Request(`http://${host}/`)), host).toBeNull();
    }
    expect(isLoopback("localhost.bayramm.uz")).toBe(false);
  });

  it("HSTS — год, без includeSubDomains и preload", () => {
    expect(HSTS).toBe("max-age=31536000");
  });
});
