import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { botIdOf, TelegramError, telegramClient } from "./client";

const TOKEN = "123456:unit-test-bot-token";

// signal — тот, что клиент передал в fetch (у копии в Request он свой)
type Respond = (request: Request, signal: AbortSignal | undefined) => Response | Promise<Response>;

function fakeFetch(respond: Respond) {
  const requests: Request[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return respond(request, init?.signal ?? undefined);
  }) as typeof fetch;
  return { fetcher, requests };
}

function client(respond: Respond, timeoutMs?: number) {
  const fake = fakeFetch(respond);
  return { tg: telegramClient({ token: TOKEN, fetch: fake.fetcher, timeoutMs }), requests: fake.requests };
}

async function caught(run: () => Promise<unknown>): Promise<TelegramError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof TelegramError) return err;
    throw err;
  }
  throw new Error("ожидалась TelegramError");
}

// Всё, что видно у ошибки: сообщение, поля, стек, cause — как их показал бы console.error
const shown = (err: unknown) => inspect(err, { depth: 5 });

describe("telegramClient.call", () => {
  it("POST https://api.telegram.org/bot<токен>/<метод>, параметры — JSON; результат — поле result", async () => {
    const { tg, requests } = client(() =>
      Response.json({
        ok: true,
        result: { id: 123456, is_bot: true, first_name: "Test", username: "example_test_bot" },
      }),
    );
    const me = await tg.call("getMe", {});
    expect(me).toEqual({ id: 123456, is_bot: true, first_name: "Test", username: "example_test_bot" });

    const [request] = requests;
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`);
    expect(request?.headers.get("content-type")).toBe("application/json");
    expect(await request?.json()).toEqual({});
  });

  it("параметры уходят как есть", async () => {
    const { tg, requests } = client(() => Response.json({ ok: true, result: true }));
    const params = { commands: [{ command: "start", description: "Открыть" }], language_code: "ru" };
    await expect(tg.call("setMyCommands", params)).resolves.toBe(true);
    expect(requests[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/setMyCommands`);
    expect(await requests[0]?.json()).toEqual(params);
  });

  it("ok: false — причина api, код и описание от Telegram", async () => {
    const { tg } = client(() =>
      Response.json({ ok: false, error_code: 400, description: "Bad Request: something" }, { status: 400 }),
    );
    const err = await caught(() => tg.call("setMyDescription", { description: "x" }));
    expect(err).toMatchObject({
      method: "setMyDescription",
      reason: "api",
      status: 400,
      description: "Bad Request: something",
    });
    expect(err.message).toBe("telegram setMyDescription: api 400");
  });

  it("токен из описания ошибки вырезается; описание не длиннее 200 символов", async () => {
    const { tg } = client(() =>
      Response.json({ ok: false, error_code: 401, description: `Unauthorized ${TOKEN} ${"x".repeat(500)}` }),
    );
    const err = await caught(() => tg.call("getMe", {}));
    expect(err.status).toBe(401);
    expect(err.description).toMatch(/^Unauthorized \[token\] x+$/);
    expect(err.description?.length).toBe(200);
    expect(shown(err)).not.toContain(TOKEN);
  });

  it("нет ответа — network; ни адреса, ни исходной ошибки (в ней бывает адрес) нет", async () => {
    const { tg } = client((request) => {
      throw new TypeError(`fetch failed: ${request.url}`);
    });
    const err = await caught(() => tg.call("getMe", {}));
    expect(err).toMatchObject({ reason: "network", status: 0 });
    expect(err.cause).toBeUndefined();
    expect(shown(err)).not.toContain(TOKEN);
    expect(shown(err)).not.toContain("api.telegram.org");
  });

  it("не уложились в timeoutMs — timeout", async () => {
    // fetch, который отвечает только отменой по сигналу
    const { tg } = client(
      (_request, signal) =>
        new Promise<Response>((_, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason));
        }),
      20,
    );
    const started = Date.now();
    const err = await caught(() => tg.call("getMe", {}));
    expect(err).toMatchObject({ reason: "timeout", status: 0 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(shown(err)).not.toContain(TOKEN);
  });

  it("ответ не JSON или не в формате Bot API — bad_response", async () => {
    const cases: [() => Response, number][] = [
      [() => new Response("<html>Bad Gateway</html>", { status: 502 }), 502],
      [() => Response.json({ result: true }), 200],
      [() => Response.json({ ok: true }), 200],
      [() => Response.json(null), 200],
    ];
    for (const [respond, status] of cases) {
      const { tg } = client(respond);
      expect(await caught(() => tg.call("getMe", {}))).toMatchObject({ reason: "bad_response", status });
    }
  });
});

describe("токен бота", () => {
  it("id бота — часть до двоеточия", () => {
    expect(botIdOf(TOKEN)).toBe("123456");
  });

  it("пустой или не похожий на токен — ошибка настройки, без самого значения в тексте", () => {
    for (const token of [
      "",
      "no-colon",
      ":secret",
      "123:",
      "123:has/slash",
      "123:a b",
      `123:${"a".repeat(200)}`,
    ]) {
      expect(() => telegramClient({ token }), JSON.stringify(token)).toThrow(TypeError);
    }
    try {
      telegramClient({ token: "123:has/slash" });
    } catch (err) {
      expect(String(err)).not.toContain("has/slash");
    }
  });
});
