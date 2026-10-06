import type { Page } from "@playwright/test";
import { t } from "../../apps/admin/src/texts";
import { expectHitAreas, expectNoAxeViolations } from "../support/a11y";
import { expect, test } from "../support/offline";
import {
  LISTING_ID,
  mockStaffApi,
  NOW,
  PHOTO_DECLINE_REASON,
  PHOTO_DECLINED_ID,
  PHOTO_LISTING_ID,
  PHOTO_PENDING_ID,
  REQUEST_ID,
} from "../support/staff-api";
import { horizontalOverflow } from "../support/web";

/* Журналы, уведомления, заявки, фото и контакты витрин словами: объект и актор журнала — по
   названию и имени, а не началом id; получатель уведомления — по имени; чья заявка — в списке;
   отказ по фото — с причиной, её видно под фото; изменение открытий контактов — знаком и
   словами. Телефон и компьютер: на телефоне — карточки и шторки, на компьютере — таблицы. */

const CONTROLS = [
  ".btn",
  ".chip",
  "input:not([type=hidden])",
  "textarea",
  ".ui-select",
  ".ui-check",
  ".ui-icon-btn",
].join(", ");

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 720;
const heading = (page: Page) => page.getByRole("heading", { level: 1 });

async function start(page: Page) {
  await page.clock.setFixedTime(NOW);
  return mockStaffApi(page, { seeded: true });
}

/** Строка списка: карточка на телефоне, строка таблицы на компьютере */
const rows = (page: Page) => page.locator(".rcards .rcard, tbody tr");

async function expectFits(page: Page, name: string) {
  const width = page.viewportSize()?.width ?? 0;
  expect((await horizontalOverflow(page)).scrollWidth, `${name}: прокрутка вбок`).toBeLessThanOrEqual(width);
  await expectNoAxeViolations(page, name);
  await expectHitAreas(page, name, CONTROLS);
}

test.describe("журнал словами", () => {
  test("действия: объект — названием и ссылкой, актор — именем и видом; нет подписи — короткий id", async ({
    page,
  }) => {
    const api = await start(page);
    await page.goto("/audit");
    await expect(heading(page)).toHaveText(t.audit);
    await expect(rows(page)).toHaveCount(4);

    // Заявка — «№1051» ссылкой на заявку; сотрудник — по имени
    const remind = rows(page).nth(0);
    await expect(remind.getByRole("link", { name: "№1051" })).toHaveAttribute(
      "href",
      `/requests/${REQUEST_ID}`,
    );
    await expect(remind).toContainText(t.auditActions["request.remind"] ?? "");
    // Партнёр — именем и видом; витрина — названием
    const partner = rows(page).nth(1);
    await expect(partner).toContainText(`Бахтиёр Рашидов · ${t.historyBy.vendor_user}`);
    await expect(partner.getByRole("link", { name: "Lola zali" })).toHaveAttribute(
      "href",
      `/listings/${LISTING_ID}`,
    );
    // Клиент — кодом и видом
    await expect(rows(page).nth(2)).toContainText(`C-00000000 · ${t.historyBy.client}`);
    // Витрины уже нет (подписи нет): короткий id, без полного UUID
    const gone = rows(page).nth(3);
    await expect(gone.getByRole("link", { name: "00000000…" })).toBeVisible();
    await expect(page.locator("main")).not.toHaveText(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    await expectFits(page, "журнал: действия");
    expect(api.unexpected).toEqual([]);
  });

  test("просмотры телефонов: чей телефон — словами, без подписи — короткий id", async ({ page }) => {
    const api = await start(page);
    await page.goto("/audit?tab=pii");
    await expect(rows(page)).toHaveCount(2);
    const first = rows(page).nth(0);
    await expect(first.getByRole("link", { name: "№1051" })).toHaveAttribute(
      "href",
      `/requests/${REQUEST_ID}`,
    );
    await expect(first).toContainText("Клиент просит перезвонить");
    const second = rows(page).nth(1);
    await expect(second).toContainText(`Бахтиёр Рашидов · ${t.historyBy.vendor_user}`);
    await expect(second.getByRole("link", { name: "00000000…" })).toBeVisible();
    await expectFits(page, "журнал: просмотры телефонов");
    expect(api.unexpected).toEqual([]);
  });
});

test("уведомления: получатель — по имени, под ним вид и начало id", async ({ page }) => {
  const api = await start(page);
  await page.goto("/notifications");
  await expect(heading(page)).toHaveText(t.notifications);
  const dead = rows(page).first();
  await expect(dead).toContainText("Бахтиёр Рашидов");
  await expect(dead).toContainText(t.recipientKinds.vendor_user ?? "");
  await expect(dead).toContainText("00000000…");
  await expectFits(page, "уведомления");
  expect(api.unexpected).toEqual([]);
});

test("заявки: в списке видно, чья заявка", async ({ page }) => {
  const api = await start(page);
  await page.goto("/requests");
  await expect(heading(page)).toHaveText(t.requests);
  await expect(rows(page)).toHaveCount(2);
  for (const n of [0, 1]) await expect(rows(page).nth(n)).toContainText("Азиза");
  if (isPhone(page)) await expect(rows(page).first().locator("dt").first()).toHaveText(t.colClient);
  else await expect(page.getByRole("columnheader", { name: t.colClient })).toBeVisible();
  await expectFits(page, "заявки");
  expect(api.unexpected).toEqual([]);
});

test.describe("фото: отказ с причиной", () => {
  const photos = (page: Page) => page.locator("section[aria-labelledby=photos-title]");

  /** Начать отказ по n-му фото: на телефоне — «Ещё» → «Отклонить» → шторка; на компьютере — кнопка и форма под рядом */
  async function startDecline(page: Page, n: number) {
    const photo = photos(page)
      .locator(".photo")
      .nth(n - 1);
    if (isPhone(page)) {
      // Имя кнопки — «Ещё», пробел и скрытое для глаз «: Фото n»
      await photo.getByRole("button", { name: new RegExp(`${t.more}\\s*: ${t.photoN(n)}$`) }).click();
      await page
        .getByRole("dialog", { name: t.photoN(n) })
        .getByRole("button", { name: t.decline, exact: true })
        .click();
      return page.getByRole("dialog", { name: t.declinePhotoTitle(n) });
    }
    await photo.getByRole("button", { name: t.decline, exact: true }).click();
    return photos(page).locator(".decline-photo");
  }

  test("причина обязательна; уходит с отказом и видна под фото; длинная не ломает ширину", async ({
    page,
  }) => {
    const api = await start(page);
    await page.goto(`/listings/${PHOTO_LISTING_ID}`);
    await expect(photos(page).locator(".photo")).toHaveCount(3);
    // Прежний отказ — причина под фото, целиком
    await expect(photos(page).locator(".photo-reason")).toHaveText(
      t.photoDeclineReason(PHOTO_DECLINE_REASON),
    );
    await expectFits(page, "фото: отклонённое с причиной");

    const form = await startDecline(page, 1);
    await expect(form).toContainText(t.declinePhotoHint(1));
    const reason = form.getByLabel(t.reason, { exact: true });
    const submit = form.getByRole("button", { name: t.declinePhoto, exact: true });
    await expect(submit).toBeDisabled();
    await reason.fill("   ");
    await expect(submit).toBeDisabled();
    expect(api.photoDecisions).toEqual([]);
    await expectFits(page, "фото: причина отказа");

    await reason.fill("Нужен кадр без людей");
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(form).toHaveCount(0);
    expect(api.photoDecisions).toEqual([
      {
        listingId: PHOTO_LISTING_ID,
        photoId: PHOTO_PENDING_ID,
        body: { decision: "declined", reason: "Нужен кадр без людей" },
      },
    ]);
    // Фото отклонено, причина — под ним; у отклонённого раньше она осталась
    await expect(photos(page).locator(".photo").nth(0)).toContainText(t.moderationStates.declined);
    await expect(photos(page).locator(".photo-reason")).toHaveText([
      t.photoDeclineReason("Нужен кадр без людей"),
      t.photoDeclineReason(PHOTO_DECLINE_REASON),
    ]);
    expect(api.photoDecisions.some((d) => d.photoId === PHOTO_DECLINED_ID)).toBe(false);
    await expectFits(page, "фото: после отказа");
    expect(api.unexpected).toEqual([]);
  });

  test("«Отмена» закрывает форму без запроса; отказ можно начать заново", async ({ page }) => {
    const api = await start(page);
    await page.goto(`/listings/${PHOTO_LISTING_ID}`);
    const first = await startDecline(page, 2);
    await first.getByLabel(t.reason, { exact: true }).fill("Передумали");
    await first.getByRole("button", { name: t.cancel }).click();
    await expect(first).toHaveCount(0);
    expect(api.photoDecisions).toEqual([]);
    const again = await startDecline(page, 2);
    // Поле снова пустое: прежний текст не остался
    await expect(again.getByLabel(t.reason, { exact: true })).toHaveValue("");
  });
});

test("метрики, контакты витрин: изменение открытий — знаком и словами, не цветом", async ({ page }) => {
  const api = await start(page);
  await page.goto("/metrics");
  const section = page.getByRole("region", { name: t.metricsContacts });
  const list = section.locator(".rcard, tbody tr");
  await expect(list).toHaveCount(3);
  // 48 против 40, 17 против 17, 5 против 9
  await expect(list.nth(0)).toContainText("+8 · было 40");
  await expect(list.nth(1)).toContainText(t.opensChange(17, 17));
  await expect(list.nth(2)).toContainText("−4 · было 9");
  // Диктору — то же предложением; видимая подпись от него скрыта
  await expect(section.locator(".visually-hidden").filter({ hasText: "На 8 больше" })).toHaveCount(1);
  await expect(section.locator(".visually-hidden").filter({ hasText: "На 4 меньше" })).toHaveCount(1);
  await expect(section.locator(".visually-hidden").filter({ hasText: "Столько же" })).toHaveCount(1);
  await expect(section.locator("[aria-hidden='true']").filter({ hasText: "+8 · было 40" })).toHaveCount(1);
  await expectFits(page, "метрики: изменение открытий");
  expect(api.unexpected).toEqual([]);
});
