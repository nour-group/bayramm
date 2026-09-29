// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi, DEMO_OTP_CODE, type MockApi } from "./api/mock";
import { SESSION_KEY } from "./api/session";
import { LANG_KEY } from "./context";
import { authHref, browser, loadHubRequest, parseHubRequest, readWidgetFields, safeReturn } from "./hub";
import { byText, cleanup, click, field, LISTINGS, mount, NOW, text, type, waitFor } from "./test/harness";

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
    await waitFor(() => replaced.length > 0, "возврат");
    expect(replaced).toEqual(["/requests"]);
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
    expect(byText("a", /Кабинет партнёра/)?.getAttribute("href")).toBe(APPS.vendor);
    expect(byText("a", /Панель оператора/)?.getAttribute("href")).toBe(APPS.admin);
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
