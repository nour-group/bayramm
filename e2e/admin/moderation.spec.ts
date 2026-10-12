import type { Page } from "@playwright/test";
import { t } from "../../apps/admin/src/texts";
import { expectHitAreas, expectNoAxeViolations } from "../support/a11y";
import { expect, test } from "../support/offline";
import {
  mockStaffApi,
  NOW,
  PHOTO_QUEUE_LISTING_ID,
  photoQueueId,
  type StaffApiOptions,
} from "../support/staff-api";
import { horizontalOverflow } from "../support/web";

/* Модерация: очередь «Новые фото» — плитки ждущих фото с ✓ и ✕ (отказ — с причиной в шторке) и
   «Одобрить все»; решения идут в тот же POST …/photos/:id/moderation; после решения очередь
   перечитывается, фокус — на следующую плитку, а когда очередь опустела — на сегменты; пустые
   очереди в сегментах не показываются, все пусты — «Всё разобрано». Телефон и компьютер. */

const CONTROLS = [".btn", "input:not([type=hidden])", ".ui-radio", "textarea"].join(", ");

async function start(page: Page, options: StaffApiOptions = {}) {
  await page.clock.setFixedTime(NOW);
  return mockStaffApi(page, options);
}

const tabs = (page: Page) => page.getByRole("radiogroup", { name: t.moderation });
const photos = (page: Page) => page.getByRole("region", { name: t.photoQueue });

test("плитки: два фото, у каждого ✓ и ✕; запроса за фото карточки по одному нет", async ({ page }) => {
  const api = await start(page);
  await page.goto("/moderation?queue=photos");
  const queue = photos(page);
  await expect(queue.locator(".photo-tile")).toHaveCount(2);
  await expect(
    queue.getByRole("button", { name: new RegExp(`^${t.photoApproveOne(1, "Bogʻ zali")}$`) }),
  ).toBeVisible();
  await expect(
    queue.getByRole("button", { name: new RegExp(`^${t.photoDeclineOne(2, "Bogʻ zali")}$`) }),
  ).toBeVisible();
  await expect(queue.getByRole("button", { name: t.photoApproveAll(2) })).toBeVisible();

  const width = page.viewportSize()?.width ?? 0;
  expect((await horizontalOverflow(page)).scrollWidth).toBeLessThanOrEqual(width);
  await expectNoAxeViolations(page, "модерация: новые фото");
  await expectHitAreas(page, "модерация: новые фото", CONTROLS);
  expect(api.unexpected).toEqual([]);
});

test("✓ —одобрить одно: решение уходит, плитка пропадает, фокус — на ✓ следующей", async ({ page }) => {
  const api = await start(page);
  await page.goto("/moderation?queue=photos");
  const queue = photos(page);
  await queue.getByRole("button", { name: t.photoApproveOne(1, "Bogʻ zali") }).click();
  await expect(queue.locator(".photo-tile")).toHaveCount(1);
  expect(api.photoDecisions).toEqual([
    { listingId: PHOTO_QUEUE_LISTING_ID, photoId: photoQueueId(1), body: { decision: "approved" } },
  ]);
  // Осталась одна плитка: фокус на её ✓ — разбор подряд без поиска глазами и пальцем
  await expect(queue.locator(".photo-tile .photo-approve")).toBeFocused();
  // «Одобрить все» у единственного фото не нужно
  await expect(queue.locator(".photo-approve-all")).toHaveCount(0);
  expect(api.unexpected).toEqual([]);
});

test("✕ — шторка с причиной и готовыми вариантами; без причины отказа нет", async ({ page }) => {
  const api = await start(page);
  await page.goto("/moderation?queue=photos");
  const queue = photos(page);
  await queue.getByRole("button", { name: t.photoDeclineOne(2, "Bogʻ zali") }).click();
  const sheet = page.getByRole("dialog", { name: new RegExp(t.declinePhotoTitle(2)) });
  const submit = sheet.getByRole("button", { name: t.declinePhoto, exact: true });
  await expect(submit).toBeDisabled();
  await expectNoAxeViolations(page, "модерация: отказ по фото");
  await expectHitAreas(page, "модерация: отказ по фото", CONTROLS);
  expect(api.photoDecisions).toEqual([]);

  await sheet.getByRole("button", { name: t.reasons.photoDecline[1] ?? "" }).click();
  await expect(sheet.getByLabel(t.reason)).toHaveValue(t.reasons.photoDecline[1] ?? "");
  await submit.click();
  await expect(sheet).toHaveCount(0);
  await expect(queue.locator(".photo-tile")).toHaveCount(1);
  expect(api.photoDecisions).toEqual([
    {
      listingId: PHOTO_QUEUE_LISTING_ID,
      photoId: photoQueueId(2),
      body: { decision: "declined", reason: t.reasons.photoDecline[1] },
    },
  ]);
  expect(api.unexpected).toEqual([]);
});

test("«Одобрить все» — все фото карточки; очередь опустела — открыта следующая, фокус на сегментах", async ({
  page,
}) => {
  // Три фото ждут решения
  const api = await start(page, { photoQueue: 3 });
  await page.goto("/moderation?queue=photos");
  const queue = photos(page);
  await expect(queue.locator(".photo-tile")).toHaveCount(3);
  await queue.getByRole("button", { name: t.photoApproveAll(3) }).click();
  await expect(queue).toHaveCount(0);
  expect(api.photoDecisions.map((d) => d.photoId)).toEqual([
    photoQueueId(1),
    photoQueueId(2),
    photoQueueId(3),
  ]);
  expect(api.photoDecisions.every((d) => (d.body as { decision: string }).decision === "approved")).toBe(
    true,
  );
  // Из сегментов фото ушли; другая очередь (предложения) открылась, фокус — на сегментах
  await expect(tabs(page).locator(".ui-radio").filter({ hasText: t.queueTabs.photos })).toHaveCount(0);
  await expect(page.locator(".queue-tabs input:checked")).toBeFocused();
  expect(api.unexpected).toEqual([]);
});

test("нет фото на решении — очереди в сегментах нет; решённая очередь не открывается из адреса", async ({
  page,
}) => {
  const api = await start(page, { photoQueue: 0 });
  await page.goto("/moderation?queue=photos");
  await expect(tabs(page).locator(".ui-radio")).toHaveText([`${t.queueTabs.revisions} 1`]);
  await expect(photos(page)).toHaveCount(0);
  await expect(page.getByRole("region", { name: t.revisions })).toBeVisible();
  expect(api.unexpected).toEqual([]);
});

test("менеджер видит плитки без кнопок: решает по фото модератор", async ({ page }) => {
  const api = await start(page, { role: "manager" });
  await page.goto("/moderation?queue=photos");
  await expect(photos(page).locator(".photo-tile")).toHaveCount(2);
  await expect(photos(page).locator(".photo-tile button")).toHaveCount(0);
  await expect(photos(page).locator(".photo-approve-all")).toHaveCount(0);
  expect(api.unexpected).toEqual([]);
});
