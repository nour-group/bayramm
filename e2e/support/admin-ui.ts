import { expect, type Locator, type Page } from "@playwright/test";
import { t } from "../../apps/admin/src/texts";
import { labelled } from "./field-name";
import { LISTING_ID, VENDOR_ID } from "./staff-api";

/** Имя поля целиком: подпись и пометка «обязательно / по желанию» у неё (как у клиента) */
/** Поле по подписи (с пометкой «обязательно / по желанию» у неё или без) */
export const field = (scope: Page | Locator, label: string): Locator =>
  labelled(scope, label, [t.required, t.optional]);

/* Действия в панели, которые нужны многим проверкам: выбрать вариант своего списка (Select
   из @bayramm/ui/react), пункт шторки «…», пункт шторки фото и завести вендору витрину в категории. */

/**
 * Свой список: кнопка поля (имя — подпись поля и выбранное) и вариант в списке. scope —
 * где искать поле: форма или вся страница
 */
export async function pick(page: Page, label: string, option: string, scope = page.locator("body")) {
  // Имя кнопки поля — подпись и выбранное: ищем по подписи как по части имени
  await scope.getByRole("button", { name: label }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

/**
 * «…» объекта: открыть шторку и выбрать пункт. context — чьё «…» (подпись после «Ещё:»), scope —
 * где искать кнопку («…» фото, услуги, строки контактов, шапки витрины)
 */
export async function menuAction(page: Page, context: string, action: string, scope = page.locator("body")) {
  await moreButton(scope, context).click();
  await page.locator(".ui-dialog").getByRole("button", { name: action, exact: true }).click();
}

/** Кнопка «…» объекта: «Ещё» и скрытая подпись «: объект» (имя кнопки склеивается с пробелом — ищем по тексту) */
export function moreButton(scope: Locator, context: string): Locator {
  return scope.locator("button.btn-more").filter({ hasText: context });
}

/** Фото витрины: нажать плитку N (с 1) и выбрать пункт её шторки */
export async function photoAction(page: Page, n: number, action: string) {
  await page
    .locator(".photo-tile")
    .nth(n - 1)
    .click();
  await page.locator(".ui-dialog").getByRole("button", { name: action, exact: true }).click();
}

/** Новая витрина вендору: категория и название → страница витрины (LISTING_ID) */
export async function createVitrina(page: Page, { category = "Тойхона", name = "Navruz zali" } = {}) {
  await page.goto(`/vendors/${VENDOR_ID}/listings/new`);
  await pick(page, t.categoryFirst, category);
  await field(page, t.vitrinaName).fill(name);
  await page.getByRole("button", { name: t.createVitrina }).click();
  await expect(page).toHaveURL(`/listings/${LISTING_ID}`);
}
