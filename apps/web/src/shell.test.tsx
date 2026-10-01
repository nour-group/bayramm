// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "./api/mock";
import { LANG_KEY } from "./context";
import { browser } from "./hub";
import { byText, cleanup, click, fakeWebApp, LISTINGS, mount, NOW, text, waitFor } from "./test/harness";

/* Оболочка сайта у гостя и после входа (nav.ts): гостю — шапка с языком, «Войти» и меню,
   без нижней панели и без личных разделов; после входа и в Telegram — приложение */

let replaced: string[];

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.sessionStorage.setItem(LANG_KEY, "ru");
  window.scrollTo = () => {};
  replaced = [];
  vi.spyOn(browser, "replace").mockImplementation((url) => void replaced.push(url));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const tabs = () => [...document.querySelectorAll("nav.tabs a")].map((a) => a.textContent);
const headerSections = () => [...document.querySelectorAll("nav.site-nav a")].map((a) => a.textContent);
const menuButton = () => document.querySelector<HTMLButtonElement>(".top button.top-menu");
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

describe("гость в браузере", () => {
  it("шапка: логотип, язык, «Войти» с возвратом сюда и меню; нижней панели нет", async () => {
    await mount({ path: "/catalog?date=2026-10-20", identity: "guest" });
    expect(document.querySelector(".app")?.classList.contains("guest")).toBe(true);
    expect(document.querySelector("nav.tabs")).toBeNull();
    expect(headerSections()).toEqual(["Каталог", "Сохранённое"]);
    expect(document.querySelector(".top .lang")).not.toBeNull();
    expect(document.querySelector(".top-signin")?.getAttribute("href")).toBe(
      "/auth?return=%2Fcatalog%3Fdate%3D2026-10-20",
    );
    const button = menuButton();
    expect(button?.getAttribute("aria-label")).toBe("Меню");
    expect(button?.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    // Ни «Заявок», ни «Профиля» — ни в шапке, ни где-то ещё в оболочке
    expect(document.querySelector('a[href="/requests"], a[href="/profile"]')).toBeNull();
  });

  it("меню: каталог, сохранённое, документы, бот, язык и вход; ссылка ведёт и закрывает", async () => {
    await mount({ path: "/", identity: "guest" });
    await click(menuButton());
    const menu = await waitFor(dialog, "меню");
    expect(menu.getAttribute("aria-modal")).toBe("true");
    expect(menuButton()?.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(menu.getAttribute("aria-labelledby") ?? "")?.textContent).toBe("Меню");
    await waitFor(() => menu.querySelector('a[href^="https://t.me/"]'), "ссылка на бота");
    const links = [...menu.querySelectorAll(".menu-links a")].map((a) => [
      a.textContent,
      a.getAttribute("href"),
    ]);
    expect(links).toEqual([
      ["Каталог", "/catalog"],
      ["Сохранённое", "/favorites"],
      ["Документы", "/docs"],
      ["Bayramm в Telegram", "https://t.me/bayramm_demo_bot?startapp"],
    ]);
    expect(menu.querySelector('a[target="_blank"]')?.getAttribute("rel")).toContain("noopener");
    expect(menu.querySelector('.lang[role="group"]')).not.toBeNull();
    // Вход — в хаб с возвратом на этот экран; о телефоне — только если вход по нему включён
    expect(byText(".menu-signin a", "Войти")?.getAttribute("href")).toBe("/auth?return=%2F");
    await waitFor(() => menu.textContent?.includes("или по номеру телефона"), "вход и по телефону");

    await click(byText(".menu-links a", "Сохранённое"));
    expect(window.location.pathname).toBe("/favorites");
    expect(dialog()).toBeNull();
    expect(document.querySelector("h1")?.textContent).toBe("Сохранённое");
  });

  it("меню: вход по телефону выключен — о телефоне ни слова; «Закрыть» и Esc закрывают", async () => {
    const api = createMockApi({ now: () => NOW, listings: LISTINGS, phone: false });
    await mount({ path: "/catalog", identity: "guest", api });
    await click(menuButton());
    await waitFor(() => dialog()?.textContent?.includes("Войдите через Telegram"), "только Telegram");
    expect(dialog()?.textContent).not.toContain("по номеру телефона");
    await click(byText('[role="dialog"] button', "Закрыть"));
    expect(dialog()).toBeNull();

    await click(menuButton());
    const menu = await waitFor(dialog, "меню снова");
    await act(async () => {
      menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(dialog()).toBeNull();
  });

  it("язык в меню меняет язык всего сайта", async () => {
    await mount({ path: "/catalog", identity: "guest" });
    await click(menuButton());
    const menu = await waitFor(dialog, "меню");
    await click(menu.querySelector('button[lang="uz"]'));
    expect(document.documentElement.lang).toBe("uz");
    expect(menu.querySelector(".site-menu")?.getAttribute("lang")).toBe("uz");
    expect(text(menu)).toContain("Saqlanganlar");
  });

  it("личные экраны — в хаб входа, а не пустым экраном", async () => {
    await mount({ path: "/requests?open=r1", identity: "guest" });
    expect(replaced).toEqual(["/auth?return=%2Frequests%3Fopen%3Dr1"]);
    expect(document.querySelector("main h1")).toBeNull();
  });
});

describe("после входа", () => {
  it("сайт: нижняя панель со всеми разделами; ни «Войти», ни меню гостя", async () => {
    await mount({ path: "/catalog", identity: "site" });
    expect(document.querySelector(".app")?.classList.contains("guest")).toBe(false);
    expect(tabs()).toEqual(["Каталог", "Сохранённое", "Заявки", "Профиль"]);
    expect(headerSections()).toEqual(["Каталог", "Сохранённое", "Заявки", "Профиль"]);
    expect(document.querySelector(".top-signin")).toBeNull();
    expect(menuButton()).toBeNull();
    await click(byText("nav.tabs a", "Профиль"));
    await waitFor(() => byText("h1", "Профиль"), "профиль");
    expect(replaced).toEqual([]);
  });

  it("Telegram: как раньше — вкладки, первая «Главная», без входа и меню сайта", async () => {
    const { webApp } = fakeWebApp();
    await mount({ path: "/", identity: "telegram", webApp });
    expect(tabs()).toEqual(["Главная", "Сохранённое", "Заявки", "Профиль"]);
    expect(document.querySelector(".top-signin")).toBeNull();
    expect(menuButton()).toBeNull();
    expect(document.querySelector(".site-footer")).toBeNull();
  });
});
