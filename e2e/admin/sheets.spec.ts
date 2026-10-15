import type { Page } from "@playwright/test";
import { t } from "../../apps/admin/src/texts";
import { expectHitAreas, expectNoAxeViolations } from "../support/a11y";
import { expect, test } from "../support/offline";
import { mockStaffApi, NOW, REQUEST_ID, STAFF } from "../support/staff-api";
import { horizontalOverflow } from "../support/web";

/* Листы и шапка после чистки панели: кружок аккаунта (другие приложения и «Выйти» — в нём),
   лист «Фильтры» журнала, приглашение в команду, «+ Заметка» к заявке, «Как считаем» в метриках.
   Каждый — доступен (axe), цели не меньше 44px; шапка компьютера — одной строкой без прокрутки вбок. */

const SHEET_CONTROLS = [
  ".ui-btn",
  ".btn",
  ".ui-select",
  ".ui-radio",
  ".ui-icon-btn",
  "textarea",
  "input",
].join(", ");

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 720;

async function start(page: Page) {
  await page.clock.setFixedTime(NOW);
  return mockStaffApi(page, { seeded: true });
}

test("шапка компьютера — одна строка: название, разделы, кружок аккаунта; без прокрутки вбок и на 1024px", async ({
  page,
}) => {
  test.skip(isPhone(page), "шапка с разделами — только на компьютере");
  await start(page);
  await page.goto("/requests");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(t.requests);
  for (const width of [1280, 1100, 1024]) {
    await page.setViewportSize({ width, height: 800 });
    const header = await page.locator("header.top").evaluate((el) => el.getBoundingClientRect().height);
    expect(header, `${width}px: шапка в одну строку`).toBeLessThan(80);
    expect((await horizontalOverflow(page)).scrollWidth, `${width}px`).toBeLessThanOrEqual(width);
  }
  // Имя, роль и «Выйти» в шапке не висят: они — в листе аккаунта
  await expect(page.locator("header.top").getByRole("button", { name: t.signOut })).toHaveCount(0);
});

test("аккаунт: лист с именем, другими приложениями и «Выйти»", async ({ page }) => {
  const api = await start(page);
  await page.goto("/requests");
  await page.getByRole("button", { name: t.accountOf(STAFF.displayName, t.roles[STAFF.role]) }).click();
  const sheet = page.getByRole("dialog", { name: t.account });
  await expect(sheet.getByText(STAFF.displayName)).toBeVisible();
  await expect(sheet.getByRole("link", { name: t.toClientApp })).toBeVisible();
  await expectNoAxeViolations(page, "лист аккаунта");
  await expectHitAreas(page, "лист аккаунта", SHEET_CONTROLS);
  await sheet.getByRole("button", { name: t.signOut }).click();
  await expect(page).toHaveURL("/login");
  expect(api.loggedOut).toEqual(["staff"]);
});

test("журнал: «Фильтры» — лист на любой ширине; фильтры действуют сразу", async ({ page }) => {
  const api = await start(page);
  await page.goto("/audit");
  await page.getByRole("button", { name: t.filters, exact: true }).click();
  const sheet = page.getByRole("dialog", { name: t.filters });
  await expect(sheet.getByRole("button", { name: "Показать" })).toHaveCount(0);
  await expectNoAxeViolations(page, "журнал: лист фильтров");
  await expectHitAreas(page, "журнал: лист фильтров", SHEET_CONTROLS);
  await sheet.getByRole("button", { name: new RegExp(`^${t.auditType}`) }).click();
  await page.getByRole("option", { name: t.auditTypes.vendor ?? "", exact: true }).click();
  await expect(page).toHaveURL("/audit?type=vendor");
  expect(api.unexpected).toEqual([]);
});

test("команда: «+ Пригласить» — лист с формой; список остаётся первым", async ({ page }) => {
  await start(page);
  await page.goto("/team");
  await expect(page.locator("form.invite-form")).toHaveCount(0);
  await page.getByRole("button", { name: t.inviteOpen }).click();
  const sheet = page.getByRole("dialog", { name: t.inviteTitle });
  await expect(sheet.getByLabel(t.inviteName)).toBeVisible();
  await expectNoAxeViolations(page, "команда: лист приглашения");
  await expectHitAreas(page, "команда: лист приглашения", SHEET_CONTROLS);
  await sheet.getByRole("button", { name: t.cancel }).click();
  await expect(sheet).toHaveCount(0);
});

test("заявка: «+ Заметка» — форма открывается по кнопке; «Отмена» её закрывает", async ({ page }) => {
  const api = await start(page);
  await page.goto(`/requests/${REQUEST_ID}`);
  await expect(page.getByRole("region", { name: t.requestCourse })).toBeVisible();
  await expect(page.locator(".note-form")).toHaveCount(0);
  await page.getByRole("button", { name: t.noteAdd }).click();
  const field = page.getByLabel(t.noteText);
  await expect(field).toHaveAttribute("placeholder", t.noteHint);
  await expectNoAxeViolations(page, "заявка: новая заметка");
  await field.fill("Перезвонить завтра");
  await page.locator(".note-form").getByRole("button", { name: t.cancel }).click();
  await expect(page.locator(".note-form")).toHaveCount(0);
  expect(api.unexpected).toEqual([]);
});

test("метрики: «Как считаем» — лист с определениями", async ({ page }) => {
  await start(page);
  await page.goto("/metrics");
  await page.getByRole("button", { name: t.metricsHow }).click();
  const sheet = page.getByRole("dialog", { name: t.metricsHow });
  await expect(sheet).toContainText(t.metricsHowItems(12)[0]?.text ?? "");
  await expectNoAxeViolations(page, "метрики: как считаем");
  await sheet.getByRole("button", { name: t.close }).click();
  await expect(sheet).toHaveCount(0);
});

test("шторка набора: заголовок с «Закрыть» и кнопки действий на месте, прокручивается только тело", async ({
  page,
}) => {
  test.skip(!isPhone(page), "шторка снизу — на телефоне");
  await start(page);
  // Низкий экран: определений больше, чем помещается
  await page.setViewportSize({ width: 390, height: 480 });
  await page.goto("/metrics");
  await page.getByRole("button", { name: t.metricsHow }).click();
  const sheet = page.getByRole("dialog", { name: t.metricsHow });
  const close = sheet.locator(".ui-dialog-head").getByRole("button", { name: t.close });
  await expect(close).toBeVisible();
  const body = sheet.locator(".ui-dialog-body");
  const sizes = await body.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
  expect(sizes.scroll).toBeGreaterThan(sizes.client);
  // Текст без полей прокручивается с клавиатуры: тело — в Tab
  await expect(body).toHaveAttribute("tabindex", "0");
  const before = await close.boundingBox();
  await body.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  const after = await close.boundingBox();
  expect(after?.y).toBe(before?.y);
  await expect(close).toBeInViewport();
  await expectNoAxeViolations(page, "шторка: длинное тело");
  await close.click();
  await expect(sheet).toHaveCount(0);

  // Кнопки действий — под телом, на виду и до прокрутки: «Готово» сортировки вендоров
  await page.getByRole("radio", { name: t.metricsTabs.vendors }).check();
  await page.getByRole("button", { name: new RegExp(`^${t.sort}`) }).click();
  const sort = page.getByRole("dialog", { name: t.sort });
  const done = sort.locator(".ui-dialog-actions").getByRole("button", { name: t.done });
  await expect(done).toBeInViewport();
  const box = await sort.boundingBox();
  const action = await done.boundingBox();
  expect((action?.y ?? 0) + (action?.height ?? 0)).toBeLessThanOrEqual((box?.y ?? 0) + (box?.height ?? 0));
  await done.click();
  await expect(sort).toHaveCount(0);
});
