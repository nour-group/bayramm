// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api/errors";
import { createMockApi, DEMO_OTP_CODE, type MockApi } from "./api/mock";
import { SESSION_KEY } from "./api/session";
import type { TurnstileApi } from "./components/HumanCheck";
import { LANG_KEY } from "./context";
import {
  authHref,
  browser,
  loadHubRequest,
  parseHubRequest,
  readWidgetFields,
  safeReturn,
  saveReturn,
  startTelegramLink,
} from "./hub";
import {
  byText,
  cleanup,
  click,
  fakeWebApp,
  field,
  LISTINGS,
  mount,
  NOW,
  settle,
  text,
  type,
  waitFor,
} from "./test/harness";

const STATE = "sTaTe_0123456789abcdef";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const APPS = { web: "http://localhost", vendor: "https://vendor.example", admin: "https://admin.example" };

let replaced: string[];

beforeEach(() => {
  window.sessionStorage.clear();
  window.sessionStorage.setItem(LANG_KEY, "ru");
  window.scrollTo = () => {};
  replaced = [];
  vi.spyOn(browser, "replace").mockImplementation((url) => void replaced.push(url));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.turnstile;
});

const api = (options: Parameters<typeof createMockApi>[0] = {}): MockApi =>
  createMockApi({ now: () => NOW, listings: LISTINGS, apps: APPS, ...options });

describe("hub.ts", () => {
  it("запрос хаба из адреса: приложение, state и challenge; кривой — invalid", () => {
    expect(parseHubRequest(new URLSearchParams(""))).toBeNull();
    expect(parseHubRequest(new URLSearchParams(`app=vendor&state=${STATE}&challenge=${CHALLENGE}`))).toEqual({
      app: "vendor",
      state: STATE,
      codeChallenge: CHALLENGE,
    });
    for (const bad of [
      `app=web&state=${STATE}&challenge=${CHALLENGE}`,
      `app=vendor&state=x&challenge=${CHALLENGE}`,
      `app=vendor&state=${STATE}&challenge=plain`,
      `app=vendor&state=${STATE}`,
    ]) {
      expect(parseHubRequest(new URLSearchParams(bad)), bad).toBe("invalid");
    }
  });

  it("возврат после входа — только свой путь", () => {
    expect(safeReturn("/profile")).toBe("/profile");
    expect(safeReturn("/venue/lola?date=2026-10-10")).toBe("/venue/lola?date=2026-10-10");
    for (const bad of [
      "//evil.example",
      "https://evil.example",
      "/\\evil",
      "/auth",
      "/auth?app=vendor",
      null,
      "",
    ]) {
      expect(safeReturn(bad), String(bad)).toBeNull();
    }
    expect(authHref({ return: "/profile" })).toBe("/auth?return=%2Fprofile");
    expect(authHref({ return: "//evil" })).toBe("/auth");
  });

  it("поля виджета: без id, auth_date или hash — не виджет", () => {
    expect(readWidgetFields("?id=1&first_name=A&auth_date=2&hash=ab")).toEqual({
      id: "1",
      first_name: "A",
      auth_date: "2",
      hash: "ab",
    });
    expect(readWidgetFields("?id=1&hash=ab")).toBeNull();
  });
});

describe("хаб входа /auth", () => {
  it("гость: вход кодом из сообщения, потом — снова хаб; запрос кабинета запомнен, адрес очищен", async () => {
    const mock = api({ phone: true });
    await mount({
      path: `/auth?app=vendor&state=${STATE}&challenge=${CHALLENGE}`,
      identity: "guest",
      api: mock,
    });
    expect(window.location.search).toBe("");
    expect(text()).toContain("После входа откроется кабинет партнёра.");
    expect(loadHubRequest()).toEqual({ app: "vendor", state: STATE, codeChallenge: CHALLENGE });
    // Виджет — только на домене бота: здесь его нет, есть объяснение и ссылка на бота
    expect(document.querySelector(".tg-login")).toBeNull();
    expect(text()).toContain("пока не включена");

    await type(field("Номер телефона"), "90 123 45 67");
    await click(byText("button", "Получить код"));
    expect(mock.codesSent).toEqual(["+998901234567"]);
    expect(text()).toContain("Код отправлен на номер +998 90 123 45 67");

    await type(field("Код из сообщения"), "000000");
    await click(byText("button", "Войти"));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Код не подходит");

    await type(field("Код из сообщения"), DEMO_OTP_CODE);
    await click(byText("button", "Войти"));
    expect(JSON.parse(window.sessionStorage.getItem(SESSION_KEY) ?? "{}")).toMatchObject({ userId: null });
    expect(replaced).toEqual(["/auth"]);
  });

  it("вход по телефону выключен: ни формы, ни слов о телефоне; кнопка Telegram с запасным выходом — бот", async () => {
    await mount({ path: "/auth", identity: "guest", api: api({ phone: false, loginDomain: "localhost" }) });
    await waitFor(() => document.querySelector(".tg-login"), "виджет Telegram");
    expect(document.querySelector("form.phone-code")).toBeNull();
    expect(text()).not.toMatch(/телефон/i);
    expect(text()).toContain("откройте Bayramm в Telegram — там вход без пароля");
    expect(byText("a", /Открыть Bayramm в Telegram/)?.getAttribute("href")).toBe(
      "https://t.me/bayramm_demo_bot?startapp",
    );
  });

  it("вход по телефону включён: подсказка под кнопкой Telegram упоминает и телефон", async () => {
    await mount({ path: "/auth", identity: "guest", api: api({ phone: true, loginDomain: "localhost" }) });
    await waitFor(() => document.querySelector("form.phone-code"), "форма телефона");
    expect(text()).toContain("откройте Bayramm в Telegram или войдите по телефону");
  });

  it("уже вошли: сразу код хаба и уход в кабинет с тем же state", async () => {
    const mock = api();
    await mount({
      path: `/auth?app=vendor&state=${STATE}&challenge=${CHALLENGE}`,
      identity: "site",
      api: mock,
    });
    await waitFor(() => replaced.length > 0, "уход в кабинет");
    expect(mock.hubCodes).toEqual([{ app: "vendor", state: STATE, codeChallenge: CHALLENGE }]);
    const target = new URL(replaced[0] ?? "");
    expect(target.origin + target.pathname).toBe("https://vendor.example/auth/callback");
    expect(target.searchParams.get("state")).toBe(STATE);
    expect(loadHubRequest()).toBeNull();
  });

  it("вход без запроса хаба — назад, откуда пришли", async () => {
    await mount({ path: "/auth?return=%2Frequests", identity: "site", api: api() });
    await waitFor(() => window.location.pathname === "/requests", "возврат");
    // Переход внутри приложения, без перезагрузки: сессия у страницы уже есть
    expect(replaced).toEqual([]);
  });

  it("кривая ссылка хаба — объяснение, а не вход", async () => {
    await mount({ path: `/auth?app=vendor&state=x&challenge=${CHALLENGE}`, identity: "site", api: api() });
    expect(text()).toContain("Ссылка для входа устарела");
    expect(replaced).toEqual([]);
  });

  it("виджет вернул данные: вход, сессия сайта, дальше — хаб; подписанные поля — не в истории", async () => {
    const mock = api();
    const signIn = vi.spyOn(mock, "signInWidget");
    await mount({
      path: "/auth/telegram?id=42&first_name=Aziza&auth_date=1&hash=ab",
      identity: "guest",
      api: mock,
    });
    await waitFor(() => replaced.length > 0, "вход виджетом");
    expect(signIn).toHaveBeenCalledWith({ id: "42", first_name: "Aziza", auth_date: "1", hash: "ab" }, "ru");
    expect(window.location.search).toBe("");
    expect(replaced).toEqual(["/auth"]);
  });
});

describe("подключить Telegram", () => {
  it("виджет вернул данные — способ добавлен, назад в профиль без перезагрузки", async () => {
    const mock = api();
    const link = vi.spyOn(mock, "linkTelegram").mockImplementation(() => mock.me());
    startTelegramLink();
    saveReturn("/profile");
    await mount({
      path: "/auth/telegram?id=42&first_name=Aziza&auth_date=1&hash=ab",
      identity: "site",
      api: mock,
    });
    await waitFor(() => window.location.pathname === "/profile", "назад в профиль");
    expect(link).toHaveBeenCalledWith({
      widget: { id: "42", first_name: "Aziza", auth_date: "1", hash: "ab" },
    });
    expect(replaced).toEqual([]);
  });
});

describe("профиль: аккаунт", () => {
  it("кнопки кабинета и панели — только по ролям, ссылки — на приложения", async () => {
    await mount({
      path: "/profile",
      api: api({
        roles: {
          vendors: [{ vendorUserId: "u", vendorId: "v", code: "V101", name: "Lola", role: "owner" }],
          staff: { role: "admin" },
        },
      }),
    });
    await waitFor(() => byText("a", /Кабинет партнёра/), "кнопка кабинета");
    expect(byText("a", /Кабинет партнёра/)?.getAttribute("href")).toBe(`${APPS.vendor}/?signin=1`);
    expect(byText("a", /Панель оператора/)?.getAttribute("href")).toBe(`${APPS.admin}/?signin=1`);
  });

  it("без ролей партнёра и сотрудника — кнопок нет", async () => {
    await mount({ path: "/profile", api: api() });
    await waitFor(() => text().includes("Способы входа"), "способы входа");
    expect(byText("a", /Кабинет партнёра/)).toBeNull();
    expect(byText("a", /Панель оператора/)).toBeNull();
  });

  it("добавить телефон кодом из сообщения", async () => {
    const mock = api();
    await mount({ path: "/profile", api: mock });
    await waitFor(() => byText("button", "Добавить телефон"), "кнопка");
    await click(byText("button", "Добавить телефон"));
    await type(field("Номер телефона"), "901234567");
    await click(byText("button", "Получить код"));
    await type(field("Код из сообщения"), DEMO_OTP_CODE);
    await click(byText("button", "Добавить телефон"));
    await waitFor(() => text().includes("Готово: способ входа добавлен."), "готово");
    expect(byText("button", "Добавить телефон")).toBeNull();
  });

  it("гость — «Войти» ведёт в хаб с возвратом в профиль", async () => {
    await mount({ path: "/profile", identity: "guest", api: api() });
    const link = await waitFor(() => byText("a", "Войти"), "ссылка входа");
    expect(link.getAttribute("href")).toBe("/auth?return=%2Fprofile");
    await waitFor(() => text().includes("или по номеру телефона"), "вход и по телефону");
  });

  it("гость, вход по телефону выключен — о телефоне ни слова", async () => {
    await mount({ path: "/profile", identity: "guest", api: api({ phone: false }) });
    await waitFor(() => byText("a", "Войти"), "ссылка входа");
    await waitFor(() => text().includes("Войдите через Telegram"), "только Telegram");
    expect(text()).not.toContain("по номеру телефона");
  });

  it("на сайте — «Выйти»: сессия отзывается, страница — заново", async () => {
    const mock = api();
    const out = vi.spyOn(mock, "signOut");
    await mount({ path: "/profile", identity: "site", api: mock });
    await click(await waitFor(() => byText("button", "Выйти"), "кнопка выхода"));
    expect(out).toHaveBeenCalled();
    expect(replaced).toEqual(["/profile"]);
  });
});

// Поддельный Turnstile: виджеты, которые нарисовало приложение, их сбросы и удаления
function fakeTurnstile() {
  const widgets: { container: HTMLElement; options: Parameters<TurnstileApi["render"]>[1] }[] = [];
  const resets: string[] = [];
  const removed: string[] = [];
  window.turnstile = {
    render(container, options) {
      widgets.push({ container, options });
      return `w${widgets.length}`;
    },
    reset: (id) => void resets.push(id),
    remove: (id) => void removed.push(id),
  };
  const solve = async (index: number, token: string) => {
    await act(async () => widgets[index]?.options.callback(token));
    await settle();
  };
  return { widgets, resets, removed, solve };
}

const SITE_KEY = "0x4AAAAAAA-test-site-key";

describe("проверка «не робот» (Turnstile) у кода на телефон", () => {
  it("хаб: виджет рядом с кнопкой; без токена код не просим; токен уходит один раз", async () => {
    const turnstile = fakeTurnstile();
    const mock = api({ turnstileSiteKey: SITE_KEY });
    await mount({ path: "/auth", identity: "guest", api: mock });
    await waitFor(() => turnstile.widgets.length === 1, "виджет");
    expect(turnstile.widgets[0]?.options).toMatchObject({ sitekey: SITE_KEY, action: "phone_code" });
    expect(document.querySelector("fieldset.human-check legend")?.textContent).toBe(
      "Проверка, что вы не робот",
    );

    await type(field("Номер телефона"), "901234567");
    await click(byText("button", "Получить код"));
    expect(mock.codesSent).toEqual([]);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Дождитесь проверки");

    await turnstile.solve(0, "token-1");
    await click(byText("button", "Получить код"));
    expect(mock.phoneProofs).toEqual([{ turnstileToken: "token-1" }]);
    // Токен потрачен — виджет сброшен; шаг кода — старый виджет убран
    expect(turnstile.resets).toEqual(["w1"]);
    expect(turnstile.removed).toEqual(["w1"]);
    expect(text()).toContain("Код отправлен");
  });

  it("проверка не прошла — наши слова и повтор без перезагрузки", async () => {
    const turnstile = fakeTurnstile();
    await mount({ path: "/auth", identity: "guest", api: api({ turnstileSiteKey: SITE_KEY }) });
    await waitFor(() => turnstile.widgets.length === 1, "виджет");
    await act(async () => void turnstile.widgets[0]?.options["error-callback"]());
    expect(text()).toContain("Проверка не прошла. Попробуйте ещё раз.");
  });

  it("api.js не загрузился (сеть, блокировщик) — объяснение, вход через Telegram остаётся", async () => {
    vi.spyOn(document.head, "append").mockImplementation((...nodes) => {
      for (const node of nodes) if (node instanceof HTMLScriptElement) node.dispatchEvent(new Event("error"));
    });
    await mount({ path: "/auth", identity: "guest", api: api({ turnstileSiteKey: SITE_KEY }) });
    await waitFor(() => text().includes("Проверка сейчас недоступна"), "объяснение");
  });

  it("Mini App: вместо виджета — initData; профиль добавляет телефон тут же", async () => {
    const turnstile = fakeTurnstile();
    const { webApp } = fakeWebApp();
    const mock = api({ turnstileSiteKey: SITE_KEY });
    await mount({ path: "/profile", identity: "telegram", webApp, api: mock });
    await click(await waitFor(() => byText("button", "Добавить телефон"), "кнопка"));
    await type(field("Номер телефона"), "901234567");
    await click(byText("button", "Получить код"));
    expect(mock.phoneProofs).toEqual([{ initData: webApp.initData }]);
    expect(turnstile.widgets).toEqual([]);
  });

  it("сайт: «Добавить телефон» ведёт в хаб (виджет разрешён только там) и возвращает в профиль", async () => {
    await mount({ path: "/profile", identity: "site", api: api({ turnstileSiteKey: SITE_KEY }) });
    const link = await waitFor(() => byText("a", "Добавить телефон"), "ссылка в хаб");
    expect(link.getAttribute("href")).toBe("/auth?return=%2Fprofile&link=phone");
  });

  it("хаб link=phone: код с проверкой — телефон к своему аккаунту, назад в профиль", async () => {
    const turnstile = fakeTurnstile();
    const mock = api({ turnstileSiteKey: SITE_KEY });
    await mount({ path: "/auth?link=phone&return=%2Fprofile", identity: "site", api: mock });
    expect(document.querySelector("h1")?.textContent).toBe("Добавить телефон");
    expect(document.querySelector(".tg-login")).toBeNull();
    await waitFor(() => turnstile.widgets.length === 1, "виджет");
    await turnstile.solve(0, "token-1");
    await type(field("Номер телефона"), "901234567");
    await click(byText("button", "Получить код"));
    await type(field("Код из сообщения"), DEMO_OTP_CODE);
    await click(byText("button", "Добавить телефон"));
    await waitFor(() => window.location.pathname === "/profile", "профиль");
    expect(replaced).toEqual([]);
  });
});

describe("хаб: способы входа не загрузились", () => {
  it("«Повторить» загружает заново", async () => {
    let fail = true;
    const mock = api({
      failWith: (method) => (method === "authMethods" && fail ? new ApiError(0, "network") : null),
    });
    await mount({ path: "/auth", identity: "guest", api: mock });
    await waitFor(() => byText("button", "Повторить"), "повтор");
    expect(text()).toContain("Не удалось загрузить");
    fail = false;
    await click(byText("button", "Повторить"));
    await waitFor(() => field("Номер телефона"), "форма входа");
  });

  it("связь вернулась (событие online) — загрузка повторяется сама; баннер «нет связи»", async () => {
    let fail = true;
    const mock = api({
      failWith: (method) => (method === "authMethods" && fail ? new ApiError(0, "network") : null),
    });
    await mount({ path: "/auth", identity: "guest", api: mock });
    await waitFor(() => byText("button", "Повторить"), "повтор");
    await act(async () => void window.dispatchEvent(new Event("offline")));
    expect(document.querySelector(".ui-net")?.textContent).toContain("Нет подключения к интернету");
    fail = false;
    await act(async () => void window.dispatchEvent(new Event("online")));
    await waitFor(() => field("Номер телефона"), "форма входа без нажатия");
    expect(document.querySelector(".ui-net")?.textContent).toBe("Связь вернулась.");
  });
});
