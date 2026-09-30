// @vitest-environment jsdom
import type { AuthMethods } from "@bayramm/shared/api/account";
import type { VendorMe } from "@bayramm/shared/api/vendor";
import { codeChallengeOf } from "@bayramm/shared/pkce";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { browser } from "./hub";

// Вход в кабинет вне Telegram через хаб входа: PKCE, state, обмен кода, выбор вендора
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const VENDOR_A = "aaaaaaaa-0000-0000-0000-000000000001";
const VENDOR_B = "bbbbbbbb-0000-0000-0000-000000000001";
const TOKEN = "k".repeat(43);

const METHODS: AuthMethods = {
  telegram: { bot: "bayramm_test_bot", loginDomain: "bayramm.example" },
  phone: false,
  turnstileSiteKey: null,
  apps: { web: "https://bayramm.example", vendor: "https://vendor.example", admin: "https://admin.example" },
};

const vendorMe = (vendorId = VENDOR_A): VendorMe => ({
  user: { id: "aaaaaaaa-0000-0000-0000-000000000011", locale: "ru", fullName: "Manager", role: "owner" },
  vendor: { id: vendorId, code: "V101", name: "Lola" },
  listings: [],
});

const account = (staff: boolean, vendors = [VENDOR_A]) => ({
  roles: {
    client: null,
    vendors: vendors.map((vendorId, i) => ({
      vendorUserId: `u${i}`,
      vendorId,
      code: `V10${i + 1}`,
      name: i === 0 ? "Lola" : "Anor",
      role: "owner",
    })),
    staff: staff ? { role: "admin" } : null,
  },
});

type Handler = (init: RequestInit) => { status?: number; body?: unknown };
let routes: Record<string, Handler>;
let calls: { method: string; path: string; body: unknown; headers: Headers }[];
let assigned: string[];

async function fakeFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const url = new URL(String(input), "https://vendor.example");
  const method = init.method ?? "GET";
  calls.push({
    method,
    path: url.pathname + url.search,
    body: init.body ? JSON.parse(String(init.body)) : undefined,
    headers: new Headers(init.headers),
  });
  const result = routes[`${method} ${url.pathname}`]?.(init);
  if (!result) return Response.json({ error: { code: "not_found" } }, { status: 404 });
  return new Response(result.body === undefined ? null : JSON.stringify(result.body), {
    status: result.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

let container: HTMLDivElement;
let root: Root;

async function mount(path: string, { strict = false } = {}) {
  window.history.replaceState(null, "", path);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      strict ? (
        <StrictMode>
          <App />
        </StrictMode>
      ) : (
        <App />
      ),
    ),
  );
  for (let i = 0; i < 8; i++) await act(async () => {});
}

const heading = () => container.querySelector("h1")?.textContent;
// Уход в хаб — после запроса адресов и PKCE (crypto.subtle): на медленной машине это
// дольше пары тиков, а опоздавший уход попал бы в следующий тест
const redirected = () => act(() => vi.waitFor(() => expect(assigned).toHaveLength(1)));
const byText = <T extends Element>(selector: string, text: string) =>
  [...container.querySelectorAll<T>(selector)].find((el) => el.textContent?.includes(text));

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.localStorage.setItem("bayramm.vendor.lang", "ru");
  calls = [];
  assigned = [];
  routes = {
    "GET /api/auth/methods": () => ({ body: METHODS }),
    "GET /api/telegram/bot": () => ({ body: { username: "bayramm_test_bot" } }),
    "POST /api/auth/hub/exchange": () => ({ body: { token: TOKEN, expiresAt: "2026-10-08T00:00:00Z" } }),
    "GET /api/vendor/me": () => ({ body: vendorMe() }),
    "GET /api/vendor/requests": () => ({
      body: { items: [], nextCursor: null, counts: { new: 0, active: 0, closed: 0 } },
    }),
    "GET /api/me": () => ({ body: account(true) }),
  };
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  vi.spyOn(browser, "assign").mockImplementation((url) => void assigned.push(url));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("хаб входа из кабинета", () => {
  it("«Войти» — в хаб на сайте с app, state и challenge = S256(verifier)", async () => {
    await mount("/calendar");
    const button = byText<HTMLButtonElement>("button", "Войти");
    await act(async () => button?.click());
    await redirected();
    const hub = new URL(assigned[0] ?? "");
    expect(hub.origin + hub.pathname).toBe("https://bayramm.example/auth");
    expect(hub.searchParams.get("app")).toBe("vendor");
    const pending = JSON.parse(window.sessionStorage.getItem("bayramm.vendor.hub") ?? "{}");
    expect(pending.state).toBe(hub.searchParams.get("state"));
    expect(pending.back).toBe("/calendar");
    expect(await codeChallengeOf(pending.verifier)).toBe(hub.searchParams.get("challenge"));
    // verifier в адрес не уходит
    expect(assigned[0]).not.toContain(pending.verifier);
  });

  it("?signin=1 (пришли из приложения Bayramm) — в хаб сразу", async () => {
    await mount("/requests?signin=1");
    await redirected();
    expect(JSON.parse(window.sessionStorage.getItem("bayramm.vendor.hub") ?? "{}").back).toBe("/requests");
  });

  it("возврат из хаба: код + verifier → сессия, экран — тот, с которого уходили", async () => {
    window.sessionStorage.setItem(
      "bayramm.vendor.hub",
      JSON.stringify({ verifier: "v".repeat(43), state: "state_0123456789abcd", back: "/calendar" }),
    );
    await mount(`/auth/callback?code=${"c".repeat(43)}&state=state_0123456789abcd`);
    const exchange = calls.find((c) => c.path === "/api/auth/hub/exchange");
    expect(exchange?.body).toEqual({
      app: "vendor",
      code: "c".repeat(43),
      codeVerifier: "v".repeat(43),
      state: "state_0123456789abcd",
    });
    expect(calls.find((c) => c.path === "/api/vendor/me")?.headers.get("Authorization")).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(window.location.pathname).toBe("/calendar");
    expect(window.location.search).toBe("");
    expect(window.sessionStorage.getItem("bayramm.vendor.hub")).toBeNull();
  });

  it("вход запускается дважды (StrictMode): один обмен, кабинет открыт, а не «войдите»", async () => {
    window.sessionStorage.setItem(
      "bayramm.vendor.hub",
      JSON.stringify({ verifier: "v".repeat(43), state: "state_0123456789abcd", back: "/calendar" }),
    );
    // Свой код: обмен запоминается по адресу возврата
    await mount(`/auth/callback?code=${"d".repeat(43)}&state=state_0123456789abcd`, { strict: true });
    expect(calls.filter((c) => c.path === "/api/auth/hub/exchange")).toHaveLength(1);
    expect(heading()).toBe("Календарь");
    expect(window.sessionStorage.getItem("bayramm.vendor.session")).toBe(TOKEN);
  });

  it("чужой state — код не меняется, «вход не завершился»", async () => {
    window.sessionStorage.setItem(
      "bayramm.vendor.hub",
      JSON.stringify({ verifier: "v".repeat(43), state: "state_0123456789abcd", back: "/requests" }),
    );
    await mount(`/auth/callback?code=${"c".repeat(43)}&state=other_state_0123456789`);
    expect(calls.some((c) => c.path === "/api/auth/hub/exchange")).toBe(false);
    expect(heading()).toBe("Вход не завершился");
    expect(byText("button", "Войти")).toBeDefined();
  });

  it("партнёр нескольких вендоров — выбор; выбранный уходит заголовком X-Bayramm-Vendor", async () => {
    window.sessionStorage.setItem("bayramm.vendor.session", TOKEN);
    routes["GET /api/me"] = () => ({ body: account(false, [VENDOR_A, VENDOR_B]) });
    routes["GET /api/vendor/me"] = (init) => {
      const chosen = new Headers(init.headers).get("X-Bayramm-Vendor");
      return chosen
        ? { body: vendorMe(chosen) }
        : { status: 409, body: { error: { code: "vendor_choice_required" } } };
    };
    await mount("/requests");
    expect(heading()).toBe("Какой кабинет открыть?");
    await act(async () => byText<HTMLButtonElement>("button", "Anor")?.click());
    for (let i = 0; i < 8; i++) await act(async () => {});
    const last = calls.filter((c) => c.path === "/api/vendor/me").at(-1);
    expect(last?.headers.get("X-Bayramm-Vendor")).toBe(VENDOR_B);
    expect(heading()).toBe("Заявки");
    expect(byText("button", "Другой кабинет")).toBeDefined();
  });

  it("ссылки аккаунта: клиентское приложение и панель — только сотруднику", async () => {
    window.sessionStorage.setItem("bayramm.vendor.session", TOKEN);
    await mount("/requests");
    expect(byText<HTMLAnchorElement>("a", "Bayramm для клиентов")?.getAttribute("href")).toBe(
      "https://bayramm.example",
    );
    expect(byText<HTMLAnchorElement>("a", "Панель оператора")?.getAttribute("href")).toBe(
      "https://admin.example/?signin=1",
    );
  });
});
