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
const BOT = "bayramm_test_bot";
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

function signedIn() {
  window.sessionStorage.setItem(TOKEN_KEY, TOKEN);
  mockApi({
    "GET /api/staff/me": json(STAFF),
    "POST /api/auth/logout": () => new Response(null, { status: 204 }),
  });
}

const heading = () => container.querySelector("h1")?.textContent;
const alertText = () => container.querySelector("[role=alert]")?.textContent;
const widget = () => container.querySelector("script");
const link = (name: string) =>
  [...container.querySelectorAll("a")].find((a) => a.textContent?.trim() === name) as HTMLAnchorElement;
const button = (name: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === name) as HTMLButtonElement;

beforeEach(() => {
  calls = [];
  vi.stubEnv("VITE_TG_BOT_USERNAME", BOT);
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
  vi.unstubAllEnvs();
});

describe("вход в панель оператора", () => {
  it("без сессии — страница входа с официальным виджетом Telegram, API не спрашиваем", async () => {
    mockApi({});
    await mount("/moderation");
    expect(heading()).toBe(t.login);
    expect(window.location.pathname).toBe("/login");
    expect(calls).toEqual([]);

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
      "POST /api/auth/staff/telegram": json({ token: TOKEN, expiresAt: "2026-09-29T12:00:00.000Z" }),
      "GET /api/staff/me": json(STAFF),
    });
    await mount(`/login/telegram?${new URLSearchParams(WIDGET_FIELDS)}`);

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
    mockApi({ "POST /api/auth/staff/telegram": json({ error: { code: "x", message: "x" } }, status) });
    await mount(`/login/telegram?${new URLSearchParams(WIDGET_FIELDS)}`);
    expect(alertText()).toBe(t.errors[error]);
    expect(window.location.pathname).toBe("/login");
    expect(window.sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(widget()).not.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("API недоступно (сеть) — «сервер не отвечает»", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await mount(`/login/telegram?${new URLSearchParams(WIDGET_FIELDS)}`);
    expect(alertText()).toBe(t.errors.unavailable);
  });

  it("возврат без подписанных полей — ошибка без запроса к API", async () => {
    mockApi({});
    await mount("/login/telegram?id=1");
    expect(alertText()).toBe(t.errors.invalid);
    expect(calls).toEqual([]);
    expect(window.location.search).toBe("");
  });

  it("имя бота не задано при сборке — вход не настроен, виджета нет", async () => {
    vi.stubEnv("VITE_TG_BOT_USERNAME", "");
    mockApi({});
    await mount("/login");
    expect(container.textContent).toContain(t.loginNotConfigured);
    expect(widget()).toBeNull();
  });
});

describe("сессия сотрудника", () => {
  it("сохранённый токен — сразу панель", async () => {
    signedIn();
    await mount("/requests");
    expect(heading()).toBe("Заявки");
    expect(calls.map((c) => `${c.method} ${c.url} ${c.authorization}`)).toEqual([
      `GET /api/staff/me Bearer ${TOKEN}`,
    ]);
  });

  it("токен больше не действует — стирается, страница входа без ошибки", async () => {
    window.sessionStorage.setItem(TOKEN_KEY, TOKEN);
    mockApi({ "GET /api/staff/me": json({ error: { code: "unauthorized" } }, 401) });
    await mount("/vendors");
    expect(heading()).toBe(t.login);
    expect(alertText()).toBeUndefined();
    expect(window.sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it("выход: сессия отзывается на сервере, токен стирается", async () => {
    signedIn();
    await mount("/vendors");
    await act(async () => button(t.signOut).click());
    await settle();

    expect(calls.at(-1)).toMatchObject({
      method: "POST",
      url: "/api/auth/logout",
      authorization: `Bearer ${TOKEN}`,
    });
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
