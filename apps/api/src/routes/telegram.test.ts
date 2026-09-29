// GET /telegram/bot и POST /telegram/sync: Telegram подменён fetch'ем, Cache API — картой
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { BOT_TEXTS } from "../telegram/bot-profile";
import { BOT_TOKEN, call, makeEnv } from "../testing/worker";

const BOT_USERNAME = "example_test_bot";
const SYNC_KEY = "k".repeat(48);
const TG_PREFIX = `https://api.telegram.org/bot${BOT_TOKEN}/`;

interface TgCall {
  method: string;
  params: Record<string, unknown>;
}

type TgHandler = (params: Record<string, unknown>) => Response | Promise<Response>;

let tgCalls: TgCall[];
let consoleSpies: MockInstance[];

const ok =
  (result: unknown): TgHandler =>
  () =>
    Response.json({ ok: true, result });
const tgError =
  (code: number, description: string): TgHandler =>
  () =>
    Response.json({ ok: false, error_code: code, description }, { status: code });
const me = ok({ id: 123456, is_bot: true, first_name: "Test", username: BOT_USERNAME });

// Telegram по методу из адреса; метод без обработчика — ok: true, result: true (как у set*)
function mockTelegram(handlers: Record<string, TgHandler> = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (!url.startsWith(TG_PREFIX)) throw new Error(`неожиданный запрос: ${url}`);
    const method = url.slice(TG_PREFIX.length);
    const params = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
    tgCalls.push({ method, params });
    return (handlers[method] ?? ok(true))(params);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// Cache API: caches.default поверх карты по адресу ключа
function mockCache() {
  const store = new Map<string, Response>();
  const cache = {
    match: vi.fn(async (request: Request) => store.get(request.url)?.clone()),
    put: vi.fn(async (request: Request, response: Response) => {
      store.set(request.url, response);
    }),
  };
  vi.stubGlobal("caches", { default: cache });
  return { store, cache };
}

// Всё, что попало в консоль, одной строкой — как это увидел бы лог воркера
const logged = () => consoleSpies.map((spy) => inspect(spy.mock.calls, { depth: 10 })).join("\n");

beforeEach(() => {
  tgCalls = [];
  // Без Cache API по умолчанию; тесты кэша ставят свой (mockCache)
  vi.stubGlobal("caches", undefined);
  consoleSpies = (["log", "info", "warn", "error"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(() => {}),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const getBot = (env = makeEnv()) => call("/telegram/bot", {}, env);

describe("GET /telegram/bot", () => {
  it("имя бота из getMe и адрес Mini App из WEB_APP_URL", async () => {
    mockTelegram({ getMe: me });
    const { res } = await getBot();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ username: BOT_USERNAME, miniAppUrl: "http://localhost:5173" });
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(tgCalls).toEqual([{ method: "getMe", params: {} }]);
  });

  it("адрес Mini App — без завершающего «/»", async () => {
    mockTelegram({ getMe: me });
    const env = makeEnv({ WEB_APP_URL: "https://bayramm.uz/" as Env["WEB_APP_URL"] });
    const { res } = await getBot(env);
    expect(((await res.json()) as { miniAppUrl: string }).miniAppUrl).toBe("https://bayramm.uz");
  });

  it("кэш: второй запрос не ходит в Telegram; запись на час, ключ — окружение и id бота", async () => {
    const fetchMock = mockTelegram({ getMe: me });
    const { store, cache } = mockCache();

    const first = await getBot();
    expect(await first.res.json()).toMatchObject({ username: BOT_USERNAME });
    expect(cache.put).toHaveBeenCalledTimes(1);
    const [key, entry] = cache.put.mock.calls[0] ?? [];
    expect(key?.url).toBe("http://localhost/__cache/telegram-bot/local/123456");
    expect(key?.url).not.toContain(BOT_TOKEN);
    expect(entry?.headers.get("cache-control")).toBe("max-age=3600");

    const second = await getBot();
    expect(await second.res.json()).toEqual({ username: BOT_USERNAME, miniAppUrl: "http://localhost:5173" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Другое окружение — свой ключ
    await getBot(makeEnv({ APP_ENV: "staging" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect([...store.keys()]).toEqual([
      "http://localhost/__cache/telegram-bot/local/123456",
      "http://localhost/__cache/telegram-bot/staging/123456",
    ]);
  });

  it("другой бот (сменили токен) — старое имя из кэша не достаётся", async () => {
    const fetchMock = mockTelegram({ getMe: me });
    mockCache();
    await getBot();
    await getBot(makeEnv({ TELEGRAM_BOT_TOKEN: "654321:other-unit-test-token" }));
    // Второй раз — снова getMe, уже токеном другого бота (mockTelegram его не знает — 503, не важно)
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "https://api.telegram.org/bot654321:other-unit-test-token/getMe",
    );
  });

  it("Cache API сломан — имя всё равно отдаётся", async () => {
    mockTelegram({ getMe: me });
    vi.stubGlobal("caches", {
      default: {
        match: () => Promise.reject(new Error("cache down")),
        put: () => Promise.reject(new Error("cache down")),
      },
    });
    const { res } = await getBot();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ username: BOT_USERNAME });
  });

  it.each([
    ["Telegram ответил ошибкой", { getMe: tgError(401, "Unauthorized") }],
    ["getMe без имени", { getMe: ok({ id: 1, is_bot: true, first_name: "Test" }) }],
    ["getMe не бота", { getMe: ok({ id: 1, is_bot: false, first_name: "Test", username: "someone" }) }],
    ["не JSON", { getMe: () => new Response("<html>502</html>", { status: 502 }) }],
  ])("%s — 503 в едином формате, в кэш не пишется", async (_name, handlers) => {
    mockTelegram(handlers);
    const { cache } = mockCache();
    const { res } = await getBot();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: { code: "telegram_unavailable", message: "Telegram is temporarily unavailable" },
    });
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("сеть недоступна — 503; ни токена, ни адреса Telegram в ответе и в логах", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        throw new TypeError(`fetch failed: ${String(input)}`);
      }),
    );
    const { res } = await getBot();
    const body = await res.text();
    expect(res.status).toBe(503);
    for (const secret of [BOT_TOKEN, "api.telegram.org"]) {
      expect(body).not.toContain(secret);
      expect(logged()).not.toContain(secret);
    }
    expect(logged()).toContain("telegram.bot: getMe failed");
  });

  it("описание ошибки от Telegram — только в лог, наружу не уходит; токен вырезан и из лога", async () => {
    mockTelegram({ getMe: tgError(401, `Unauthorized: ${BOT_TOKEN}`) });
    const { res } = await getBot();
    const body = await res.text();
    expect(body).not.toContain("Unauthorized");
    expect(body).not.toContain(BOT_TOKEN);
    expect(logged()).toContain("Unauthorized: [token]");
    expect(logged()).not.toContain(BOT_TOKEN);
  });

  it("без токена бота — 500 без запроса к Telegram", async () => {
    const fetchMock = mockTelegram({ getMe: me });
    const { res } = await getBot(makeEnv({ TELEGRAM_BOT_TOKEN: "" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: "internal_error", message: "Internal error" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function sync(authorization: string | undefined, env = makeEnv({ TELEGRAM_SYNC_KEY: SYNC_KEY })) {
  const headers: Record<string, string> = authorization === undefined ? {} : { Authorization: authorization };
  return call("/telegram/sync", { method: "POST", headers }, env);
}

describe("POST /telegram/sync: доступ", () => {
  it("ключ не задан — 404, как будто маршрута нет", async () => {
    const fetchMock = mockTelegram();
    for (const env of [makeEnv(), makeEnv({ TELEGRAM_SYNC_KEY: undefined as unknown as string })]) {
      const { res } = await sync(`Bearer ${SYNC_KEY}`, env);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: "not_found", message: "Not found" } });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["без заголовка", undefined],
    ["чужой ключ", `Bearer ${"x".repeat(48)}`],
    ["ключ с лишним символом", `Bearer ${SYNC_KEY}k`],
    ["ключ без Bearer", SYNC_KEY],
    ["Basic", `Basic ${SYNC_KEY}`],
    ["лишнее после ключа", `Bearer ${SYNC_KEY} extra`],
  ])("%s — 401 без запросов к Telegram", async (_name, authorization) => {
    const fetchMock = mockTelegram();
    const { res } = await sync(authorization);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "unauthorized", message: "Authentication required" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("GET на /telegram/sync — 404", async () => {
    const { res } = await call("/telegram/sync", {}, makeEnv({ TELEGRAM_SYNC_KEY: SYNC_KEY }));
    expect(res.status).toBe(404);
  });

  it("ключ короче 32 символов — ошибка настройки (500), а не вход", async () => {
    const fetchMock = mockTelegram();
    const short = "k".repeat(31);
    const { res } = await sync(`Bearer ${short}`, makeEnv({ TELEGRAM_SYNC_KEY: short }));
    expect(res.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("POST /telegram/sync: настройка бота", () => {
  it("верный ключ — все вызовы по порядку с ожидаемыми параметрами, отчёт по каждому", async () => {
    mockTelegram();
    const env = makeEnv({ TELEGRAM_SYNC_KEY: SYNC_KEY, WEB_APP_URL: "https://staging.bayramm.uz" });
    const { res } = await sync(`Bearer ${SYNC_KEY}`, env);
    expect(res.status).toBe(200);

    const start = (lang: "ru" | "uz") => [{ command: "start", description: BOT_TEXTS[lang].startCommand }];
    expect(tgCalls).toEqual([
      { method: "setMyCommands", params: { commands: start("ru") } },
      { method: "setMyCommands", params: { commands: start("ru"), language_code: "ru" } },
      { method: "setMyCommands", params: { commands: start("uz"), language_code: "uz" } },
      { method: "setMyDescription", params: { description: BOT_TEXTS.ru.description } },
      { method: "setMyDescription", params: { description: BOT_TEXTS.ru.description, language_code: "ru" } },
      { method: "setMyDescription", params: { description: BOT_TEXTS.uz.description, language_code: "uz" } },
      { method: "setMyShortDescription", params: { short_description: BOT_TEXTS.ru.shortDescription } },
      {
        method: "setMyShortDescription",
        params: { short_description: BOT_TEXTS.ru.shortDescription, language_code: "ru" },
      },
      {
        method: "setMyShortDescription",
        params: { short_description: BOT_TEXTS.uz.shortDescription, language_code: "uz" },
      },
      {
        method: "setChatMenuButton",
        params: {
          menu_button: { type: "web_app", text: "Открыть", web_app: { url: "https://staging.bayramm.uz" } },
        },
      },
    ]);

    const body = (await res.json()) as {
      ok: boolean;
      results: { method: string; language: string; ok: boolean }[];
    };
    expect(body.ok).toBe(true);
    expect(body.results).toHaveLength(10);
    expect(body.results.every((result) => result.ok)).toBe(true);
    expect(body.results[0]).toEqual({ method: "setMyCommands", language: "default", ok: true });
    expect(body.results.at(-1)).toEqual({ method: "setChatMenuButton", language: "default", ok: true });
  });

  it("ключ регистр Bearer не различает", async () => {
    mockTelegram();
    const { res } = await sync(`bearer ${SYNC_KEY}`);
    expect(res.status).toBe(200);
  });

  it("частичная неудача: остальные вызовы применяются, отчёт — какие не прошли; ни токена, ни описаний наружу", async () => {
    let menuAttempts = 0;
    mockTelegram({
      setMyDescription: (params) =>
        params.language_code === "uz"
          ? tgError(400, `Bad Request: description is too long ${BOT_TOKEN}`)(params)
          : ok(true)(params),
      setChatMenuButton: () => {
        menuAttempts++;
        throw new TypeError(`network down: ${TG_PREFIX}setChatMenuButton`);
      },
    });
    const { res } = await sync(`Bearer ${SYNC_KEY}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as { ok: boolean; results: Record<string, unknown>[] };

    expect(body.ok).toBe(false);
    expect(tgCalls).toHaveLength(10);
    expect(menuAttempts).toBe(1);
    expect(body.results.filter((result) => !result.ok)).toEqual([
      { method: "setMyDescription", language: "uz", ok: false, error: "api", status: 400 },
      { method: "setChatMenuButton", language: "default", ok: false, error: "network", status: 0 },
    ]);
    expect(body.results.filter((result) => result.ok)).toHaveLength(8);

    expect(text).not.toContain(BOT_TOKEN);
    expect(text).not.toContain("Bad Request");
    expect(logged()).toContain("description is too long [token]");
    for (const secret of [BOT_TOKEN, SYNC_KEY, "api.telegram.org"]) expect(logged()).not.toContain(secret);
  });

  it("Telegram не принимает токен — все вызовы в отчёте с ошибкой, ответ всё равно 200", async () => {
    const unauthorized = tgError(401, "Unauthorized");
    mockTelegram({
      setMyCommands: unauthorized,
      setMyDescription: unauthorized,
      setMyShortDescription: unauthorized,
      setChatMenuButton: unauthorized,
    });
    const { res } = await sync(`Bearer ${SYNC_KEY}`);
    const body = (await res.json()) as { ok: boolean; results: { ok: boolean; status?: number }[] };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.results.map((result) => result.status)).toEqual(Array(10).fill(401));
  });
});
