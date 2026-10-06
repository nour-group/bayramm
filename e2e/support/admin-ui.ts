import { expect, type Page } from "@playwright/test";
import { t } from "../../apps/admin/src/texts";
import { LISTING_ID, VENDOR_ID } from "./staff-api";

/* Действия в панели, которые нужны многим проверкам: выбрать вариант своего списка (Select
   из @bayramm/ui/react) и завести вендору витрину в категории. */

/**
 * Свой список: кнопка поля (имя — подпись поля и выбранное) и вариант в списке. scope —
 * где искать поле: форма или вся страница
 */
export async function pick(page: Page, label: string, option: string, scope = page.locator("body")) {
  // Имя кнопки поля — подпись и выбранное: ищем по подписи как по части имени
  await scope.getByRole("button", { name: label }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

/** Новая витрина вендору: категория и название → страница витрины (LISTING_ID) */
export async function createVitrina(
  page: Page,
  { category = "Тойхона", name = "Navruz zali" } = {},
) {
  await page.goto(`/vendors/${VENDOR_ID}/listings/new`);
  await pick(page, t.categoryFirst, category);
  await page.getByLabel(t.vitrinaName, { exact: true }).fill(name);
  await page.getByRole("button", { name: t.createVitrina }).click();
  await expect(page).toHaveURL(`/listings/${LISTING_ID}`);
}
