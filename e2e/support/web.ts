import { type Dict, dictionaries, type Lang } from "@bayramm/shared";
import type { Page } from "@playwright/test";
import { demoListings } from "../../apps/web/src/api/mock";
import { addDays } from "../../apps/web/src/format";

/* Клиент в демо-режиме (`vite` с VITE_API=mock): данные — те же демо-площадки, что
   строит приложение, тексты — из общих словарей. Часы страницы заморожены: даты в
   выдаче и календаре не зависят от дня прогона. */

/** 1 октября 2026, 12:00 по Ташкенту — как в тестах экранов apps/web */
export const NOW = new Date("2026-10-01T07:00:00Z");
export const TODAY = "2026-10-01";
/** Через неделю: каждая третья демо-площадка на эту дату занята */
export const BUSY_DAY = addDays(TODAY, 7);
export const LISTINGS = demoListings(TODAY);

export const VENUE =
  LISTINGS[0] ??
  (() => {
    throw new Error("нет демо-площадок");
  })();

export const T: Readonly<Record<Lang, Dict>> = dictionaries;
export const LANG_KEY = "bayramm.web.lang";

export const PATHS = {
  /** Корень: в браузере — лендинг, внутри Telegram — каталог */
  home: "/",
  catalog: "/catalog",
  venue: (slug: string) => `/venue/${slug}`,
  request: (slug: string) => `/venue/${slug}/request`,
  favorites: "/favorites",
  requests: "/requests",
  profile: "/profile",
  docs: "/docs",
  notFound: "/nope",
} as const;

/** Главные экраны: путь и чего ждать на экране, когда он загрузился */
export const SCREENS = [
  { name: "лендинг", path: PATHS.home, ready: ".ln-hero h1" },
  { name: "каталог", path: PATHS.catalog, ready: ".card" },
  { name: "площадка", path: PATHS.venue(VENUE.slug), ready: ".venue-head h1" },
  { name: "форма заявки", path: PATHS.request(VENUE.slug), ready: "form.request .consents" },
  { name: "сохранённое", path: PATHS.favorites, ready: ".cards, .state-empty" },
  { name: "мои заявки", path: PATHS.requests, ready: ".reqs, .state-empty" },
  { name: "профиль", path: PATHS.profile, ready: ".docs" },
  { name: "документы", path: PATHS.docs, ready: ".docs" },
  { name: "не найдено", path: PATHS.notFound, ready: ".state-empty h1" },
] as const;

/** С этой ширины — раскладка компьютера: разделы в шапке, нижней панели нет (styles.css) */
export const DESKTOP_MIN = 1024;

export const isDesktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= DESKTOP_MIN;

/** Разделы, которые видны на этой ширине: нижняя панель телефона или разделы в шапке */
export const sections = (page: Page) => page.locator("nav.tabs:visible, nav.site-nav:visible");

export interface OpenOptions {
  /** Язык интерфейса; по умолчанию — из браузера (ru) */
  readonly lang?: Lang;
  /** Обычный браузер без входа: ?guest (иначе демо разрешает заявки и без Telegram) */
  readonly guest?: boolean;
}

/** Заморозить часы и задать язык до загрузки. Вызывать один раз на страницу, до goto */
export async function prepare(page: Page, { lang }: OpenOptions = {}): Promise<void> {
  await page.clock.setFixedTime(NOW);
  if (lang)
    await page.addInitScript(
      ({ key, value }) => {
        // Только при первом открытии вкладки: переключатель языка дальше решает сам
        if (window.sessionStorage.getItem(key) === null) window.sessionStorage.setItem(key, value);
      },
      { key: LANG_KEY, value: lang },
    );
}

/** Открыть экран клиента и дождаться, пока он загрузится */
export async function open(page: Page, path: string, ready?: string, { guest }: OpenOptions = {}) {
  const url = guest ? `${path}${path.includes("?") ? "&" : "?"}guest` : path;
  await page.goto(url);
  if (ready) await page.locator(ready).first().waitFor();
}

/** Видимый текст экрана и то, что читает диктор: подписи, подсказки, alt, title */
export function humanText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const attrs = ["aria-label", "title", "placeholder", "alt", "aria-description"];
    const extra = [...document.querySelectorAll("*")].flatMap((el) =>
      attrs.map((name) => el.getAttribute(name) ?? "").filter(Boolean),
    );
    return [document.title, document.body.innerText, ...extra].join("\n");
  });
}

/** Нет горизонтальной прокрутки: ни документ, ни body не шире вьюпорта */
export function horizontalOverflow(page: Page): Promise<{ scrollWidth: number; bodyWidth: number }> {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }));
}
