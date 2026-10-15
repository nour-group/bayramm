import type { Page } from "@playwright/test";
import { expectHitAreas, expectNoAxeViolations } from "../support/a11y";
import { expect, test } from "../support/offline";
import { fakeTelegram } from "../support/telegram";
import { horizontalOverflow, isDesktop, open, PATHS, prepare, T } from "../support/web";

/* Поиск по каталогу на живом клиенте (демо-API ищет так же, как сервер): с опечаткой и
   кириллицей, подсказки — combobox (стрелки, Enter, Esc, вслух — сколько нашлось), Enter —
   выдача по ?q= в адресе, пустые выдачи, «назад» из витрины, поиск в шапке сайта и вверху
   вкладки каталога в Telegram; доступность открытого списка. */

const ru = T.ru;

const field = (page: Page) => page.locator("#catalog-search");
const popup = (page: Page) => page.locator(".catalog .ui-suggest-pop");
const option = (page: Page, name: string | RegExp) =>
  popup(page).getByRole("option", { name, exact: typeof name === "string" });

async function expectNoOverflow(page: Page, what: string) {
  const width = page.viewportSize()?.width ?? 0;
  const overflow = await horizontalOverflow(page);
  expect(overflow.scrollWidth, `${what}: ширина документа`).toBeLessThanOrEqual(width);
  expect(overflow.bodyWidth, `${what}: ширина body`).toBeLessThanOrEqual(width);
}

test.beforeEach(async ({ page }) => {
  await prepare(page);
});

test("с опечаткой и кириллицей: подсказка ведёт на страницу исполнителя", async ({ page }) => {
  await open(page, PATHS.catalog, ".cards .card");
  await field(page).click();
  // «лимузн» — кириллицей и без буквы: найдётся «Limuzin Lux»
  await field(page).pressSequentially("лимузн");
  await expect(option(page, /Limuzin Lux/)).toBeVisible();
  await expect(field(page)).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator('.catalog .ui-suggest [aria-live="polite"]')).toHaveText(/^Нашлось \d+$/);
  await option(page, /Limuzin Lux/).click();
  await expect(page.locator(".venue-head h1")).toHaveText("Limuzin Lux");
});

test("стрелки и Enter выбирают подсказку, Esc закрывает список", async ({ page }) => {
  await open(page, PATHS.catalog, ".cards .card");
  await field(page).click();
  await field(page).pressSequentially("кортеж");
  await expect(option(page, ru.catName.car)).toBeVisible();
  await page.keyboard.press("ArrowDown");
  const active = await field(page).getAttribute("aria-activedescendant");
  expect(active).toBeTruthy();
  await expect(page.locator(`[id="${active}"]`)).toHaveText(ru.catName.car);
  await page.keyboard.press("Escape");
  await expect(popup(page)).toHaveCount(0);
  await expect(field(page)).toHaveAttribute("aria-expanded", "false");
  await expect(field(page)).toBeFocused();
  // Снова вниз — список открыт; Enter на подсказке раздела — раздел
  await page.keyboard.press("ArrowDown");
  await expect(option(page, ru.catName.car)).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/catalog\?category=car$/);
});

test("Enter — выдача по ?q=: заголовок с числом; «назад» из витрины — та же выдача на том же месте", async ({
  page,
}) => {
  await open(page, PATHS.catalog, ".cards .card");
  await field(page).click();
  await field(page).pressSequentially("zali");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/catalog\?q=zali$/);
  const heading = page.locator(".catalog-head h1");
  await expect(heading).toHaveText(/^По запросу «zali» — \d+$/);
  const total = Number((await heading.textContent())?.split("— ")[1]);
  expect(total).toBeGreaterThan(10);
  await expect(page.locator(".sort .ui-select-value")).toHaveText(ru.s_relevance);

  const card = page.locator(".cards .card").nth(isDesktop(page) ? 9 : 5);
  await card.scrollIntoViewIfNeeded();
  const y = await page.evaluate(() => window.scrollY);
  expect(y).toBeGreaterThan(200);
  const name = (await card.locator(".card-name").textContent()) ?? "";
  await card.locator(".card-link").click();
  await expect(page.locator(".venue-head h1")).toHaveText(name);
  await page.goBack();
  await expect(page).toHaveURL(/\/catalog\?q=zali$/);
  await expect(heading).toHaveText(`По запросу «zali» — ${total}`);
  await expect(field(page)).toHaveValue("zali");
  await expect(page.locator(".cards .card-name", { hasText: name })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(y);
});

test("пусто в разделе — ссылка в другие разделы; пусто везде — популярные разделы и сброс", async ({
  page,
}) => {
  await open(page, `${PATHS.category("flowers")}&q=kortej`, ".state-empty");
  await expect(page.getByRole("heading", { name: ru.srEmptyInH(ru.catName.flowers) })).toBeVisible();
  await page.getByRole("link", { name: ru.srElsewhere(3) }).click();
  await expect(page).toHaveURL(/\/catalog\?q=kortej$/);
  await expect(page.locator(".cards .card")).toHaveCount(3);

  await open(page, `${PATHS.catalog}?q=qwxyzz`, ".state-empty");
  await expect(page.getByRole("heading", { name: ru.srNoneH })).toBeVisible();
  await expect(page.locator(".search-popular a").first()).toBeVisible();
  await page.getByRole("button", { name: ru.srClear }).click();
  await expect(page).toHaveURL(/\/catalog$/);
  await expect(page.locator(".cards .card").first()).toBeVisible();
});

test("доступность открытого списка: axe, кольцо фокуса, 44px, без прокрутки вбок", async ({ page }) => {
  await open(page, PATHS.catalog, ".cards .card");
  // С клавиатуры: Tab доходит до поля, кольцо фокуса видно
  await field(page).focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(field(page)).toBeFocused();
  const ring = await field(page).evaluate((el) => {
    const style = getComputedStyle(el);
    return style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) >= 2;
  });
  expect(ring, "кольцо фокуса у поля поиска").toBe(true);
  // 16px — иначе iOS увеличивает страницу при фокусе
  expect(await field(page).evaluate((el) => getComputedStyle(el).fontSize)).toBe("16px");

  await field(page).pressSequentially("chilonzor");
  await expect(popup(page).getByRole("group", { name: ru.srAreas })).toBeVisible();
  await expectNoAxeViolations(page, "открытые подсказки поиска");
  await expectHitAreas(
    page,
    "подсказки и крестик",
    ".catalog .ui-suggest .ui-option, .catalog .ui-search-clear",
  );
  await expectNoOverflow(page, "открытые подсказки");
  // Список — под полем и не уходит за нижний край экрана
  const fieldBox = await field(page).boundingBox();
  const popBox = await popup(page).boundingBox();
  const height = page.viewportSize()?.height ?? 0;
  expect(popBox && fieldBox && popBox.y).toBeGreaterThan((fieldBox?.y ?? 0) + (fieldBox?.height ?? 0) - 1);
  expect((popBox?.y ?? 0) + (popBox?.height ?? 0)).toBeLessThanOrEqual(height);
});

test("поиск в шапке сайта: на телефоне — значок с фокусом в поле, на компьютере — поле", async ({ page }) => {
  await open(page, PATHS.docs, ".docs", { guest: true });
  if (isDesktop(page)) {
    const header = page.locator("#site-search");
    await header.click();
    await header.pressSequentially("Toʻyxona");
    await expect(page.locator(".top .ui-suggest-pop").getByRole("option").first()).toBeVisible();
    await expectNoAxeViolations(page, "подсказки поиска в шапке");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/catalog\?q=/);
    await expect(page.locator(".catalog-head h1")).toHaveText(/^По запросу «Toʻyxona» — \d+$/);
  } else {
    await expect(page.locator("#site-search")).toBeHidden();
    await page.locator(".top .top-search").click();
    await expect(page).toHaveURL(/\/catalog$/);
    await expect(field(page)).toBeFocused();
  }
  // На каталоге поиск — только в нём самом
  await expect(page.locator(".top .top-search, #site-search")).toHaveCount(0);
  await expectNoOverflow(page, "каталог с поиском");
});

test("Telegram: поле — вверху вкладки каталога, в шапке поиска нет", async ({ page }) => {
  await fakeTelegram(page);
  await open(page, PATHS.home, ".catalog .cards .card");
  await expect(field(page)).toBeVisible();
  await expect(page.locator(".top .top-search, #site-search")).toHaveCount(0);
  const order = await page.evaluate(() => {
    const all = [...document.querySelectorAll(".catalog *")];
    return [".catalog-search", ".cat-switch"].map((s) => all.indexOf(document.querySelector(s) as Element));
  });
  expect(order[0]).toBeLessThan(order[1] ?? 0);
  await field(page).click();
  await field(page).pressSequentially("kortej");
  await page.keyboard.press("Enter");
  await expect(page.locator(".catalog-head h1")).toHaveText("По запросу «kortej» — 3");
});
