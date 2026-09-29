import type { Page } from "@playwright/test";
import { vendorDict } from "../../apps/vendor/src/i18n";
import { expectHitAreas, expectNoAxeViolations, expectVisibleFocus } from "../support/a11y";
import { expect, test } from "../support/offline";
import { clickBackButton, fakeTelegram } from "../support/telegram";
import { mockVendorApi, NOW, REQUEST_LATE, REQUEST_NEW, type SignIn } from "../support/vendor-api";

/* Кабинет вендора: экраны до входа (вне Telegram и отказы API), входящие, карточка
   заявки, календарь, площадка — на перехваченном /api. */

const t = vendorDict.ru;
const BOT = "https://t.me/bayramm_demo_bot?start=partner";
const CONTROLS = [
  ".btn",
  ".pill",
  ".tab",
  ".lang button",
  ".cal-day",
  ".icon-btn",
  ".back-link",
  ".rq",
  ".choice",
].join(", ");

async function start(page: Page, { telegram = true, signIn = "ok" as SignIn } = {}) {
  await page.clock.setFixedTime(NOW);
  const api = await mockVendorApi(page, { signIn });
  if (telegram) await fakeTelegram(page);
  return api;
}

const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const dayButton = (page: Page, day: number) =>
  page.locator("button.cal-day").filter({ has: page.getByText(String(day), { exact: true }) });

test.describe("до входа", () => {
  test("вне Telegram: «откройте из бота» и ссылка на бота окружения", async ({ page }) => {
    const api = await start(page, { telegram: false });
    await page.goto("/");
    await expect(heading(page)).toHaveText(t.gateOutsideTitle);
    const bot = page.getByRole("link", { name: t.openBot });
    await expect(bot).toHaveAttribute("href", BOT);
    // Кабинета без входа нет: ни вкладок, ни заявок
    await expect(page.locator(".tabbar")).toHaveCount(0);
    await expectNoAxeViolations(page, "вне Telegram");
    await expectHitAreas(page, "вне Telegram", CONTROLS);
    expect(api.unexpected).toEqual([]);
  });

  const GATES: readonly [SignIn, string, boolean][] = [
    ["not_linked", t.gateNotLinkedTitle, true],
    ["disabled", t.gateDisabledTitle, false],
    ["expired", t.gateExpiredTitle, true],
    ["error", t.gateErrorTitle, false],
  ];
  for (const [signIn, title, bot] of GATES) {
    test(`вход ответил ${signIn}: понятный экран`, async ({ page }) => {
      await start(page, { signIn });
      await page.goto("/");
      await expect(heading(page)).toHaveText(title);
      await expect(page.getByRole("link", { name: t.openBot })).toHaveCount(bot ? 1 : 0);
      if (signIn === "error") await expect(page.getByRole("button", { name: t.retry })).toBeVisible();
      await expect(page.locator(".tabbar")).toHaveCount(0);
      await expectNoAxeViolations(page, `вход: ${signIn}`);
    });
  }
});

test.describe("кабинет", () => {
  test("входящие → карточка заявки: телефон клиента, «Я связался», назад кнопкой Telegram", async ({
    page,
  }) => {
    const api = await start(page);
    await page.goto("/");
    await expect(heading(page)).toHaveText(t.requests);
    await expect(page).toHaveURL("/requests");

    const tabs = page.locator(".pills .pill");
    await expect(tabs.nth(0)).toContainText(`${t.tabNew}1`);
    const cards = page.locator(".rq-list .rq");
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText("Азиза");
    // Телефона клиента в списке нет — только в карточке
    await expect(page.locator(".rq-list a[href^='tel:']")).toHaveCount(0);
    await expectNoAxeViolations(page, "входящие");
    await expectHitAreas(page, "входящие", CONTROLS);

    await cards.first().click();
    await expect(page).toHaveURL(`/requests/${REQUEST_NEW}`);
    await expect(heading(page)).toContainText("1051");
    const phone = page.locator("a.btn-phone");
    await expect(phone).toHaveAttribute("href", "tel:+998901234567");
    await expect(page.getByText("Нужен детский стол")).toBeVisible();
    await expectNoAxeViolations(page, "карточка заявки");
    await expectHitAreas(page, "карточка заявки", CONTROLS);

    await page.getByRole("button", { name: t.actContacted }).click();
    await expect(page.locator(".detail-top .chip")).toHaveText(t.st_contacted);
    expect(api.patches).toEqual([{ id: REQUEST_NEW, body: { status: "contacted" } }]);

    // Отказ: форма с причинами, «Отмена» возвращает действия
    await page.getByRole("button", { name: t.actNoDeal }).click();
    await expect(page.locator("form.decline")).toBeVisible();
    await expectNoAxeViolations(page, "отказ");
    await expectHitAreas(page, "отказ", CONTROLS);
    await page.locator("form.decline").getByRole("button", { name: t.cancel }).click();

    await clickBackButton(page);
    await expect(page).toHaveURL("/requests");
    await page.locator(".pills .pill").nth(1).click();
    await expect(page.locator(".rq-list .rq")).toHaveCount(2);
    expect(api.unexpected).toEqual([]);
  });

  test("просроченная заявка помечена в списке и в карточке", async ({ page }) => {
    await start(page);
    await page.goto(`/requests/${REQUEST_LATE}`);
    await expect(page.locator(".detail-top .chip")).toHaveText(t.late);
    await expect(page.locator(".sla-late")).toBeVisible();
  });

  test("календарь: день занимается и освобождается одним нажатием; закрытый менеджером — нет", async ({
    page,
  }) => {
    const api = await start(page);
    await page.goto("/calendar");
    await expect(heading(page)).toHaveText(t.calendar);
    await expect(dayButton(page, 10)).toHaveAttribute("aria-pressed", "true");
    await expectNoAxeViolations(page, "календарь");
    await expectHitAreas(page, "календарь", CONTROLS);

    await dayButton(page, 20).click();
    await expect(dayButton(page, 20)).toHaveAttribute("aria-pressed", "true");
    expect(api.busy.get("2026-10-20")?.source).toBe("vendor");

    await dayButton(page, 10).click();
    await expect(dayButton(page, 10)).toHaveAttribute("aria-pressed", "false");
    expect(api.busy.has("2026-10-10")).toBe(false);

    // aria-disabled, но нажимается: объясняет, почему день не освободить (Playwright такое сам не жмёт)
    await dayButton(page, 17).click({ force: true });
    await expect(page.getByRole("alert")).toHaveText(t.staffLocked);
    await expect(dayButton(page, 17)).toHaveAttribute("aria-pressed", "true");
    expect(api.busy.get("2026-10-17")?.source).toBe("staff");
    expect(api.unexpected).toEqual([]);
  });

  test("площадка: карточка как в базе, без рейтинга", async ({ page }) => {
    const api = await start(page);
    await page.goto("/card");
    await expect(heading(page)).toHaveText(t.card);
    await expect(page.getByText("Lola zali").first()).toBeVisible();
    const text = await page.locator("main").innerText();
    expect(text).not.toMatch(/★|рейтинг|reyting|отзыв|sharh|брон|bron/i);
    await expectNoAxeViolations(page, "площадка");
    await expectHitAreas(page, "площадка", CONTROLS);
    expect(api.unexpected).toEqual([]);
  });

  for (const path of ["/requests", "/calendar"]) {
    test(`${path}: фокус с клавиатуры виден`, async ({ page }) => {
      await start(page);
      await page.goto(path);
      await heading(page).waitFor();
      await expectVisibleFocus(page, path, 12);
    });
  }

  test("экраны без горизонтальной прокрутки", async ({ page }) => {
    await start(page);
    const width = page.viewportSize()?.width ?? 0;
    for (const path of ["/requests", `/requests/${REQUEST_NEW}`, "/calendar", "/card"]) {
      await page.goto(path);
      await heading(page).waitFor();
      const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
      expect.soft(scroll, path).toBeLessThanOrEqual(width);
    }
  });
});
