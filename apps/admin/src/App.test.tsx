// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { TELEGRAM_WIDGET_SRC } from "./Login";
import { tokenStore } from "./session";
import { t } from "./texts";

// React ждёт этот флаг, чтобы act() дожидался эффектов
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const TOKEN_KEY = "bayramm.admin.session";
const TOKEN = "T".repeat(43);
const BOT = "example_login_bot";
const STAFF = {
  id: "00000000-0000-0000-0000-00000000b001",
  role: "moderator",
  displayName: "Test Moderator",
  username: "test_moderator",
};
const WIDGET_FIELDS = {
  id: "100000001",
  first_name: "Test",
  username: "test_moderator",
  auth_date: "1790000000",
  hash: "ab".repeat(32),
};

interface ApiCall {
  method: string;
  url: string;
  authorization: string | null;
  body: string | null;
  /** Адрес страницы в момент запроса */
  href: string;
}

let container: HTMLDivElement;
let root: Root;
let calls: ApiCall[];

type Handler = () => Response | Promise<Response>;

const json =
  (body: unknown, status = 200): Handler =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// fetch панели: ответ по «МЕТОД путь», остальное — 404
function mockApi(handlers: Record<string, Handler>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const url = String(input);
      calls.push({
        method,
        url,
        authorization: new Headers(init.headers).get("authorization"),
        body: typeof init.body === "string" ? init.body : null,
        href: window.location.href,
      });
      const handler = handlers[`${method} ${url}`];
      return handler ? handler() : new Response("{}", { status: 404 });
    }),
  );
}

// Ждём цепочку запросов входа: fetch → json → setState
const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function mount(path: string) {
  window.history.replaceState(null, "", path);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<App />));
  await settle();
}

// Имя бота виджета: панель спрашивает его у API на странице входа
const BOT_INFO = { "GET /api/telegram/bot": json({ username: BOT, miniAppUrl: "https://app.example" }) };

function signedIn() {
  window.sessionStorage.setItem(TOKEN_KEY, TOKEN);
  mockApi({
    ...BOT_INFO,
    "GET /api/staff/me": json(STAFF),
    "POST /api/auth/logout": () => new Response(null, { status: 204 }),
  });
}

const heading = () => container.querySelector("h1")?.textContent;
const alertText = () => container.querySelector("[role=alert]")?.textContent;
const widget = () => container.querySelector("script");
const statusText = () => container.querySelector("[role=status]")?.textContent;
const summary = () => calls.map((c) => `${c.method} ${c.url}`);
const link = (name: string) =>
  [...container.querySelectorAll("a")].find((a) => a.textContent?.trim() === name) as HTMLAnchorElement;
const button = (name: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === name) as HTMLButtonElement;

beforeEach(() => {
  calls = [];
  // В jsdom scrollTo не реализован и пишет об этом в консоль
  window.scrollTo = () => {};
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  tokenStore.clear();
  window.sessionStorage.clear();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("вход в панель оператора", () => {
  it("без сессии — страница входа с официальным виджетом Telegram; имя бота — у API", async () => {
    mockApi(BOT_INFO);
    await mount("/moderation");
    expect(heading()).toBe(t.login);
    expect(window.location.pathname).toBe("/login");
    // Только имя бота, без токена: вход ещё не выполнен
    expect(calls.map((c) => `${c.method} ${c.url} ${c.authorization}`)).toEqual([
      "GET /api/telegram/bot null",
    ]);

    const script = widget();
    expect(script?.src).toBe(TELEGRAM_WIDGET_SRC);
    expect(script?.getAttribute("data-telegram-login")).toBe(BOT);
    expect(script?.getAttribute("data-size")).toBe("large");
    expect(script?.getAttribute("data-auth-url")).toBe(`${window.location.origin}/login/telegram`);
    // data-onauth виджет исполняет через eval — CSP панели его не пропустит
    expect(script?.hasAttribute("data-onauth")).toBe(false);
  });

  it("возврат виджета: адрес чистится до запроса, токен — только в sessionStorage, открывается панель", async () => {
    mockApi({
      ...BOT_INFO,
      "POST /api/auth/staff/telegram": json({ token: TOKEN, expiresAt: "2026-09-29T12:00:00.000Z" }),
      "GET /api/staff/me": json(STAFF),
    });
    await mount(`/login/telegram?${new URLSearchParams(WIDGET_FIELDS)}`);

    // Вошли — имя бота не понадобилось; дальше — данные панели
    expect(summary().slice(0, 2)).toEqual(["POST /api/auth/staff/telegram", "GET /api/staff/me"]);
    expect(summary()).not.toContain("GET /api/telegram/bot");
    const [login, me] = calls;
    expect(login?.method).toBe("POST");
    expect(login?.url).toBe("/api/auth/staff/telegram");
    expect(JSON.parse(login?.body ?? "null")).toEqual(WIDGET_FIELDS);
    // Подписанные данные — пропуск: в адресной строке их уже нет, когда идёт запрос
    expect(login?.href).toBe(`${window.location.origin}/login`);
    expect(me?.url).toBe("/api/staff/me");
    expect(me?.authorization).toBe(`Bearer ${TOKEN}`);

    expect(heading()).toBe("Вендоры");
    expect(window.location.pathname).toBe("/vendors");
    expect(window.location.search).toBe("");
    expect(window.sessionStorage.getItem(TOKEN_KEY)).toBe(TOKEN);
    expect(window.localStorage.length).toBe(0);
    expect(container.querySelector(".who")?.textContent).toContain("Test Moderator");
    expect(container.querySelector(".who")?.textContent).toContain("Модератор");
  });

  it.each([
    [403, "denied"],
    [401, "invalid"],
    [502, "unavailable"],
  ] as const)("API ответило %s — сообщение, токена нет, виджет снова на месте", async (status, error) => {
    mockApi({
      ...BOT_INFO,
      "POST /api/auth/staff/telegram": json({ error: { code: "x", message: "x" } }, status),
    });
    await mount(`/login/telegram?${new URLSearchParams(WIDGET_FIELDS)}`);
    expect(alertText()).toBe(t.errors[error]);
    expect(window.location.pathname).toBe("/login");
    expect(window.sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(widget()?.getAttribute("data-telegram-login")).toBe(BOT);
    expect(summary()).toEqual(["POST /api/auth/staff/telegram", "GET /api/telegram/bot"]);
  });

  it("API недоступно (сеть) — «сервер не отвечает»", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await mount(`/login/telegram?${new URLSearchParams(WIDGET_FIELDS)}`);
    expect(alertText()).toBe(t.errors.unavailable);
  });

  it("возврат без подписанных полей — ошибка без запроса входа к API", async () => {
    mockApi(BOT_INFO);
    await mount("/login/telegram?id=1");
    expect(alertText()).toBe(t.errors.invalid);
    expect(summary()).toEqual(["GET /api/telegram/bot"]);
    expect(window.location.search).toBe("");
  });
});

describe("имя бота для виджета входа", () => {
  it("пока API не ответило — статус «загружаем», виджета нет", async () => {
    let answer: (res: Response | PromiseLike<Response>) => void = () => {};
    mockApi({ "GET /api/telegram/bot": () => new Promise<Response>((resolve) => (answer = resolve)) });
    await mount("/login");
    expect(statusText()).toBe(t.loginBotLoading);
    expect(widget()).toBeNull();

    await act(async () => answer(json({ username: BOT, miniAppUrl: "https://app.example" })()));
    await settle();
    expect(statusText()).toBeUndefined();
    expect(widget()?.getAttribute("data-telegram-login")).toBe(BOT);
  });

  it.each([
    ["API ответило 503", () => json({ error: { code: "telegram_unavailable", message: "x" } }, 503)()],
    ["в ответе нет имени", () => json({ miniAppUrl: "https://app.example" })()],
    ["имя не похоже на бота", () => json({ username: "someone", miniAppUrl: "https://app.example" })()],
    ["имя с посторонними символами", () => json({ username: 'x" onload="bot', miniAppUrl: "x" })()],
    ["не JSON", () => new Response("<html>", { status: 200 })],
  ])("%s — ошибка и «Повторить», виджета нет", async (_name, respond) => {
    mockApi({ "GET /api/telegram/bot": respond });
    await mount("/login");
    expect(alertText()).toBe(t.loginBotFailed);
    expect(button(t.retry)).toBeDefined();
    expect(widget()).toBeNull();
  });

  it("сеть недоступна — ошибка; «Повторить» спрашивает снова и ставит виджет", async () => {
    let attempts = 0;
    mockApi({
      "GET /api/telegram/bot": () => {
        attempts++;
        if (attempts === 1) throw new TypeError("Failed to fetch");
        return json({ username: BOT, miniAppUrl: "https://app.example" })();
      },
    });
    await mount("/login");
    expect(alertText()).toBe(t.loginBotFailed);

    await act(async () => button(t.retry).click());
    await settle();
    expect(attempts).toBe(2);
    expect(alertText()).toBeUndefined();
    expect(widget()?.getAttribute("data-telegram-login")).toBe(BOT);
    // Кнопка «Повторить» исчезла — фокус на заголовке страницы
    expect(document.activeElement).toBe(container.querySelector("h1"));
  });

  it("скрипт виджета не загрузился — ошибка; «Повторить» ставит виджет заново", async () => {
    mockApi(BOT_INFO);
    await mount("/login");
    await act(async () => widget()?.dispatchEvent(new Event("error")));
    expect(alertText()).toBe(t.loginWidgetFailed);
    expect(widget()).toBeNull();

    await act(async () => button(t.retry).click());
    await settle();
    expect(widget()?.getAttribute("data-telegram-login")).toBe(BOT);
    expect(summary()).toEqual(["GET /api/telegram/bot", "GET /api/telegram/bot"]);
  });
});

describe("сессия сотрудника", () => {
  it("сохранённый токен — сразу панель; имя бота не спрашиваем", async () => {
    signedIn();
    await mount("/requests");
    expect(heading()).toBe("Заявки");
    expect(calls[0]).toMatchObject({ method: "GET", url: "/api/staff/me", authorization: `Bearer ${TOKEN}` });
    // Данные панели — только с токеном; кнопка входа не нужна
    expect(calls.every((c) => c.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(summary()).not.toContain("GET /api/telegram/bot");
  });

  it("токен больше не действует — стирается, страница входа без ошибки", async () => {
    window.sessionStorage.setItem(TOKEN_KEY, TOKEN);
    mockApi({ ...BOT_INFO, "GET /api/staff/me": json({ error: { code: "unauthorized" } }, 401) });
    await mount("/vendors");
    expect(heading()).toBe(t.login);
    expect(alertText()).toBeUndefined();
    expect(widget()?.getAttribute("data-telegram-login")).toBe(BOT);
    expect(window.sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it("выход: сессия отзывается на сервере, токен стирается", async () => {
    signedIn();
    await mount("/vendors");
    await act(async () => button(t.signOut).click());
    await settle();

    expect(calls.find((c) => c.url === "/api/auth/logout")).toMatchObject({
      method: "POST",
      authorization: `Bearer ${TOKEN}`,
    });
    // На странице входа — снова кнопка Telegram
    expect(summary().at(-1)).toBe("GET /api/telegram/bot");
    expect(widget()?.getAttribute("data-telegram-login")).toBe(BOT);
    expect(window.sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(heading()).toBe(t.login);
    expect(window.location.pathname).toBe("/login");
  });
});

describe("оболочка панели оператора", () => {
  beforeEach(signedIn);

  it("корень открывает вендоров и переписывает адрес", async () => {
    await mount("/");
    expect(window.location.pathname).toBe("/vendors");
    expect(heading()).toBe("Вендоры");
    expect(link("Вендоры").getAttribute("aria-current")).toBe("page");
  });

  it("вошедшему страница входа не нужна — открываются вендоры", async () => {
    await mount("/login");
    expect(window.location.pathname).toBe("/vendors");
    expect(heading()).toBe("Вендоры");
  });

  it.each([
    ["Модерация", "/moderation"],
    ["Заявки", "/requests"],
    ["Клиенты", "/clients"],
  ])("переход в «%s» без перезагрузки", async (name, path) => {
    await mount("/vendors");
    act(() => link(name).click());
    expect(window.location.pathname).toBe(path);
    expect(heading()).toBe(name);
    expect(link(name).getAttribute("aria-current")).toBe("page");
    expect(document.activeElement).toBe(container.querySelector("h1"));
    expect(document.title).toBe(`${name} · Bayramm`);
  });

  it("неизвестный путь — «не найдена» со ссылкой на вендоров", async () => {
    await mount("/nope");
    expect(heading()).toBe("Страница не найдена");
    expect(link("К вендорам").getAttribute("href")).toBe("/vendors");
  });

  it("есть ссылка «К содержимому» на main", async () => {
    await mount("/vendors");
    expect(container.querySelector("a.skip")?.getAttribute("href")).toBe("#main");
    expect(container.querySelector("main#main")).not.toBeNull();
  });
});
