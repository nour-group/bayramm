import type { Page } from "@playwright/test";
import { t } from "../../apps/admin/src/texts";
import { expectNoAxeViolations } from "../support/a11y";
import { pick } from "../support/admin-ui";
import { expect, test } from "../support/offline";
import { LISTING_ID, mockStaffApi, NOW, REQUEST_ID, REVISION_ID, VENDOR_ID } from "../support/staff-api";

/* Несохранённые правки (apps/admin/src/unsaved.tsx): форма с вписанным, но не сохранённым
   уходит только после «Уйти» — по разделу навигации, «назад» браузера и Telegram, выходу;
   перезагрузка — окно браузера (beforeunload). Ничего не меняли или только что сохранили —
   уход без вопроса. Идёт на телефоне и на компьютере. */

async function start(page: Page) {
  await page.clock.setFixedTime(NOW);
  return mockStaffApi(page);
}

/** Раздел в навигации: нижняя панель телефона или шапка компьютера */
const section = (page: Page, name: string) =>
  page.getByRole("navigation", { name: t.sections }).getByRole("link", { name });

const question = (page: Page) => page.getByRole("alertdialog", { name: t.unsavedTitle });

/** Название: на странице новой витрины — её поле, на странице витрины — поле формы */
const nameField = (page: Page) => page.getByLabel(t.vitrinaName, { exact: true });
const listingName = (page: Page) => page.getByLabel(t.listingFields.name ?? "", { exact: true });

test("ничего не вписали — переход по разделу без вопроса", async ({ page }) => {
  await start(page);
  await page.goto(`/vendors/${VENDOR_ID}/listings/new`);
  await expect(nameField(page)).toBeVisible();
  await section(page, t.requests).click();
  await expect(page).toHaveURL("/requests");
  await expect(question(page)).toHaveCount(0);
});

test("новая витрина: вписали — раздел спрашивает; «Остаться» — вписанное на месте, «Уйти» — раздел", async ({
  page,
}) => {
  const api = await start(page);
  await page.goto(`/vendors/${VENDOR_ID}/listings/new`);
  await nameField(page).fill("Navruz zali");
  await nameField(page).blur();
  await section(page, t.requests).click();
  await expect(question(page)).toBeVisible();
  await expect(question(page)).toContainText(t.unsavedText);
  await expect(page).toHaveURL(`/vendors/${VENDOR_ID}/listings/new`);
  await expectNoAxeViolations(page, "вопрос перед уходом");
  // Отказ не меньше согласия и в фокусе первым: Enter по привычке ничего не бросит
  await expect(question(page).getByRole("button", { name: t.unsavedStay })).toBeFocused();

  await question(page).getByRole("button", { name: t.unsavedStay }).click();
  await expect(question(page)).toHaveCount(0);
  await expect(nameField(page)).toHaveValue("Navruz zali");

  await section(page, t.requests).click();
  await question(page).getByRole("button", { name: t.unsavedLeave }).click();
  await expect(page).toHaveURL("/requests");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(t.requests);
  expect(api.vitrinas).toEqual([]);
  expect(api.unexpected).toEqual([]);
});

test("«назад» браузера с правками — экран и вписанное остаются; «Уйти» — назад", async ({ page }) => {
  await start(page);
  await page.goto(`/vendors/${VENDOR_ID}`);
  await page.getByRole("link", { name: t.addVitrina }).click();
  await expect(page).toHaveURL(`/vendors/${VENDOR_ID}/listings/new`);
  await nameField(page).fill("Navruz zali");

  await page.evaluate(() => window.history.back());
  await expect(question(page)).toBeVisible();
  await expect(page).toHaveURL(`/vendors/${VENDOR_ID}/listings/new`);
  await expect(nameField(page)).toHaveValue("Navruz zali");

  await question(page).getByRole("button", { name: t.unsavedLeave }).click();
  await expect(page).toHaveURL(`/vendors/${VENDOR_ID}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Lola");
});

test("перезагрузка с правками — окно браузера; без правок — без окна", async ({ page }) => {
  await start(page);
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.type());
    void dialog.dismiss();
  });
  await page.goto(`/vendors/${VENDOR_ID}/listings/new`);
  await expect(nameField(page)).toBeVisible();
  // Нажатия клавиш — действие человека: без него браузер beforeunload не показывает
  await nameField(page).pressSequentially("Nav");
  await nameField(page).fill("");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(nameField(page)).toHaveValue("");
  expect(dialogs).toEqual([]);

  await nameField(page).pressSequentially("Navruz");
  const asked = page.waitForEvent("dialog");
  void page.reload().catch(() => {});
  expect((await asked).type()).toBe("beforeunload");
  // Отказались уходить — вписанное на месте
  await expect(nameField(page)).toHaveValue("Navruz");
});

test("сохранили — уход без вопроса", async ({ page }) => {
  await start(page);
  await page.goto(`/vendors/${VENDOR_ID}/listings/new`);
  await pick(page, t.categoryFirst, "Тойхона");
  await nameField(page).fill("Navruz zali");
  // «Создать витрину» — форма сохранена: переход на неё без вопроса
  await page.getByRole("button", { name: t.createVitrina }).click();
  await expect(page).toHaveURL(`/listings/${LISTING_ID}`);
  await expect(question(page)).toHaveCount(0);

  await listingName(page).fill("Navruz Grand");
  await listingName(page).blur();
  await page.getByRole("button", { name: t.save }).click();
  await expect(page.getByText(t.saved, { exact: true })).toBeVisible();
  await section(page, t.requests).click();
  await expect(page).toHaveURL("/requests");
  await expect(question(page)).toHaveCount(0);
});

test("заметка к заявке, причина отказа по правке, приглашение в команду — тоже несохранённое", async ({
  page,
}) => {
  await start(page);
  await page.goto(`/requests/${REQUEST_ID}`);
  await page.getByLabel(t.noteText).fill("Перезвонить завтра");
  // Клавиатура на телефоне прячет нижнюю панель: сначала убрать её, как пальцем мимо поля
  await page.getByLabel(t.noteText).blur();
  await section(page, t.vendors).click();
  await expect(question(page)).toBeVisible();
  await question(page).getByRole("button", { name: t.unsavedStay }).click();
  await expect(page).toHaveURL(`/requests/${REQUEST_ID}`);

  await page.goto(`/revisions/${REVISION_ID}`);
  await page.getByRole("button", { name: t.revisionDecline }).click();
  await page.getByLabel(t.reason).fill("Цена не по договору");
  await page.getByLabel(t.reason).blur();
  // На телефоне причина — в шторке: закрыли её — черновик пропал, уход без вопроса
  if (await page.getByRole("dialog", { name: t.revisionDecline }).isVisible()) {
    await page
      .getByRole("dialog", { name: t.revisionDecline })
      .getByRole("button", { name: t.cancel })
      .click();
    await section(page, t.vendors).click();
    await expect(page).toHaveURL("/vendors");
    await expect(question(page)).toHaveCount(0);
  } else {
    await section(page, t.vendors).click();
    await expect(question(page)).toBeVisible();
    await question(page).getByRole("button", { name: t.unsavedLeave }).click();
    await expect(page).toHaveURL("/vendors");
  }

  await page.goto("/team");
  await page.getByLabel(t.inviteName).fill("Новый модератор");
  await page.getByLabel(t.inviteName).blur();
  await page
    .getByRole("link", { name: /Bayramm/ })
    .first()
    .click();
  await expect(question(page)).toBeVisible();
});
