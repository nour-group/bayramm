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

/* Модерация: очередь «Новые фото» — плитки ждущих фото с ✓ и ✕ (отказ — с причиной в шторке),
   отметкой загрузившего и правилом категории; плитка открывает просмотр во весь экран (листать
   ← →, решать там же); «Одобрить все» — сразу, если всё открыто, иначе с подтверждением числа.
   «Одобрить» (✓ и в просмотре) уходит через 5 секунд — до того «Отменить» в строке уведомления.
   Решения идут в тот же POST …/photos/:id/moderation; после решения очередь перечитывается,
   фокус — на следующую плитку, а когда очередь опустела — на сегменты; пустые очереди в
   сегментах не показываются, все пусты — «Всё разобрано». Телефон и компьютер. */

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
  await expect(queue.locator(".queue-photo")).toHaveCount(2);
  await expect(
    queue.getByRole("button", { name: new RegExp(`^${t.photoApproveOne(1, "Bogʻ zali")}$`) }),
  ).toBeVisible();
  await expect(
    queue.getByRole("button", { name: new RegExp(`^${t.photoDeclineOne(2, "Bogʻ zali")}$`) }),
  ).toBeVisible();
  await expect(queue.getByRole("button", { name: t.photoApproveAll(2) })).toBeVisible();
  // Что отметил загрузивший — под каждой плиткой, правило фото категории — над ними
  await expect(queue.locator(".photo-claim")).toHaveText([
    t.photoAckClaim.no_faces,
    t.photoAckClaim.no_faces,
  ]);
  await expect(queue.locator(".photo-rule")).toHaveText(t.photoRule.no_people);

  const width = page.viewportSize()?.width ?? 0;
  expect((await horizontalOverflow(page)).scrollWidth).toBeLessThanOrEqual(width);
  await expectNoAxeViolations(page, "модерация: новые фото");
  await expectHitAreas(page, "модерация: новые фото", CONTROLS);
  expect(api.unexpected).toEqual([]);
});

test("✓ —одобрить одно: решение уходит через 5 секунд, плитка пропадает, фокус — на ✓ следующей", async ({
  page,
}) => {
  const api = await start(page);
  await page.goto("/moderation?queue=photos");
  const queue = photos(page);
  await queue.getByRole("button", { name: t.photoApproveOne(1, "Bogʻ zali") }).click();
  // До запроса — «Отменить» в строке уведомления, плитка тусклая
  await expect(
    page.locator(".ui-toast").filter({ hasText: t.photoApprovedUndo(1, "Bogʻ zali") }),
  ).toBeVisible();
  await expect(queue.locator(".queue-photo.is-decided")).toHaveCount(1);
  expect(api.photoDecisions).toEqual([]);
  await expect(queue.locator(".queue-photo")).toHaveCount(1, { timeout: 12_000 });
  expect(api.photoDecisions).toEqual([
    { listingId: PHOTO_QUEUE_LISTING_ID, photoId: photoQueueId(1), body: { decision: "approved" } },
  ]);
  // Осталась одна плитка: фокус на её ✓ — разбор подряд без поиска глазами и пальцем
  await expect(queue.locator(".queue-photo .photo-approve")).toBeFocused();
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
  await expect(queue.locator(".queue-photo")).toHaveCount(1);
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
  await expect(queue.locator(".queue-photo")).toHaveCount(3);
  await queue.getByRole("button", { name: t.photoApproveAll(3) }).click();
  // Ни одно фото не открыто во весь экран — сначала подтвердить число
  const confirm = page.getByRole("alertdialog", { name: t.photoApproveAllQ(3) });
  await expect(confirm).toBeVisible();
  expect(api.photoDecisions).toEqual([]);
  await confirm.getByRole("button", { name: t.photoApproveAllGo }).click();
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
  await expect(photos(page).locator(".queue-photo")).toHaveCount(2);
  // Смотреть во весь экран — можно, решать — нет
  await expect(photos(page).locator(".queue-photo .queue-photo-acts")).toHaveCount(0);
  await expect(photos(page).locator(".photo-approve-all")).toHaveCount(0);
  await photos(page)
    .getByRole("button", { name: t.photoOpen(1, "Bogʻ zali") })
    .click();
  await expect(page.locator(".photo-viewer")).toBeVisible();
  await expect(page.locator(".photo-viewer .viewer-approve")).toHaveCount(0);
  expect(api.unexpected).toEqual([]);
});

test("просмотр во весь экран: стрелки листают, решение — там же; всё открыто — «Одобрить все» без вопроса", async ({
  page,
}) => {
  const api = await start(page, { photoQueue: 3 });
  await page.goto("/moderation?queue=photos");
  const queue = photos(page);
  await queue.getByRole("button", { name: t.photoOpen(1, "Bogʻ zali") }).click();
  const viewer = page.getByRole("dialog", { name: t.photoViewerTitle(1, 3, "Bogʻ zali") });
  await expect(viewer).toBeVisible();
  // Во весь экран: снимок целиком и решение у низа
  const box = await viewer.boundingBox();
  const size = page.viewportSize();
  expect(Math.round(box?.width ?? 0)).toBe(size?.width);
  expect(Math.round(box?.height ?? 0)).toBe(size?.height);
  await expect(viewer.locator(".viewer-claim")).toContainText(t.photoAckClaim.no_faces);
  await expect(viewer.locator(".viewer-claim")).toContainText(t.photoRule.no_people);
  await expect(viewer.getByRole("button", { name: t.close })).toBeVisible();
  await expectNoAxeViolations(page, "модерация: фото во весь экран");
  await expectHitAreas(page, "модерация: фото во весь экран", ".photo-viewer button");
  await page.keyboard.press("ArrowRight");
  const second = page.getByRole("dialog", { name: t.photoViewerTitle(2, 3, "Bogʻ zali") });
  await expect(second).toBeVisible();
  // Открытым фото считается, когда снимок показан: тогда же доступно «Одобрить»
  await expect(second.getByRole("button", { name: t.photoApprove, exact: true })).toBeEnabled();
  await page.keyboard.press("ArrowRight");
  const third = page.getByRole("dialog", { name: t.photoViewerTitle(3, 3, "Bogʻ zali") });
  await expect(third).toBeVisible();
  // Одобрили в просмотре — открыто следующее нерешённое (по кругу — первое)
  await third.getByRole("button", { name: t.photoApprove, exact: true }).click();
  await expect
    .poll(() => api.photoDecisions.map((d) => d.photoId), { timeout: 12_000 })
    .toEqual([photoQueueId(3)]);
  await expect(page.locator(".photo-viewer img")).toHaveAttribute("src", new RegExp(photoQueueId(1)));
  await page.keyboard.press("Escape");
  await expect(page.locator(".photo-viewer")).toHaveCount(0);
  // Открыты оба оставшихся — «Одобрить все» сразу, без подтверждения
  await queue.getByRole("button", { name: t.photoApproveAll(2) }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect
    .poll(() => api.photoDecisions.map((d) => d.photoId))
    .toEqual([photoQueueId(3), photoQueueId(1), photoQueueId(2)]);
  expect(api.unexpected).toEqual([]);
});
