import type { Page } from "@playwright/test";
import { expect, test } from "../support/offline";
import { open, PATHS, prepare, T, VENUE } from "../support/web";

/* Экран не прыгает, когда приходят данные (демо-API отвечает с задержкой 350 мс): сдвиг вёрстки
   (CLS, PerformanceObserver layout-shift без недавнего ввода) — меньше 0,1. Длинное название
   витрины не расширяет страницу на 320px; на компьютере название, район и цена витрины — на первом
   экране. */

const ru = T.ru;

/** Считать сдвиги вёрстки с открытия страницы */
async function watchShifts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __cls: number };
    w.__cls = 0;
    if (typeof PerformanceObserver !== "function") return;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[])
        if (!entry.hadRecentInput) w.__cls += entry.value;
    }).observe({ type: "layout-shift", buffered: true });
  });
}

const shifts = (page: Page) => page.evaluate(() => (window as unknown as { __cls: number }).__cls);

test.describe("экран не прыгает, когда приходят данные", () => {
  // Телефон: там экраны длиннее окна и сдвиг заметнее всего; компьютер — тот же код
  test.skip(({ isMobile }) => !isMobile, "телефон: проект web-phone");
  for (const [name, path, ready, guest] of [
    ["пустое «Сохранённое» гостя", PATHS.favorites, ".state-empty", true],
    ["профиль", PATHS.profile, ".docs", false],
    ["каталог залов", PATHS.category("hall"), ".card", true],
    ["витрины нет", PATHS.venue("net-takoy-vitriny"), ".state-empty h1", true],
  ] as const) {
    test(`${name}: CLS < 0,1`, async ({ page }) => {
      await prepare(page);
      await watchShifts(page);
      await open(page, path, ready, { guest });
      // Догрузки после первого содержимого (справочники, тексты, профиль) — тоже в счёт
      await page.waitForTimeout(1200);
      expect(await shifts(page), name).toBeLessThan(0.1);
    });
  }
});

test("длинное название витрины на 320px: страница не шире экрана, сердечко на экране", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await prepare(page);
  await open(page, PATHS.venue(VENUE.slug), ".venue-head h1", { guest: true });
  await page.locator(".venue-head h1").evaluate((h1) => {
    h1.textContent = "Muhammadqodir Toʻyxonasi va Banket Zallari Majmuasi Chilonzor";
  });
  const box = await page.evaluate(() => {
    const heart = document.querySelector(".venue-head .fav-btn")?.getBoundingClientRect();
    return { scroll: document.documentElement.scrollWidth, heart: heart?.right ?? 0 };
  });
  expect(box.scroll, "ширина документа").toBeLessThanOrEqual(320);
  expect(box.heart, "сердечко").toBeLessThanOrEqual(320);
});

test("компьютер 1280×800: название, район и цена витрины — на первом экране", async ({ page, isMobile }) => {
  test.skip(isMobile, "компьютер: проект web-desktop");
  await page.setViewportSize({ width: 1280, height: 800 });
  await prepare(page);
  await open(page, PATHS.venue(VENUE.slug), ".venue-head h1", { guest: true });
  const fold = await page.evaluate(() => {
    const bottom = (selector: string) =>
      document.querySelector(selector)?.getBoundingClientRect().bottom ?? 9999;
    return {
      gallery: document.querySelector(".gallery")?.getBoundingClientRect().height ?? 9999,
      name: bottom(".venue-head h1"),
      meta: bottom(".venue-meta"),
      price: bottom(".venue-side .bar-price"),
    };
  });
  expect(fold.gallery, "галерея").toBeLessThanOrEqual(440);
  expect(fold.name, "название").toBeLessThanOrEqual(800);
  expect(fold.meta, "район и вместимость").toBeLessThanOrEqual(800);
  expect(fold.price, "цена").toBeLessThanOrEqual(800);
  await expect(page.getByRole("heading", { level: 1 })).not.toHaveText(ru.venueGoneH);
});
