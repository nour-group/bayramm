// @vitest-environment jsdom

import { codeChallengeOf } from "@bayramm/shared/pkce";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { browser, tokenStore } from "./session";
import { t } from "./texts";

// React ждёт этот флаг, чтобы act() дожидался эффектов
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const TOKEN_KEY = "bayramm.admin.session";
const TOKEN = "T".repeat(43);
const BOT = "example_login_bot";
const STAFF = {
  id: "00000000-0000-0000-0000-00000000b001",
  role: "manager",
  displayName: "Test Manager",
  username: "test_manager",
  permissions: [
    "catalog.read",
    "vendors.write",
    "listings.write",
    "requests.read",
    "requests.write",
    "clients.read",
    "outbox.read",
  ],
};
const ACCOUNT_TOKEN = "A".repeat(43);
const METHODS = {
  telegram: { bot: BOT, loginDomain: "bayramm.example" },
  phone: false,
  turnstileSiteKey: null,
  apps: { web: "https://bayramm.example", vendor: "https://vendor.example", admin: "https://admin.example" },
};
const PENDING_KEY = "bayramm.admin.hub";

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

// Адрес сайта (хаб входа) и имя бота — у API
const BOT_INFO = { "GET /api/auth/methods": json(METHODS) };

function signedIn() {
  window.sessionStorage.setItem(TOKEN_KEY, TOKEN);
  mockApi({
    ...BOT_INFO,
    "GET /api/staff/me": json(STAFF),
    "GET /api/me": json({ roles: { client: null, vendors: [], staff: { role: "manager" } } }),
    "POST /api/auth/logout": () => new Response(null, { status: 204 }),
  });
}

const heading = () => container.querySelector("h1")?.textContent;
const alertText = () => container.querySelector("[role=alert]")?.textContent;
let assigned: string[];

// Уход в хаб — после запроса адресов и PKCE (crypto.subtle): на медленной машине это
// дольше пары тиков, а опоздавший уход попал бы в следующий тест
const redirected = () => act(() => vi.waitFor(() => expect(assigned).toHaveLength(1)));
const summary = () => calls.map((c) => `${c.method} ${c.url}`);
const link = (name: string) =>
  [...container.querySelectorAll("a")].find((a) => a.textContent?.trim() === name) as HTMLAnchorElement;
const button = (name: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === name) as HTMLButtonElement;

beforeEach(() => {
  calls = [];
  assigned = [];
  // В jsdom scrollTo не реализован и пишет об этом в консоль
  window.scrollTo = () => {};
  vi.spyOn(browser, "assign").mockImplementation((url) => void assigned.push(url));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  tokenStore.clear();
  window.sessionStorage.clear();
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (window as { Telegram?: unknown }).Telegram;
});

describe("вход в панель оператора", () => {
  it("без сессии — страница входа: «Войти через Bayramm» (хаб) и бот окружения; виджета здесь нет", async () => {
    mockApi(BOT_INFO);
    await mount("/moderation");
    expect(heading()).toBe(t.login);
    expect(window.location.pathname).toBe("/login");
    expect(button(t.loginHub)).toBeDefined();
    expect(container.querySelector("script")).toBeNull();
    expect(link(t.loginOpenBot).getAttribute("href")).toBe(`https://t.me/${BOT}?start=admin`);
    // Без токена: вход ещё не выполнен
    expect(calls.every((c) => c.authorization === null)).toBe(true);
    // Вход по телефону в окружении выключен — о телефоне ни слова
    expect(container.querySelector(".lead")?.textContent).toBe(t.loginLeadTelegram);
    expect(container.textContent).not.toMatch(/телефон/i);
  });

  it("вход по телефону включён — страница входа называет и его", async () => {
    mockApi({ "GET /api/auth/methods": json({ ...METHODS, phone: true }) });
    await mount("/login");
    expect(container.querySelector(".lead")?.textContent).toBe(t.loginLead);
  });

  it("«Войти через Bayramm» — в хаб с app=admin, state и challenge = S256(verifier)", async () => {
    mockApi(BOT_INFO);
    await mount("/requests");
    await act(async () => button(t.loginHub).click());
    await redirected();
    const hub = new URL(assigned[0] ?? "");
    expect(hub.origin + hub.pathname).toBe("https://bayramm.example/auth");
    expect(hub.searchParams.get("app")).toBe("admin");
    const pending = JSON.parse(window.sessionStorage.getItem(PENDING_KEY) ?? "{}");
    expect(pending.state).toBe(hub.searchParams.get("state"));
    expect(await codeChallengeOf(pending.verifier)).toBe(hub.searchParams.get("challenge"));
    expect(assigned[0]).not.toContain(pending.verifier);
  });

  it("возврат из хаба: код → сессия аккаунта → сессия сотрудника; сессия аккаунта отзывается", async () => {
    window.sessionStorage.setItem(
      PENDING_KEY,
      JSON.stringify({ verifier: "v".repeat(43), state: "state_0123456789abcd", back: "/requests" }),
    );
    mockApi({
      ...BOT_INFO,
      "POST /api/auth/hub/exchange": json({ token: ACCOUNT_TOKEN, expiresAt: "2026-10-06T00:00:00Z" }),
      "POST /api/auth/staff/elevate": json({ token: TOKEN, expiresAt: "2026-09-30T00:00:00Z" }),
      "POST /api/auth/logout": () => new Response(null, { status: 204 }),
      "GET /api/staff/me": json(STAFF),
      "GET /api/me": json({ roles: { client: null, vendors: [], staff: { role: "manager" } } }),
    });
    await mount(`/auth/callback?code=${"c".repeat(43)}&state=state_0123456789abcd`);
    const exchange = calls.find((c) => c.url === "/api/auth/hub/exchange");
    expect(JSON.parse(exchange?.body ?? "null")).toEqual({
      app: "admin",
      code: "c".repeat(43),
      codeVerifier: "v".repeat(43),
      state: "state_0123456789abcd",
    });
    // Код и state — не в истории: адрес чистится до запроса
    expect(exchange?.href).toBe(`${window.location.origin}/login`);
    expect(calls.find((c) => c.url === "/api/auth/staff/elevate")?.authorization).toBe(
      `Bearer ${ACCOUNT_TOKEN}`,
    );
    expect(calls.find((c) => c.url === "/api/auth/logout")?.authorization).toBe(`Bearer ${ACCOUNT_TOKEN}`);
    expect(window.sessionStorage.getItem(TOKEN_KEY)).toBe(TOKEN);
    expect(window.location.pathname).toBe("/requests");
    expect(heading()).toBe("Заявки");
  });

  it.each([
    [403, "forbidden", "denied"],
    [401, "reauth_required", "reauth"],
    [502, "x", "unavailable"],
  ] as const)("повышение ответило %s %s — сообщение, токена нет", async (status, code, error) => {
    window.sessionStorage.setItem(
      PENDING_KEY,
      JSON.stringify({ verifier: "v".repeat(43), state: "state_0123456789abcd", back: "/" }),
    );
    mockApi({
      ...BOT_INFO,
      "POST /api/auth/hub/exchange": json({ token: ACCOUNT_TOKEN, expiresAt: "2026-10-06T00:00:00Z" }),
      "POST /api/auth/staff/elevate": json({ error: { code, message: "x" } }, status),
      "POST /api/auth/logout": () => new Response(null, { status: 204 }),
    });
    await mount(`/auth/callback?code=${"c".repeat(43)}&state=state_0123456789abcd`);
    expect(alertText()).toBe(t.errors[error]);
    expect(window.location.pathname).toBe("/login");
    expect(window.sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it("чужой state — код не меняется, «вход не завершился»", async () => {
    window.sessionStorage.setItem(
      PENDING_KEY,
      JSON.stringify({ verifier: "v".repeat(43), state: "state_0123456789abcd", back: "/" }),
    );
    mockApi(BOT_INFO);
    await mount(`/auth/callback?code=${"c".repeat(43)}&state=another_state_0123456`);
    expect(alertText()).toBe(t.errors.invalid);
    expect(summary()).not.toContain("POST /api/auth/hub/exchange");
    expect(window.location.search).toBe("");
  });

  it("панель как Mini App: вход по initData кнопки бота — сразу сессия сотрудника", async () => {
    const webApp = {
      initData: "query_id=1&user=%7B%7D&auth_date=1&hash=abc",
      initDataUnsafe: {},
      ready: vi.fn(),
      expand: vi.fn(),
    };
    Object.assign(window, { Telegram: { WebApp: webApp } });
    mockApi({
      ...BOT_INFO,
      "POST /api/auth/staff/webapp": json({ token: TOKEN, expiresAt: "2026-09-30T00:00:00Z" }),
      "GET /api/staff/me": json(STAFF),
      "GET /api/me": json({ roles: { client: null, vendors: [], staff: { role: "manager" } } }),
    });
    await mount("/vendors");
    const login = calls.find((c) => c.url === "/api/auth/staff/webapp");
    expect(JSON.parse(login?.body ?? "null")).toEqual({ initData: webApp.initData });
    expect(webApp.ready).toHaveBeenCalled();
    expect(heading()).toBe("Вендоры");
  });

  it("?signin=1 (пришли из приложения Bayramm) — в хаб сразу", async () => {
    mockApi(BOT_INFO);
    await mount("/requests?signin=1");
    await redirected();
    expect(JSON.parse(window.sessionStorage.getItem(PENDING_KEY) ?? "{}").back).toBe("/requests");
  });

  it("API недоступно (сеть) — «сервер не отвечает»", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await mount("/login");
    await act(async () => button(t.loginHub).click());
    await settle();
    expect(alertText()).toBe(t.errors.unavailable);
  });
});

describe("сессия сотрудника", () => {
  it("сохранённый токен — сразу панель; ссылки на другие роли аккаунта", async () => {
    signedIn();
    await mount("/requests");
    expect(heading()).toBe("Заявки");
    expect(calls[0]).toMatchObject({ method: "GET", url: "/api/staff/me", authorization: `Bearer ${TOKEN}` });
    // Данные панели — только с токеном (адрес сайта — без него)
    expect(
      calls.filter((c) => c.url !== "/api/auth/methods").every((c) => c.authorization === `Bearer ${TOKEN}`),
    ).toBe(true);
    expect(link(t.toClientApp).getAttribute("href")).toBe("https://bayramm.example");
    expect([...container.querySelectorAll("a")].some((a) => a.textContent === t.toCabinet)).toBe(false);
  });

  it("нет связи — полоса над панелью; вернулась — упавший раздел загружается сам", async () => {
    window.sessionStorage.setItem(TOKEN_KEY, TOKEN);
    let offline = true;
    mockApi({
      ...BOT_INFO,
      "GET /api/staff/me": json(STAFF),
      "GET /api/me": json({ roles: { client: null, vendors: [], staff: { role: "manager" } } }),
    });
    const online = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (offline && String(input).startsWith("/api/staff/requests")) throw new TypeError("offline");
      return online?.(input, init) ?? new Response("{}", { status: 404 });
    });
    await mount("/requests");
    await act(async () => void window.dispatchEvent(new Event("offline")));
    expect(container.querySelector(".ui-net")?.textContent).toBe(t.offline);
    const before = calls.filter((c) => c.url.startsWith("/api/staff/requests")).length;
    offline = false;
    await act(async () => void window.dispatchEvent(new Event("online")));
    await settle();
    expect(container.querySelector(".ui-net")?.textContent).toBe(t.backOnline);
    expect(calls.filter((c) => c.url.startsWith("/api/staff/requests")).length).toBeGreaterThan(before);
  });

  it("токен больше не действует — стирается, страница входа без ошибки", async () => {
    window.sessionStorage.setItem(TOKEN_KEY, TOKEN);
    mockApi({ ...BOT_INFO, "GET /api/staff/me": json({ error: { code: "unauthorized" } }, 401) });
    await mount("/vendors");
    expect(heading()).toBe(t.login);
    expect(alertText()).toBeUndefined();
    expect(button(t.loginHub)).toBeDefined();
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
    // На странице входа — снова вход через хаб
    expect(button(t.loginHub)).toBeDefined();
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

  it("в навигации — только разделы роли: менеджеру журнал, команда и настройки не показываются", async () => {
    await mount("/vendors");
    const nav = [...container.querySelectorAll(".nav a")].map((a) => a.textContent);
    expect(nav).toEqual(["Вендоры", "Модерация", "Заявки", "Клиенты", "Уведомления"]);
  });

  it.each([
    ["Модерация", "/moderation"],
    ["Заявки", "/requests"],
    ["Клиенты", "/clients"],
    ["Уведомления", "/notifications"],
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
