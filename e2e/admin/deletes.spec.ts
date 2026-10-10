import type { Page } from "@playwright/test";
import { t } from "../../apps/admin/src/texts";
import { expectHitAreas, expectNoAxeViolations } from "../support/a11y";
import { expect, test } from "../support/offline";
import { CAKE_LISTING_ID, CAR_LISTING_ID, mockStaffApi, NOW, VENDOR_ID } from "../support/staff-api";
import { horizontalOverflow } from "../support/web";

/* Удаление в панели: витрина без заявок — после подтверждения (что удалится — словами), затем
   страница вендора; витрина с заявкой — нельзя, и сказано, что сделать вместо; вендор — только
   вписав его код; непринятое приглашение в команду отзывается. Телефон и компьютер. */

const CONTROLS = [".btn", "input:not([type=hidden])", ".ui-btn", ".menu-item"].join(", ");

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 720;
const heading = (page: Page) => page.getByRole("heading", { level: 1 });

async function start(page: Page, options: Parameters<typeof mockStaffApi>[1] = { seeded: true }) {
  await page.clock.setFixedTime(NOW);
  return mockStaffApi(page, options);
}

/** Блок «Удалить витрину» внизу страницы витрины */
const deleteBlock = (page: Page) => page.getByRole("region", { name: t.listingDelete });

/** «Удалить вендора»: на телефоне — пункт «Ещё» в шапке вендора, шире — кнопка */
async function vendorDeleteAction(page: Page) {
  const head = page.locator(".vendor-head");
  if (!isPhone(page)) return head.getByRole("button", { name: t.vendorDelete });
  await head.getByRole("button", { name: new RegExp(t.more) }).click();
  return page.getByRole("dialog", { name: t.actionsTitle }).getByRole("button", { name: t.vendorDelete });
}

test.describe("витрина", () => {
  test("без заявок: что удалится — в подтверждении; потом — страница вендора без неё", async ({ page }) => {
    const api = await start(page);
    await page.goto(`/listings/${CAKE_LISTING_ID}`);
    await expect(heading(page)).toHaveText("Shirin");
    const block = deleteBlock(page);
    await expect(block).toContainText(t.listingDeleteHint);
    await expectHitAreas(page, "витрина: блок удаления", CONTROLS);

    await block.getByRole("button", { name: t.listingDelete }).click();
    const sheet = page.getByRole("alertdialog", { name: t.listingDeleteTitle });
    await expect(sheet).toContainText(t.listingDeleteText("Shirin"));
    // Фокус — на отмене: Enter по привычке ничего не удалит
    await expect(sheet.getByRole("button", { name: t.cancel })).toBeFocused();
    await expectNoAxeViolations(page, "витрина: подтверждение удаления");
    expect(api.deletes).toEqual([]);

    await sheet.getByRole("button", { name: t.listingDelete }).click();
    await expect(page).toHaveURL(`/vendors/${VENDOR_ID}`);
    await expect(page.getByRole("link", { name: "Kadr studio" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Shirin" })).toHaveCount(0);
    expect(api.deletes).toEqual([`DELETE /staff/listings/${CAKE_LISTING_ID}`]);
    expect(api.unexpected).toEqual([]);
  });

  test("с заявкой: удалить нельзя — кнопка недоступна, рядом — приостановить вместо", async ({ page }) => {
    const api = await start(page);
    await page.goto(`/listings/${CAR_LISTING_ID}`);
    await expect(heading(page)).toHaveText("Oq kortej");
    const block = deleteBlock(page);
    await expect(block).toContainText(t.listingDeleteBlocked.requests ?? "");
    await expect(block.getByRole("button", { name: t.listingDelete })).toBeDisabled();
    await expectNoAxeViolations(page, "витрина с заявкой: блок удаления");
    expect(api.deletes).toEqual([]);
    expect(api.unexpected).toEqual([]);
  });

  test("модератор витрин не удаляет — блока нет", async ({ page }) => {
    const api = await start(page, { seeded: true, role: "moderator" });
    await page.goto(`/listings/${CAKE_LISTING_ID}`);
    await expect(heading(page)).toHaveText("Shirin");
    await expect(deleteBlock(page)).toHaveCount(0);
    expect(api.unexpected).toEqual([]);
  });
});

test.describe("вендор", () => {
  test("удалить — только вписав код вендора; потом — список вендоров", async ({ page }) => {
    const api = await start(page, {});
    await page.goto(`/vendors/${VENDOR_ID}`);
    await expect(heading(page)).toHaveText("Lola");
    const width = page.viewportSize()?.width ?? 0;
    expect((await horizontalOverflow(page)).scrollWidth).toBeLessThanOrEqual(width);
    await expectHitAreas(page, "вендор: шапка", CONTROLS);

    await (await vendorDeleteAction(page)).click();
    const sheet = page.getByRole("alertdialog", { name: t.vendorDeleteTitle });
    await expect(sheet).toContainText(t.vendorDeleteText("V101"));
    const confirm = sheet.getByRole("button", { name: t.vendorDelete });
    await expect(confirm).toBeDisabled();
    const code = sheet.getByLabel(t.vendorDeleteCode("V101"));
    await code.fill("V10");
    await expect(confirm).toBeDisabled();
    await code.fill("v101");
    await expect(confirm).toBeEnabled();
    await expectNoAxeViolations(page, "вендор: подтверждение удаления");

    await confirm.click();
    await expect(page).toHaveURL("/vendors");
    await expect(page.getByRole("link", { name: "Lola" })).toHaveCount(0);
    expect(api.deletes).toEqual([`DELETE /staff/vendors/${VENDOR_ID}`]);
    expect(api.unexpected).toEqual([]);
  });

  test("по витрине были заявки: удалить нельзя — недоступно и сказано почему", async ({ page }) => {
    const api = await start(page);
    await page.goto(`/vendors/${VENDOR_ID}`);
    await expect(heading(page)).toHaveText("Lola");
    await expect(page.locator(".vendor-head")).toContainText(t.vendorDeleteBlocked.requests ?? "");
    await expect(await vendorDeleteAction(page)).toBeDisabled();
    expect(api.deletes).toEqual([]);
    expect(api.unexpected).toEqual([]);
  });
});

test.describe("команда", () => {
  test("непринятое приглашение отзывается через подтверждение; у себя и у принятых — нет", async ({
    page,
  }) => {
    const api = await start(page, {});
    await page.goto("/team");
    const rows = page.locator(".rcards .rcard, tbody tr");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0).getByRole("button", { name: t.inviteRevoke })).toHaveCount(0);
    const pending = rows.filter({ hasText: "Бахтиёр Менеджеров" });
    await pending.getByRole("button", { name: t.inviteRevoke }).click();

    const sheet = page.getByRole("alertdialog", { name: t.inviteRevokeTitle });
    await expect(sheet).toContainText(t.inviteRevokeText("Бахтиёр Менеджеров"));
    await expectNoAxeViolations(page, "команда: отозвать приглашение");
    await sheet.getByRole("button", { name: t.inviteRevoke }).click();
    await expect(sheet).toHaveCount(0);
    await expect(rows).toHaveCount(1);
    await expect(page.getByText("Бахтиёр Менеджеров")).toHaveCount(0);
    expect(api.deletes).toEqual(["DELETE /staff/team/00000000-0000-4000-8600-000000000002"]);
    expect(api.unexpected).toEqual([]);
  });
});
