import type { Page } from "@playwright/test";
import { t } from "../../apps/admin/src/texts";
import { expectHitAreas, expectNoAxeViolations } from "../support/a11y";
import { expect, test } from "../support/offline";
import { CAR_CONTACTS, CAR_LISTING_ID, mockStaffApi, NOW } from "../support/staff-api";

/* «Партнёр предлагает новые контакты» на странице витрины: блок виден, пока есть ждущее
   предложение; номера — только по «Показать» (сервер пишет чтение в журнал); одобрить — контакты
   витрины новые, отклонить — только с причиной. Решает модератор или администратор, менеджеру —
   что предложение есть и кто решает. Идёт и на компьютере, и на телефоне. */

const CONTROLS = [".btn", ".action", ".nav a", ".tab", ".chips button", ".ui-select", ".reason-chip"].join(
  ", ",
);

async function start(page: Page, options: Parameters<typeof mockStaffApi>[1] = {}) {
  await page.clock.setFixedTime(NOW);
  return mockStaffApi(page, { seeded: true, contactChange: true, ...options });
}

const block = (page: Page) => page.getByRole("region", { name: t.contactChange.title });
const PROPOSED = "+998 90 999 88 77";

test.describe("смена контактов витрины", () => {
  test("«Показать» → «сейчас» и «предлагает» → «Одобрить»: контакты витрины новые, блок уходит", async ({
    page,
  }) => {
    const api = await start(page, { role: "moderator" });
    await page.goto(`/listings/${CAR_LISTING_ID}`);
    const region = block(page);
    await expect(region).toBeVisible();
    // Что меняется — словами; номеров до «Показать» нет нигде на странице
    await expect(region).toContainText("Меняет: телефон и Telegram");
    await expect(region).toContainText(t.contactChange.keep);
    await expect(region).not.toContainText(PROPOSED);
    await expect(region.getByRole("button", { name: t.contactChange.approve })).toHaveCount(0);
    await expectNoAxeViolations(page, "контакты: предложение");
    await expectHitAreas(page, "контакты: предложение", CONTROLS);

    await region.getByRole("button", { name: t.show }).click();
    await expect(region).toContainText(PROPOSED);
    await expect(region).toContainText(t.contactChange.removeTelegram);
    // «Сейчас» — то, что у витрины в базе
    await expect(region.locator(".change").first()).toContainText("+998 90 111 22 33");
    await expect(region.locator(".change").first()).toContainText(`@${CAR_CONTACTS.telegram}`);
    expect(api.contactChanges.map((c) => c.key)).toEqual([
      `POST /staff/listings/${CAR_LISTING_ID}/contact-change/reveal`,
    ]);
    await expectNoAxeViolations(page, "контакты: показаны");
    await expectHitAreas(page, "контакты: показаны", CONTROLS);

    await region.getByRole("button", { name: t.contactChange.approve }).click();
    const sheet = page.getByRole("dialog", { name: t.contactChange.approve });
    await expect(sheet).toContainText(t.contactChange.approveHint);
    await expectNoAxeViolations(page, "контакты: одобрить");
    await sheet.getByRole("button", { name: t.contactChange.approve }).click();
    await expect(page.getByRole("status").filter({ hasText: t.contactChange.approved })).toBeVisible();
    await expect(region).toHaveCount(0);
    expect(api.contactChanges.at(-1)?.key).toBe(
      `POST /staff/listings/${CAR_LISTING_ID}/contact-change/approve`,
    );
    expect(api.unexpected).toEqual([]);
  });

  test("отклонить — только с причиной (частые — чипами); причину увидит партнёр", async ({ page }) => {
    const api = await start(page, { role: "admin" });
    await page.goto(`/listings/${CAR_LISTING_ID}`);
    const region = block(page);
    await region.getByRole("button", { name: t.show }).click();
    await region.getByRole("button", { name: t.contactChange.decline }).click();
    const sheet = page.getByRole("dialog", { name: t.contactChange.decline });
    await expect(sheet).toContainText(t.contactChange.declineHint);
    // Без причины отклонить нельзя
    const submit = sheet.getByRole("button", { name: t.contactChange.decline });
    await expect(submit).toBeDisabled();
    await expectNoAxeViolations(page, "контакты: отклонить");
    await expectHitAreas(page, "контакты: отклонить", CONTROLS);
    await sheet.getByRole("button", { name: t.reasons.contactChangeDecline[0] ?? "" }).click();
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByRole("status").filter({ hasText: t.contactChange.declined })).toBeVisible();
    await expect(region).toHaveCount(0);
    expect(api.contactChanges.at(-1)).toEqual({
      key: `POST /staff/listings/${CAR_LISTING_ID}/contact-change/decline`,
      body: { reason: t.reasons.contactChangeDecline[0] },
    });
    expect(api.unexpected).toEqual([]);
  });

  test("менеджер: видит, что партнёр просит, и кто решает; «Показать» и решения нет", async ({ page }) => {
    const api = await start(page, { role: "manager" });
    await page.goto(`/listings/${CAR_LISTING_ID}`);
    const region = block(page);
    await expect(region).toContainText(t.contactChange.who);
    await expect(region.getByRole("button")).toHaveCount(0);
    await expectNoAxeViolations(page, "контакты: менеджер");
    expect(api.contactChanges).toEqual([]);
  });

  test("ссылка из оповещения (?focus=contacts): фокус на заголовке блока", async ({ page }) => {
    await start(page, { role: "moderator" });
    await page.goto(`/listings/${CAR_LISTING_ID}?focus=contacts`);
    await expect(page.locator("#contact-change-title")).toBeFocused();
  });

  test("предложения нет — блока нет", async ({ page }) => {
    const api = await start(page, { role: "moderator", contactChange: false });
    await page.goto(`/listings/${CAR_LISTING_ID}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(block(page)).toHaveCount(0);
    expect(api.unexpected).toEqual([]);
  });
});
