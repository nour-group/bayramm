// Хаб входа без базы: разбор запросов, PKCE, origin приложений и отказы до базы.
// С базой (выдача, погашение, срок, чужой origin) — test/integration/accounts.test.ts
import { describe, expect, it } from "vitest";
import { call, makeEnv } from "../testing/worker";
import { appOrigin, parseHubCodeRequest, parseHubExchange, pkceChallenge } from "./hub";

const STATE = "s".repeat(22);
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

describe("pkceChallenge", () => {
  it("S256 по RFC 7636 (приложение B)", async () => {
    expect(await pkceChallenge(VERIFIER)).toBe(CHALLENGE);
  });
});

describe("appOrigin", () => {
  it("origin кабинета и панели — из переменных окружения, без пути", () => {
    const env = {
      VENDOR_APP_URL: "https://vendor.example.test/",
      ADMIN_APP_URL: "https://admin.example.test",
    };
    expect(appOrigin(env as never, "vendor")).toBe("https://vendor.example.test");
    expect(appOrigin(env as never, "admin")).toBe("https://admin.example.test");
  });
});

describe("parseHubCodeRequest", () => {
  it("приложение, state и challenge", () => {
    expect(parseHubCodeRequest({ app: "vendor", state: STATE, codeChallenge: CHALLENGE })).toEqual({
      app: "vendor",
      state: STATE,
      codeChallenge: CHALLENGE,
    });
  });

  it.each([
    ["клиентское приложение кода не получает", { app: "web", state: STATE, codeChallenge: CHALLENGE }, "app"],
    ["короткий state", { app: "vendor", state: "abc", codeChallenge: CHALLENGE }, "state"],
    [
      "state с посторонними символами",
      { app: "vendor", state: `${STATE}&x=1`, codeChallenge: CHALLENGE },
      "state",
    ],
    ["challenge не base64url-43", { app: "vendor", state: STATE, codeChallenge: "plain" }, "codeChallenge"],
  ])("%s — 400", (_name, body, field) => {
    expect(() => parseHubCodeRequest(body)).toThrow(
      expect.objectContaining({ status: 400, code: "invalid_request", details: [field] }),
    );
  });
});

describe("parseHubExchange", () => {
  const code = "c".repeat(43);

  it("кривой код, verifier или state — тот же 400 invalid_code, что и неверный", () => {
    for (const body of [
      { app: "vendor", code: "short", codeVerifier: VERIFIER, state: STATE },
      { app: "vendor", code, codeVerifier: "short", state: STATE },
      { app: "vendor", code, codeVerifier: VERIFIER, state: "x" },
    ]) {
      expect(() => parseHubExchange(body)).toThrow(
        expect.objectContaining({ status: 400, code: "invalid_code" }),
      );
    }
    expect(parseHubExchange({ app: "admin", code, codeVerifier: VERIFIER, state: STATE })).toEqual({
      app: "admin",
      code,
      codeVerifier: VERIFIER,
      state: STATE,
    });
  });
});

describe("маршруты хаба без базы", () => {
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    call(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  it("код хаба — только с сессией: без неё 401", async () => {
    const { res } = await post("/auth/hub/code", { app: "vendor", state: STATE, codeChallenge: CHALLENGE });
    expect(res.status).toBe(401);
  });

  it("обмен кривого кода — 400 без запроса к базе", async () => {
    const { res } = await post(
      "/auth/hub/exchange",
      { app: "vendor", code: "nope", codeVerifier: VERIFIER, state: STATE },
      { Origin: "http://localhost:5174" },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_code");
  });

  it("повышение до сотрудника — только с сессией: без неё 401", async () => {
    const { res } = await call("/auth/staff/elevate", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("ответы входа не кэшируются", async () => {
    const { res } = await call("/auth/staff/elevate", { method: "POST" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("вход по телефону без базы", () => {
  const send = (body: unknown, env = makeEnv()) =>
    call(
      "/auth/phone/send",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      env,
    );

  it("провайдера нет — 503 phone_unavailable", async () => {
    const { res } = await send({ phone: "+998001234567" }, makeEnv({ OTP_PROVIDER: "off" as never }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("phone_unavailable");
  });

  it("не узбекский номер — 400 invalid_phone", async () => {
    for (const phone of ["+7 900 123 45 67", "12345", 998001234567]) {
      const { res } = await send({ phone });
      expect(res.status, String(phone)).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_phone");
    }
  });

  it("код не из 6 цифр — 400 otp_invalid до базы", async () => {
    const { res } = await call("/auth/phone/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "+998001234567", code: "12" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("otp_invalid");
  });
});
