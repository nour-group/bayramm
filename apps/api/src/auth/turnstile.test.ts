import { afterEach, describe, expect, it, vi } from "vitest";
import { initDataFor } from "../testing/init-data";
import { BOT_TOKEN, call, makeEnv } from "../testing/worker";
import {
  TURNSTILE_ACTION_PHONE,
  TURNSTILE_SITEVERIFY_URL,
  turnstileEnabled,
  turnstileSiteKey,
  verifyTurnstile,
} from "./turnstile";

const SECRET = "0x4AAAAAAA-unit-test-secret";
const SITE_KEY = "0x4AAAAAAA-unit-test-site-key";
const ENV = { APP_ENV: "staging", WEB_APP_URL: "https://staging.example.test", TURNSTILE_SECRET_KEY: SECRET };

afterEach(() => vi.restoreAllMocks());

/** Ответ siteverify; запросы к нему — в calls */
function siteverify(...answers: (Record<string, unknown> | number | Error)[]) {
  const calls: URLSearchParams[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe(TURNSTILE_SITEVERIFY_URL);
    calls.push(new URLSearchParams(init.body as URLSearchParams));
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    if (typeof answer === "number") return new Response("oops", { status: answer });
    return Response.json(answer);
  });
  return { fetch, calls };
}

const passed = (patch: Record<string, unknown> = {}) => ({
  success: true,
  action: TURNSTILE_ACTION_PHONE,
  hostname: "staging.example.test",
  "error-codes": [],
  ...patch,
});

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

describe("включение", () => {
  it("без секрета проверки нет и ключ виджета не отдаётся", () => {
    expect(turnstileEnabled({ ...ENV, TURNSTILE_SECRET_KEY: "" })).toBe(false);
    expect(turnstileEnabled({ ...ENV, TURNSTILE_SECRET_KEY: "  " })).toBe(false);
    expect(turnstileSiteKey({ ...ENV, TURNSTILE_SECRET_KEY: "", TURNSTILE_SITE_KEY: SITE_KEY })).toBeNull();
  });

  it("с секретом — ключ виджета; секрет без ключа — ошибка настройки в лог", () => {
    expect(turnstileEnabled(ENV)).toBe(true);
    expect(turnstileSiteKey({ ...ENV, TURNSTILE_SITE_KEY: SITE_KEY })).toBe(SITE_KEY);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(turnstileSiteKey({ ...ENV, TURNSTILE_SITE_KEY: "" })).toBeNull();
    expect(error).toHaveBeenCalled();
  });
});

describe("verifyTurnstile", () => {
  it("принятый токен: success, action и сайт окружения; remoteip и idempotency_key — в запросе", async () => {
    const { fetch, calls } = siteverify(passed());
    await verifyTurnstile(ENV, { token: "token-1", remoteIp: "203.0.113.7", fetch });
    expect(calls).toHaveLength(1);
    const body = calls[0] as URLSearchParams;
    expect(body.get("secret")).toBe(SECRET);
    expect(body.get("response")).toBe("token-1");
    expect(body.get("remoteip")).toBe("203.0.113.7");
    expect(body.get("idempotency_key")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("без IP — remoteip не передаётся", async () => {
    const { fetch, calls } = siteverify(passed());
    await verifyTurnstile(ENV, { token: "token-1", remoteIp: null, fetch });
    expect(calls[0]?.has("remoteip")).toBe(false);
  });

  it("нет токена — 400 turnstile_required, siteverify не зовём", async () => {
    const { fetch } = siteverify(passed());
    for (const token of [undefined, "", 42, null]) {
      expect(await codeOf(verifyTurnstile(ENV, { token, remoteIp: null, fetch }))).toBe("turnstile_required");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("слишком длинный токен — 403 без siteverify", async () => {
    const { fetch } = siteverify(passed());
    expect(await codeOf(verifyTurnstile(ENV, { token: "x".repeat(2049), remoteIp: null, fetch }))).toBe(
      "turnstile_failed",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["неверный или погашенный токен", { success: false, "error-codes": ["timeout-or-duplicate"] }],
    ["токен другого действия", passed({ action: "login" })],
    ["токен другого сайта", passed({ hostname: "evil.example.test" })],
    ["ответ без полей", { success: true }],
  ])("%s — 403 turnstile_failed", async (_name, answer) => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetch } = siteverify(answer);
    expect(await codeOf(verifyTurnstile(ENV, { token: "t", remoteIp: null, fetch }))).toBe(
      "turnstile_failed",
    );
  });

  it("siteverify отверг секрет — 503: это наша настройка, а не посетитель", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { fetch } = siteverify({ success: false, "error-codes": ["invalid-input-secret"] });
    expect(await codeOf(verifyTurnstile(ENV, { token: "t", remoteIp: null, fetch }))).toBe(
      "turnstile_unavailable",
    );
    expect(error).toHaveBeenCalled();
  });

  it("сбой сети — один повтор с тем же idempotency_key, потом отказ (fail closed)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetch, calls } = siteverify(new TypeError("offline"));
    expect(await codeOf(verifyTurnstile(ENV, { token: "t", remoteIp: null, fetch }))).toBe(
      "turnstile_unavailable",
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]?.get("idempotency_key")).toBe(calls[1]?.get("idempotency_key"));
  });

  it("5xx, затем ответ — принимается со второй попытки", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetch, calls } = siteverify(502, passed());
    expect(await codeOf(verifyTurnstile(ENV, { token: "t", remoteIp: null, fetch }))).toBe("ok");
    expect(calls).toHaveLength(2);
  });

  it("тестовый секрет Cloudflare — только локально, action и сайт не сверяются", async () => {
    const test = { ...ENV, TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA" };
    const { fetch } = siteverify({ success: true, action: "", hostname: "example.com" });
    expect(
      await codeOf(verifyTurnstile({ ...test, APP_ENV: "local" }, { token: "t", remoteIp: null, fetch })),
    ).toBe("ok");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await codeOf(verifyTurnstile(test, { token: "t", remoteIp: null, fetch }))).toBe(
      "turnstile_unavailable",
    );
    expect(error).toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("POST /auth/phone/send с проверкой «не робот»", () => {
  const env = () => makeEnv({ TURNSTILE_SECRET_KEY: SECRET, TURNSTILE_SITE_KEY: SITE_KEY as never });
  const send = (body: unknown, headers: Record<string, string> = {}) =>
    call(
      "/auth/phone/send",
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      },
      env(),
    );
  const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

  it("браузер без токена — 400 turnstile_required до базы", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const { res } = await send({ phone: "+998001234567" });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("turnstile_required");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("неверный токен — 403 turnstile_failed; siteverify получает IP запроса", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ success: false, "error-codes": ["invalid-input-response"] }));
    const { res } = await send(
      { phone: "+998001234567", turnstileToken: "bad" },
      { "CF-Connecting-IP": "203.0.113.9" },
    );
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("turnstile_failed");
    const body = fetch.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get("remoteip")).toBe("203.0.113.9");
  });

  it("неверный номер — 400 invalid_phone раньше проверки: токен не сгорает", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const { res } = await send({ phone: "12345", turnstileToken: "token" });
    expect(await errorCode(res)).toBe("invalid_phone");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("Mini App: неверная initData — 401, виджет не нужен и не проверяется", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.spyOn(globalThis, "fetch");
    const initData = await initDataFor({ id: 100000001, first_name: "Test" }, { botToken: "999:other-bot" });
    const { res } = await send({ phone: "+998001234567", initData });
    expect(res.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("Mini App: подписанная initData без сессии аккаунта — 401: её получит любой бот-аккаунт", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const initData = await initDataFor({ id: 100000001, first_name: "Test" }, { botToken: BOT_TOKEN });
    const { res } = await send({ phone: "+998001234567", initData });
    // Ни Turnstile, ни кода: initData засчитывается только с сессией того же пользователя Telegram
    expect(res.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("без секрета — как раньше: токен не нужен", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { res } = await call("/auth/phone/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "+998001234567" }),
    });
    expect(res.status).toBe(500);
  });

  it("GET /auth/methods отдаёт ключ виджета, только когда проверка включена", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));
    const on = await call("/auth/methods", {}, env());
    expect(((await on.res.json()) as { turnstileSiteKey: string | null }).turnstileSiteKey).toBe(SITE_KEY);
    const off = await call("/auth/methods");
    expect(((await off.res.json()) as { turnstileSiteKey: string | null }).turnstileSiteKey).toBeNull();
  });
});
