// @vitest-environment jsdom
import { lowerFirst } from "@bayramm/shared";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allDemoListings, createMockApi } from "./api/mock";
import type { ClientApi } from "./api/types";
import { LANG_KEY } from "./context";
import { byText, cleanup, click, fakeWebApp, mount, NOW, settle, type } from "./test/harness";

/* Поиск по каталогу: поле над разделами (combobox с подсказками), подсказки с паузой и отменой
   прежнего запроса, выдача по ?q= вместе с разделом и фильтрами, пустые выдачи, поиск в шапке
   сайта. Демо-API ищет так же, как сервер (@bayramm/shared/search). */

const ALL = allDemoListings("2026-10-01");

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.sessionStorage.setItem(LANG_KEY, "ru");
  window.scrollTo = () => {};
});

afterEach(cleanup);

/** Дождаться условия в настоящем времени: подсказки ждут паузу 250 мс */
async function eventually<T>(check: () => T | null | undefined | false, what: string, ms = 3000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > until) throw new Error(`не дождались: ${what}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
}

const catalogField = () => document.getElementById("catalog-search") as HTMLInputElement;
const options = () => [...document.querySelectorAll<HTMLElement>('#main [role="option"]')];
const groupLabels = () =>
  [...document.querySelectorAll<HTMLElement>('#main [role="group"]')].map(
    (g) => document.getElementById(g.getAttribute("aria-labelledby") ?? "")?.textContent,
  );
const cardNames = () => [...document.querySelectorAll(".cards .card-name")].map((n) => n.textContent);
const path = () => `${window.location.pathname}${window.location.search}`;

async function press(element: Element, key: string) {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
  await settle();
}

/** Демо-API, у которого видно каждый запрос подсказок и его отмену */
function watchedApi(latencyMs = 0) {
  const api = createMockApi({ now: () => NOW, listings: ALL, latencyMs });
  const calls: { q: string; signal: AbortSignal | undefined }[] = [];
  const watched: ClientApi = {
    ...api,
    suggest: (q, signal) => {
      calls.push({ q, signal });
      return api.suggest(q, signal);
    },
  };
  return { api: watched, calls };
}

describe("поиск в каталоге", () => {
  it("поле — вверху, над разделами, во всю ширину; combobox поиска с клавишей «Найти»", async () => {
    await mount({ path: "/catalog", mock: { listings: ALL } });
    const screen = document.querySelector(".catalog") as HTMLElement;
    const order = [".catalog-head h1", ".catalog-search", ".cat-switch", ".filters-panel"].map((selector) =>
      [...screen.querySelectorAll("*")].indexOf(screen.querySelector(selector) as Element),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    const field = catalogField();
    expect(field.getAttribute("role")).toBe("combobox");
    expect(field.getAttribute("type")).toBe("search");
    expect(field.getAttribute("enterkeyhint")).toBe("search");
    expect(field.getAttribute("aria-label")).toBe("Поиск по каталогу");
    expect(field.getAttribute("placeholder")).toBe("Зал, фотограф, торт…");
    expect(field.getAttribute("spellcheck")).toBe("false");
  });

  it("подсказки — с двух символов и после паузы: разделы, районы в разделе, исполнители", async () => {
    const { api, calls } = watchedApi();
    await mount({ path: "/catalog", api });
    await type(catalogField(), "к");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(calls).toEqual([]);
    await type(catalogField(), "кортеж");
    await eventually(() => options().length > 0, "подсказки");
    expect(calls.map((c) => c.q)).toEqual(["кортеж"]);
    expect(groupLabels()).toEqual(["Разделы", "Исполнители"]);
    expect(options().map((o) => o.textContent)).toEqual([
      "Кортежи",
      "Oq KortejКортежи",
      "Limuzin LuxКортежи",
      "Retro AvtoКортежи",
    ]);
    expect(catalogField().getAttribute("aria-expanded")).toBe("true");
    // Сколько подсказок — вслух
    expect(document.querySelector('#main [aria-live="polite"]')?.textContent).toBe("Нашлось 4");

    await type(catalogField(), "chilonzor");
    await eventually(() => groupLabels().includes("Районы"), "районы");
    const districts = options().filter((o) => o.textContent?.startsWith("Чиланзар"));
    expect(districts[0]?.textContent).toBe("Чиланзар — тойханы");
  });

  it("новая буква отменяет прежний запрос подсказок", async () => {
    const { api, calls } = watchedApi(400);
    await mount({ path: "/catalog", api });
    await type(catalogField(), "kor");
    await eventually(() => calls.length === 1, "первый запрос");
    await type(catalogField(), "kortej");
    await eventually(() => calls.length === 2, "второй запрос");
    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(calls[1]?.signal?.aborted).toBe(false);
  });

  it("с опечаткой и кириллицей — те же исполнители", async () => {
    await mount({ path: "/catalog", mock: { listings: ALL } });
    await type(catalogField(), "limuzn");
    await eventually(() => options().some((o) => o.textContent?.startsWith("Limuzin Lux")), "опечатка");
    await type(catalogField(), "лимузин");
    await eventually(() => options().some((o) => o.textContent?.startsWith("Limuzin Lux")), "кириллица");
  });

  it("Enter — выдача по ?q= в том же разделе и с теми же фильтрами; заголовок с числом", async () => {
    await mount({ path: "/catalog?category=car&date=2026-10-08", mock: { listings: ALL } });
    await type(catalogField(), "limuzin");
    await press(catalogField(), "Enter");
    expect(new URLSearchParams(window.location.search).get("q")).toBe("limuzin");
    expect(new URLSearchParams(window.location.search).get("category")).toBe("car");
    expect(new URLSearchParams(window.location.search).get("date")).toBe("2026-10-08");
    await eventually(() => cardNames().length > 0, "выдача");
    expect(cardNames()[0]).toBe("Limuzin Lux");
    expect(document.querySelector("h1")?.textContent).toBe(`По запросу «limuzin» — ${cardNames().length}`);
    expect(document.title).toBe("По запросу «limuzin» · Bayramm");
    // Порядок по умолчанию с поиском — «сначала подходящие»; разделы ведут с тем же запросом
    expect(document.querySelector(".sort .ui-select-value")?.textContent).toBe("Сначала подходящие");
    expect(document.querySelector('.cat-switch a[aria-current="page"]')?.getAttribute("href")).toBe(
      "/catalog?category=car&q=limuzin&date=2026-10-08",
    );
  });

  it("подсказка ведёт сразу: раздел — в раздел, исполнитель — на его страницу", async () => {
    await mount({ path: "/catalog", mock: { listings: ALL } });
    await type(catalogField(), "кортеж");
    await eventually(() => options().length > 0, "подсказки");
    await click(options()[0]);
    expect(path()).toBe("/catalog?category=car");
    expect(catalogField().value).toBe("");

    await type(catalogField(), "retro");
    await eventually(() => options().some((o) => o.textContent?.startsWith("Retro Avto")), "исполнитель");
    await press(catalogField(), "ArrowDown");
    const active = document.getElementById(catalogField().getAttribute("aria-activedescendant") ?? "");
    expect(active?.textContent).toContain("Retro Avto");
    await press(catalogField(), "Enter");
    expect(window.location.pathname).toMatch(/^\/venue\//);
  });

  it("пусто в разделе — «В других разделах — N» ведёт во «Все» с тем же запросом", async () => {
    await mount({ path: "/catalog?category=flowers&q=kortej", mock: { listings: ALL } });
    const link = await eventually(() => byText<HTMLAnchorElement>("#main a", /В других разделах/), "ссылка");
    expect(document.querySelector("h1")?.textContent).toBe("По запросу «kortej» — 0");
    expect(byText("h2", /В разделе «Цветы» по запросу ничего нет/)).not.toBeNull();
    expect(link.textContent).toBe("В других разделах — 3");
    expect(link.getAttribute("href")).toBe("/catalog?q=kortej");
  });

  it("пусто везде — популярные разделы и «Сбросить поиск»", async () => {
    await mount({ path: "/catalog?q=qwxyzz", mock: { listings: ALL } });
    await eventually(() => byText("h2", "Ничего не нашли"), "пусто");
    expect(document.querySelectorAll(".search-popular a").length).toBeGreaterThan(0);
    await click(byText("button", "Сбросить поиск"));
    expect(path()).toBe("/catalog");
    await eventually(() => cardNames().length > 0, "каталог без поиска");
  });

  it("очистили поле крестиком — поиск снят, выдача — весь раздел", async () => {
    await mount({ path: "/catalog?category=car&q=limuzin", mock: { listings: ALL } });
    await eventually(() => cardNames().length > 0, "выдача");
    expect(catalogField().value).toBe("limuzin");
    await click(document.querySelector("#main .ui-search-clear"));
    expect(path()).toBe("/catalog?category=car");
    await eventually(() => cardNames().length === 3, "все кортежи");
  });

  it("q короче двух символов в адресе — не поиск", async () => {
    await mount({ path: "/catalog?category=car&q=a", mock: { listings: ALL } });
    await eventually(() => cardNames().length === 3, "все кортежи");
    expect(document.querySelector("h1")?.textContent).toBe("Кортежи в Ташкенте");
  });
});

describe("поиск в шапке сайта", () => {
  it("значок открывает каталог с фокусом в поле поиска", async () => {
    await mount({ path: "/favorites", mock: { listings: ALL } });
    const icon = document.querySelector<HTMLAnchorElement>(".top .top-search");
    expect(icon?.getAttribute("aria-label")).toBe("Поиск");
    expect(icon?.getAttribute("href")).toBe("/catalog");
    await click(icon);
    expect(window.location.pathname).toBe("/catalog");
    await eventually(() => document.activeElement === catalogField(), "фокус в поле");
    // На каталоге поиска в шапке нет: поле уже на экране
    expect(document.querySelector(".top .top-search")).toBeNull();
    expect(document.getElementById("site-search")).toBeNull();
  });

  it("поле шапки: Enter — каталог с ?q=", async () => {
    await mount({ path: "/docs", mock: { listings: ALL } });
    const field = document.getElementById("site-search") as HTMLInputElement;
    await type(field, "Toʻyxona");
    await press(field, "Enter");
    expect(path()).toBe(`/catalog?q=${encodeURIComponent("Toʻyxona")}`);
    await eventually(() => cardNames().length > 0, "выдача");
    expect(catalogField().value).toBe("Toʻyxona");
  });

  it("в Telegram поиска в шапке нет — поле вверху вкладки каталога", async () => {
    const { webApp } = fakeWebApp();
    await mount({ path: "/favorites", webApp, mock: { listings: ALL } });
    expect(document.querySelector(".top .top-search")).toBeNull();
    cleanup();
    await mount({ path: "/catalog", webApp, mock: { listings: ALL } });
    expect(catalogField()).not.toBeNull();
  });
});

describe("подписи подсказок", () => {
  it("раздел после района — со строчной, сокращения — как есть", () => {
    expect(lowerFirst("Тойханы")).toBe("тойханы");
    expect(lowerFirst("Фото и видео")).toBe("фото и видео");
    expect(lowerFirst("ЗАГС")).toBe("ЗАГС");
    expect(lowerFirst("FHDYo")).toBe("FHDYo");
  });
});
