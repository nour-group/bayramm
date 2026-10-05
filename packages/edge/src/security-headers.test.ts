import { describe, expect, it } from "vitest";
import { HSTS } from "./https";
import {
  contentSecurityPolicy,
  PERMISSIONS_POLICY,
  REFERRER_POLICY,
  securityHeaders,
  withSecurityHeaders,
} from "./security-headers";

/** CSP как словарь «директива → источники» */
function parseCsp(csp: string): Record<string, string[]> {
  return Object.fromEntries(
    csp.split(";").map((part) => {
      const [name = "", ...sources] = part.trim().split(/\s+/);
      return [name, sources];
    }),
  );
}

describe("Content-Security-Policy", () => {
  const csp = parseCsp(contentSecurityPolicy());

  it("всё только со своего origin", () => {
    expect(csp["default-src"]).toEqual(["'self'"]);
    expect(csp["script-src"]).toEqual(["'self'"]);
    expect(csp["style-src"]).toEqual(["'self'"]);
    expect(csp["connect-src"]).toEqual(["'self'"]);
    expect(csp["font-src"]).toEqual(["'self'"]);
    expect(csp["img-src"]).toEqual(["'self'", "data:", "blob:"]);
  });

  it("telegramWebApp добавляет только скрипт SDK Mini App", () => {
    const withSdk = parseCsp(contentSecurityPolicy({ telegramWebApp: true }));
    expect(withSdk["script-src"]).toEqual(["'self'", "https://telegram.org/js/telegram-web-app.js"]);
    for (const [name, sources] of Object.entries(withSdk)) {
      if (name !== "script-src") expect(sources).toEqual(csp[name]);
    }
  });

  it("turnstile добавляет только скрипт и фрейм challenges.cloudflare.com", () => {
    const withTurnstile = parseCsp(contentSecurityPolicy({ turnstile: true }));
    expect(withTurnstile["script-src"]).toEqual(["'self'", "https://challenges.cloudflare.com"]);
    expect(withTurnstile["frame-src"]).toEqual(["https://challenges.cloudflare.com"]);
    for (const [name, sources] of Object.entries(withTurnstile)) {
      if (name !== "script-src" && name !== "frame-src") expect(sources).toEqual(csp[name]);
    }
    expect(csp["frame-src"]).toBeUndefined();
  });

  it("виджет Telegram и Turnstile вместе — оба фрейма в одном frame-src", () => {
    const both = parseCsp(contentSecurityPolicy({ telegramLogin: true, turnstile: true }));
    expect(both["frame-src"]).toEqual(["https://oauth.telegram.org", "https://challenges.cloudflare.com"]);
  });

  it("imageOrigins добавляет источники только в img-src", () => {
    const origins = ["https://media.example", "https://media-staging.example"];
    const withImages = parseCsp(contentSecurityPolicy({ imageOrigins: origins }));
    expect(withImages["img-src"]).toEqual(["'self'", "data:", "blob:", ...origins]);
    for (const [name, sources] of Object.entries(withImages)) {
      if (name !== "img-src") expect(sources).toEqual(csp[name]);
    }
  });

  it("imageOrigins принимает только чистый https-origin", () => {
    for (const bad of [
      "https://media.example/",
      "https://media.example/path",
      "https://*.example",
      "https://media.example 'unsafe-inline'",
      "http://media.example",
      "media.example",
      "data:",
      "",
    ]) {
      expect(() => contentSecurityPolicy({ imageOrigins: [bad] }), bad).toThrow(TypeError);
    }
  });

  it("http-origin для картинок — только в dev", () => {
    const local = "http://localhost:8790";
    expect(() => contentSecurityPolicy({ imageOrigins: [local] })).toThrow(TypeError);
    expect(parseCsp(contentSecurityPolicy({ imageOrigins: [local], dev: true }))["img-src"]).toContain(local);
  });

  it("без встроенного кода, eval, плагинов и подмены base", () => {
    const all = Object.values(csp).flat();
    expect(all).not.toContain("'unsafe-inline'");
    expect(all).not.toContain("'unsafe-eval'");
    expect(all).not.toContain("*");
    expect(csp["object-src"]).toEqual(["'none'"]);
    expect(csp["base-uri"]).toEqual(["'none'"]);
    expect(csp["form-action"]).toEqual(["'self'"]);
  });

  it("по умолчанию страницу нельзя встроить во фрейм", () => {
    expect(csp["frame-ancestors"]).toEqual(["'none'"]);
  });

  it("frameAncestors разрешает только перечисленные origin", () => {
    const framed = parseCsp(contentSecurityPolicy({ frameAncestors: ["https://web.telegram.org"] }));
    expect(framed["frame-ancestors"]).toEqual(["https://web.telegram.org"]);
  });

  it("по умолчанию ни telegram.org, ни frame-src", () => {
    expect(contentSecurityPolicy()).not.toContain("telegram.org");
    expect(csp).not.toHaveProperty("frame-src");
  });

  it("telegramLogin добавляет только скрипт виджета и фрейм oauth.telegram.org", () => {
    const tg = parseCsp(contentSecurityPolicy({ telegramLogin: true }));
    expect(tg["script-src"]).toEqual(["'self'", "https://telegram.org/js/telegram-widget.js"]);
    expect(tg["frame-src"]).toEqual(["https://oauth.telegram.org"]);
    // Остальное — как без виджета: встраивать панель нельзя, запросы — только к себе
    const { "script-src": _s, "frame-src": _f, ...rest } = tg;
    const { "script-src": _s2, ...strictRest } = csp;
    expect(rest).toEqual(strictRest);
    expect(tg["frame-ancestors"]).toEqual(["'none'"]);
  });

  it("telegramLogin и dev вместе", () => {
    const both = parseCsp(contentSecurityPolicy({ telegramLogin: true, dev: true }));
    expect(both["script-src"]).toEqual([
      "'self'",
      "https://telegram.org/js/telegram-widget.js",
      "'unsafe-inline'",
    ]);
    expect(both["frame-src"]).toEqual(["https://oauth.telegram.org"]);
  });

  it("dev ослабляет только скрипты, стили и WebSocket", () => {
    const dev = parseCsp(contentSecurityPolicy({ dev: true }));
    expect(dev["script-src"]).toEqual(["'self'", "'unsafe-inline'"]);
    expect(dev["style-src"]).toEqual(["'self'", "'unsafe-inline'"]);
    expect(dev["connect-src"]).toEqual(["'self'", "ws:", "wss:"]);
    const { "script-src": _s, "style-src": _st, "connect-src": _c, ...rest } = dev;
    const { "script-src": _s2, "style-src": _st2, "connect-src": _c2, ...strictRest } = csp;
    expect(rest).toEqual(strictRest);
  });
});

describe("securityHeaders", () => {
  it("полный набор по умолчанию", () => {
    const headers = securityHeaders();
    expect(headers["Content-Security-Policy"]).toBe(contentSecurityPolicy());
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Referrer-Policy"]).toBe(REFERRER_POLICY);
    expect(headers["Permissions-Policy"]).toBe(PERMISSIONS_POLICY);
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["Strict-Transport-Security"]).toBe(HSTS);
  });

  it("сервер разработки (http) — без Strict-Transport-Security", () => {
    expect(securityHeaders({ dev: true })).not.toHaveProperty("Strict-Transport-Security");
  });

  it("Permissions-Policy запрещает камеру, микрофон, геолокацию и оплату", () => {
    for (const feature of ["camera", "microphone", "geolocation", "payment"])
      expect(PERMISSIONS_POLICY).toContain(`${feature}=()`);
  });

  it("при разрешённых frameAncestors X-Frame-Options не ставится", () => {
    expect(securityHeaders({ frameAncestors: ["https://web.telegram.org"] })).not.toHaveProperty(
      "X-Frame-Options",
    );
  });
});

describe("withSecurityHeaders", () => {
  it("сохраняет статус, тело и свои заголовки ответа", async () => {
    const original = new Response("<p>hi</p>", {
      status: 200,
      headers: { "content-type": "text/html", etag: '"1"' },
    });
    const res = withSecurityHeaders(original);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<p>hi</p>");
    expect(res.headers.get("content-type")).toBe("text/html");
    expect(res.headers.get("etag")).toBe('"1"');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("перекрывает чужой CSP своим", () => {
    const original = new Response("", { headers: { "content-security-policy": "default-src *" } });
    expect(withSecurityHeaders(original).headers.get("content-security-policy")).toBe(
      contentSecurityPolicy(),
    );
  });

  it("работает с 304 без тела и с редиректом", () => {
    const notModified = withSecurityHeaders(new Response(null, { status: 304 }));
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("x-frame-options")).toBe("DENY");

    const redirect = withSecurityHeaders(
      new Response(null, { status: 307, headers: { location: "/calendar" } }),
    );
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("location")).toBe("/calendar");
  });
});
