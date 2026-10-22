import type { Page } from "@playwright/test";
import { expect, test } from "../support/offline";
import { fakeTelegram } from "../support/telegram";
import { open, PATHS, prepare, T } from "../support/web";

/* Первый экран каталога на телефоне — выдача, а не пояснения: что в разделе и про цены — с
   планшета, как сравнили цены — в шторке «Фильтры», заголовок Mini App — одной строкой.
   Только проект web-phone (390×844, сенсорный экран); 320×640 задаёт сам тест. */

test.skip(({ isMobile }) => !isMobile, "телефон: проект web-phone");

const ru = T.ru;

/** Где первая карточка: верх фото и низ названия */
const firstCard = (page: Page) =>
  page
    .locator(".catalog .card")
    .first()
    .evaluate((card) => ({
      top: card.getBoundingClientRect().top,
      nameBottom:
        card.querySelector(".card-name")?.getBoundingClientRect().bottom ?? Number.POSITIVE_INFINITY,
    }));

test.describe("первый экран каталога на телефоне", () => {
  // «Все» — по разделам, пояснений про цены нет; у зала оно — в шторке «Фильтры»
  for (const [path, maxTop] of [
    [PATHS.catalog, 470],
    [PATHS.category("hall"), 422],
  ] as const) {
    test(`сайт 390×844 ${path}: карточка начинается в верхней половине, название — на первом экране`, async ({
      page,
    }) => {
      await prepare(page);
      await open(page, path, ".catalog .card", { guest: true });
      const card = await firstCard(page);
      expect(card.top, "верх первой карточки").toBeLessThanOrEqual(maxTop);
      expect(card.nameBottom, "название первой карточки").toBeLessThanOrEqual(844);
      // Пояснения — не на телефоне
      await expect(page.locator(".catalog-head .catalog-note")).toBeHidden();
      await expect(page.locator(".catalog-head .cat-lead")).toBeHidden();
      await expect(page.locator(".catalog-list .sort-hint")).toBeHidden();
    });
  }

  test("зал: как сравнили цены — у порядка в шторке «Фильтры»", async ({ page }) => {
    await prepare(page);
    await open(page, PATHS.category("hall"), ".catalog .card", { guest: true });
    await page.locator(".filters-open").click();
    await expect(page.getByRole("dialog").locator(".sheet-hint")).toHaveText(ru.sortHintPerGuest);
  });

  test("Mini App 320×640: заголовок в одну строку, фото первой карточки — над нижней панелью", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await prepare(page);
    await fakeTelegram(page);
    await open(page, PATHS.home, ".catalog .card");
    const heading = page.getByRole("heading", { level: 1 });
    await expect(heading).toHaveText(ru.catAllShort);
    const lines = await heading.evaluate((h) => {
      const style = getComputedStyle(h);
      return Math.round(h.getBoundingClientRect().height / Number.parseFloat(style.lineHeight));
    });
    expect(lines, "строк в заголовке").toBe(1);
    const tabs = await page.locator("nav.tabs").evaluate((nav) => nav.getBoundingClientRect().top);
    const card = await firstCard(page);
    expect(card.top, "верх фото первой карточки над нижней панелью").toBeLessThan(tabs - 40);
  });
});
