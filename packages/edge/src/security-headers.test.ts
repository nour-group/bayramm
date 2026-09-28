import { describe, expect, it } from "vitest";
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
