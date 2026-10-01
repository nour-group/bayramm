import type { Page } from "@playwright/test";
import { expect, test } from "../support/offline";
import { clickBackButton, clickMainButton, fakeTelegram } from "../support/telegram";
import { isDesktop, open, PATHS, prepare, T } from "../support/web";

/* Каталог → витрина → форма заявки → «назад»: в браузере и внутри Telegram. Новый экран —
   сверху; «назад» возвращает ту же выдачу сразу (снимок и кэш вкладки — без заглушки и без
   нового запроса) и на то же место прокрутки (router.ts запоминает её у записи истории). */

const ru = T.ru;

/**
 * Следить, появлялась ли заглушка загрузки выдачи. Демо-API отвечает с задержкой (350 мс),
 * поэтому новый запрос выдачи всегда показал бы заглушку: её нет — выдача из снимка вкладки
 */
async function watchCatalog(page: Page): Promise<() => Promise<boolean>> {
  await page.evaluate(() => {
    const state = { skeleton: false };
    Object.defineProperty(window, "__catalogWatch", { value: state, configurable: true });
    new MutationObserver(() => {
      if (document.querySelector(".catalog .state-cards")) state.skeleton = true;
    }).observe(document.body, { childList: true, subtree: true });
  });
  return () =>
    page.evaluate(
      () => (window as unknown as { __catalogWatch: { skeleton: boolean } }).__catalogWatch.skeleton,
    );
}

/** Прокрутить к карточке далеко в списке и вернуть её название и прокрутку */
async function scrollToCard(page: Page): Promise<{ name: string; y: number }> {
  const card = page.locator(".cards .card").nth(isDesktop(page) ? 9 : 5);
  await card.scrollIntoViewIfNeeded();
  const y = await page.evaluate(() => window.scrollY);
  expect(y).toBeGreaterThan(200);
  return { name: (await card.locator(".card-name").textContent()) ?? "", y };
}

test("браузер: «назад» из витрины — та же выдача на том же месте, без заглушки", async ({ page }) => {
  await prepare(page);
  await open(page, PATHS.catalog, ".cards .card");
  const { name, y } = await scrollToCard(page);
  await page.locator(".card", { hasText: name }).locator(".card-link").click();
  await expect(page.locator(".venue-head h1")).toHaveText(name);
  // Новый экран открывается сверху
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

  const watched = await watchCatalog(page);
  await page.goBack();
  await expect(page.locator(".cards .card-name", { hasText: name })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(y);
  expect(await watched(), "заглушка выдачи").toBe(false);
});

test("Telegram: каталог → витрина → форма; «назад» Telegram дважды — каталог на том же месте", async ({
  page,
}) => {
  await prepare(page);
  await fakeTelegram(page);
  await open(page, PATHS.home, ".catalog .cards .card");
  const { name, y } = await scrollToCard(page);
  await page.locator(".card", { hasText: name }).locator(".card-link").click();
  await expect(page.locator(".venue-head h1")).toHaveText(name);
  await clickMainButton(page);
  await expect(page.getByRole("heading", { level: 1, name: ru.rqTitle })).toBeVisible();

  const watched = await watchCatalog(page);
  await clickBackButton(page);
  await expect(page.locator(".venue-head h1")).toHaveText(name);
  await clickBackButton(page);
  await expect(page.locator(".catalog .cards .card-name", { hasText: name })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(y);
  expect(await watched(), "заглушка выдачи").toBe(false);
});
