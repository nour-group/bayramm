import type { Page } from "@playwright/test";
import { t } from "../../apps/admin/src/texts";
import { expectNoAxeViolations } from "../support/a11y";
import { expect, test } from "../support/offline";
import { mockStaffApi, NOW, PHOTO_LISTING_ID } from "../support/staff-api";

/* Фото на странице витрины — тем же просмотром, что в очереди «Новые фото»: снимок во весь экран,
   что отметил загрузивший и правило фото категории. «Одобрить все» одобряет сразу, только если
   каждое ждущее фото открывали; иначе — подтверждение с числом неоткрытых. Телефон и компьютер. */

const photos = (page: Page) => page.locator("section[aria-labelledby=photos-title]");
const tile = (page: Page, n: number) =>
  photos(page)
    .locator(".photo-tile")
    .nth(n - 1);
// У витрины «Kadr studio» три фото: два ждут решения, третье отклонено
const viewer = (page: Page, n: number) =>
  page.getByRole("dialog", { name: t.photoViewerTitle(n, 3, "Kadr studio") });

async function start(page: Page) {
  await page.clock.setFixedTime(NOW);
  return mockStaffApi(page, { seeded: true });
}

test("плитка — просмотр во весь экран: отметка загрузившего и правило категории; листать стрелками", async ({
  page,
}) => {
  const api = await start(page);
  await page.goto(`/listings/${PHOTO_LISTING_ID}`);
  await expect(photos(page).locator(".photo-rule")).toHaveText(t.photoRule.portfolio);
  await tile(page, 1).click();
  await expect(viewer(page, 1)).toContainText(t.photoAckClaim.no_faces);
  await expect(viewer(page, 1)).toContainText(t.photoRule.portfolio);
  await expect(viewer(page, 1).getByRole("button", { name: t.photoApprove, exact: true })).toBeVisible();
  await expectNoAxeViolations(page, "витрина: просмотр фото");
  await page.keyboard.press("ArrowRight");
  await expect(viewer(page, 2)).toBeVisible();
  await viewer(page, 2).getByRole("button", { name: t.close }).click();
  await expect(viewer(page, 2)).toHaveCount(0);
  // Фокус — на плитке, с которой открыли
  await expect(tile(page, 1)).toBeFocused();
  expect(api.photoDecisions).toEqual([]);
  expect(api.unexpected).toEqual([]);
});

test("«Одобрить все»: неоткрытые — через подтверждение с числом; все открыты — сразу", async ({ page }) => {
  const api = await start(page);
  await page.goto(`/listings/${PHOTO_LISTING_ID}`);
  await tile(page, 1).click();
  await viewer(page, 1).getByRole("button", { name: t.close }).click();

  await photos(page)
    .getByRole("button", { name: t.photosApproveAll(2) })
    .click();
  const question = page.getByRole("alertdialog", { name: t.photoApproveAllQ(2) });
  await expect(question).toContainText(t.photoApproveAllText(2, 1));
  await expect(question.getByRole("button", { name: t.cancel })).toBeFocused();
  await question.getByRole("button", { name: t.cancel }).click();
  expect(api.photoDecisions).toEqual([]);

  // Второе открыли — вопросов больше нет
  await tile(page, 2).click();
  await viewer(page, 2).getByRole("button", { name: t.close }).click();
  await photos(page)
    .getByRole("button", { name: t.photosApproveAll(2) })
    .click();
  await expect(question).toHaveCount(0);
  await expect.poll(() => api.photoDecisions.length).toBe(2);
  expect(api.photoDecisions.map((d) => d.body)).toEqual([{ decision: "approved" }, { decision: "approved" }]);
  expect(api.unexpected).toEqual([]);
});

test("«Отклонить» с клавиатуры — фокус в поле причины; Esc закрывает просмотр", async ({ page }) => {
  const api = await start(page);
  await page.goto(`/listings/${PHOTO_LISTING_ID}`);
  await tile(page, 1).click();
  await viewer(page, 1).getByRole("button", { name: t.photoDecline, exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(viewer(page, 1).locator("form textarea")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(viewer(page, 1)).toHaveCount(0);
  expect(api.photoDecisions).toEqual([]);
});
