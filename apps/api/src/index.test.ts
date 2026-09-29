// Приложение целиком, без базы: маршруты, формат ошибок и всё, что отсекается
// до первого запроса к Postgres. С базой — test/integration
import { afterEach, describe, expect, it, vi } from "vitest";
import { initDataFields, initDataFor, signInitData } from "./testing/init-data";
import { signLoginWidget } from "./testing/login-widget";
import { BOT_TOKEN, call, makeEnv } from "./testing/worker";

function login(body: unknown) {
  return call("/auth/telegram", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

afterEach(() => vi.restoreAllMocks());

describe("маршруты", () => {
  it("/health работает как раньше (без Hyperdrive — not_configured)", async () => {
    const { res } = await call("/health", {}, makeEnv({ HYPERDRIVE: undefined as unknown as Hyperdrive }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: "bayramm-api", db: "not_configured" });
  });

  it("неизвестный путь — 404 в едином формате", async () => {
    const { res } = await call("/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "Not found" } });
  });

  it("GET /me без токена — 401; пул базы закрывается после ответа", async () => {
    const { res, pending } = await call("/me");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "unauthorized", message: "Authentication required" } });
    expect(pending).toHaveLength(1);
  });

  it("POST /auth/logout без токена — 401", async () => {
    const { res } = await call("/auth/logout", { method: "POST" });
    expect(res.status).toBe(401);
  });
});

describe("POST /auth/telegram: отказ до базы", () => {
  it("тело не JSON или без initData — 400", async () => {
    for (const body of ["not json", {}, { initData: "" }, { initData: 42 }, [], "null"]) {
      const { res } = await login(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_request");
    }
  });

  it("слишком большое тело — 413", async () => {
    const { res } = await login({ initData: "x".repeat(40 * 1024) });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: { code: "payload_too_large", message: "Request body is too large" },
    });
  });

  it("подпись чужого бота — 401", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const initData = await initDataFor({ id: 100000001, first_name: "Test" }, { botToken: "999:other-bot" });
    const { res } = await login({ initData });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "unauthorized", message: "Invalid Telegram init data" },
    });
    expect(warn).toHaveBeenCalledWith("auth: initData rejected", "bad_hash");
  });

  it("поле изменено после подписи — 401", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const signed = await initDataFor({ id: 100000001, first_name: "Test" }, { botToken: BOT_TOKEN });
    const forged = signed.replace(encodeURIComponent('"id":100000001'), encodeURIComponent('"id":100000002'));
    expect(forged).not.toBe(signed);
    const { res } = await login({ initData: forged });
    expect(res.status).toBe(401);
  });

  it("устаревшая initData (старше часа) — 401", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const authDate = Math.floor(Date.now() / 1000) - 2 * 60 * 60;
    const initData = await signInitData(
      initDataFields({ id: 100000001, first_name: "Test" }, authDate),
      BOT_TOKEN,
    );
    const { res } = await login({ initData });
    expect(res.status).toBe(401);
    expect(warn).toHaveBeenCalledWith("auth: initData rejected", "expired");
  });

  it("без токена бота — 500, а не вход без проверки", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const initData = await initDataFor({ id: 100000001, first_name: "Test" }, { botToken: BOT_TOKEN });
    const { res } = await call(
      "/auth/telegram",
      { method: "POST", body: JSON.stringify({ initData }) },
      makeEnv({ TELEGRAM_BOT_TOKEN: "" }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: "internal_error", message: "Internal error" } });
  });

  it("без ID_HASH_KEY — 500 до записи в базу", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const initData = await initDataFor({ id: 100000001, first_name: "Test" }, { botToken: BOT_TOKEN });
    const { res } = await call(
      "/auth/telegram",
      { method: "POST", body: JSON.stringify({ initData }) },
      makeEnv({ ID_HASH_KEY: "short" }),
    );
    expect(res.status).toBe(500);
  });
});

function staffLogin(body: unknown, env = makeEnv()) {
  return call(
    "/auth/staff/telegram",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    env,
  );
}

const STAFF_USER = { id: 100000001, first_name: "Staff", username: "test_staff" };
const nowSeconds = () => Math.floor(Date.now() / 1000);

describe("POST /auth/staff/telegram: отказ до базы", () => {
  it("тело не JSON-объект — 400", async () => {
    for (const body of ["not json", [], "null", '"fields"', "42"]) {
      const { res } = await staffLogin(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_request");
    }
  });

  it("слишком большое тело — 413", async () => {
    const { res } = await staffLogin({ ...STAFF_USER, last_name: "x".repeat(40 * 1024) });
    expect(res.status).toBe(413);
  });

  it.each([
    ["без hash", async () => ({ ...STAFF_USER, auth_date: nowSeconds() }), "missing_hash"],
    ["подпись чужого бота", () => signLoginWidget(STAFF_USER, "999:other-bot"), "bad_hash"],
    [
      "id изменён после подписи",
      async () => ({ ...(await signLoginWidget(STAFF_USER, BOT_TOKEN)), id: "100000002" }),
      "bad_hash",
    ],
    ["старше 10 минут", () => signLoginWidget(STAFF_USER, BOT_TOKEN, nowSeconds() - 11 * 60), "expired"],
    [
      "вложенный объект",
      async () => ({ ...(await signLoginWidget(STAFF_USER, BOT_TOKEN)), extra: {} }),
      "malformed",
    ],
  ])("%s — 401, в базу не ходит", async (_name, fields, reason) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { res } = await staffLogin(await fields());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "unauthorized", message: "Invalid Telegram login data" },
    });
    expect(warn).toHaveBeenCalledWith("auth: login widget rejected", reason);
  });

  it("без токена бота — 500, а не вход без проверки", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fields = await signLoginWidget(STAFF_USER, BOT_TOKEN);
    const { res } = await staffLogin(fields, makeEnv({ TELEGRAM_BOT_TOKEN: "" }));
    expect(res.status).toBe(500);
  });

  it("без ID_HASH_KEY — 500 до записи в базу", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fields = await signLoginWidget(STAFF_USER, BOT_TOKEN);
    const { res } = await staffLogin(fields, makeEnv({ ID_HASH_KEY: "short" }));
    expect(res.status).toBe(500);
  });
});

describe("/staff без сессии", () => {
  it("GET /staff/me без токена — 401", async () => {
    const { res } = await call("/staff/me");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "unauthorized", message: "Authentication required" } });
  });

  it("кривой токен — 401 без запроса к базе", async () => {
    const { res } = await call("/staff/me", { headers: { Authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
  });
});
