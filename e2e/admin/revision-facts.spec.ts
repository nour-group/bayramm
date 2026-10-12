import type { Page } from "@playwright/test";
import { t } from "../../apps/admin/src/texts";
import { expectHitAreas, expectNoAxeViolations } from "../support/a11y";
import { expect, test } from "../support/offline";
import { mockStaffApi, NOW, REVISION_ID } from "../support/staff-api";

/* Предложение изменений с вместимостью, районом и адресом (партнёр правит витрину, которая на
   проверке или на сайте): модератор видит «сейчас» и «предлагает» по каждому полю — вместимость
   одной строкой «80–300 гостей → 100–350 гостей», район названием, адрес словами — и решает.
   Идёт и на компьютере (таблица), и на телефоне (карточки). */

const CONTROLS = [".btn", ".action", ".nav a", ".tab", ".appbar-btn", ".appbar-account", ".ui-select"].join(
  ", ",
);

/** Строка поля: на компьютере — строка таблицы, на телефоне — карточка */
const row = (page: Page, label: string) =>
  page
    .getByRole("row")
    .filter({ hasText: label })
    .or(page.locator(".rcard").filter({ hasText: label }));

async function start(page: Page) {
  await page.clock.setFixedTime(NOW);
  return mockStaffApi(page, { revision: "facts" });
}

test("вместимость — одна строка «было → стало», район названием, адрес словами", async ({ page }) => {
  const api = await start(page);
  await page.goto(`/revisions/${REVISION_ID}`);

  const capacity = row(page, t.revisionFields.capacity ?? "");
  await expect(capacity).toHaveCount(1);
  await expect(capacity).toContainText(t.revisionCapacity(80, 300));
  await expect(capacity).toContainText(t.revisionCapacity(100, 350));
  // Район — названием из справочника, а не кодом
  const district = row(page, t.revisionFields.districtCode ?? "");
  await expect(district).toContainText("Юнусабад");
  await expect(district).toContainText("Чиланзар");
  await expect(district).not.toContainText("chilonzor");
  // Адреса раньше не было — «нет»; новый — как предложен
  const address = row(page, t.revisionFields.addressRu ?? "");
  await expect(address).toContainText(t.none);
  await expect(address).toContainText("ул. Навои, 5");
  // Три поля — три строки: вместимость не раздваивается на «от» и «до»
  await expect(page.getByText(t.revisionFields.capacity ?? "", { exact: true })).toHaveCount(1);

  await expectNoAxeViolations(page, "предложение с вместимостью");
  await expectHitAreas(page, "предложение с вместимостью", CONTROLS);
  expect(api.unexpected).toEqual([]);
});

test("одобрить: решение уходит, предложение из очереди пропадает", async ({ page }) => {
  const api = await start(page);
  await page.goto(`/revisions/${REVISION_ID}`);
  await page.getByRole("button", { name: t.revisionApprove, exact: true }).click();
  // Кнопка в панели действий и кнопка подтверждения под ней (или в шторке) — решает вторая
  await page.getByRole("button", { name: t.revisionApprove, exact: true }).last().click();
  await expect(page.getByText(t.revisionStatus.approved ?? "").first()).toBeVisible();
  expect(api.decisions).toEqual([{ id: REVISION_ID, decision: "approve", body: null }]);
  expect(api.unexpected).toEqual([]);
});
