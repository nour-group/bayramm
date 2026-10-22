import type { Page } from "@playwright/test";
import { t } from "../../apps/admin/src/texts";
import { expectHitAreas, expectNoAxeViolations } from "../support/a11y";
import { field } from "../support/admin-ui";
import { expect, test } from "../support/offline";
import { mockStaffApi, NOW, REQUEST_ID, type StaffApiOptions } from "../support/staff-api";
import { CAR_LISTING_ID } from "../support/staff-catalog";

/* Разбор очередей командой: в строке заявки — что команда уже сделала; на телефоне у ждущей
   ответа заявки — сначала телефоны вендора; шапка компьютера без прокрутки вбок («Ещё ▾»);
   просмотр фото — увеличить и смахнуть, «Одобрить» с «Отменить»; недоставленное — словами и к
   телефонам; приглашение в команду — текст для сотрудника и «Отправить в Telegram»; витрину
   изменили, пока вписывали, — свежая версия под вписанное, общее поле — на выбор. */

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 720;

async function start(page: Page, options: StaffApiOptions = {}) {
  await page.clock.setFixedTime(NOW);
  return mockStaffApi(page, options);
}

test("заявки: в строке — сколько напомнили и кто из команды последним что-то делал", async ({ page }) => {
  const api = await start(page);
  await page.goto("/requests");
  const trail = page.locator(".ops-trail").first();
  await expect(trail).toContainText(t.remindedTimes(1));
  await expect(trail).toContainText("Дильноза");
  expect(api.unexpected).toEqual([]);
});

test("заявка на телефоне: ждёт ответа — телефоны вендора первыми, на первом экране", async ({ page }) => {
  test.skip(!isPhone(page), "на компьютере телефоны — в правой колонке рядом");
  const api = await start(page);
  await page.goto(`/requests/${REQUEST_ID}`);
  const first = page.locator("section.panel").first();
  await expect(first).toHaveAttribute("aria-labelledby", "vendor-phones-title");
  const show = page.getByRole("button", { name: t.showPhones });
  const box = await show.boundingBox();
  expect((box?.y ?? Number.POSITIVE_INFINITY) + (box?.height ?? 0)).toBeLessThan(
    page.viewportSize()?.height ?? 0,
  );
  expect(api.unexpected).toEqual([]);
});

test("шапка компьютера: разделы не уезжают за край — что не влезло, в «Ещё ▾»", async ({ page }) => {
  test.skip(isPhone(page), "шапка с разделами — только на компьютере");
  const api = await start(page);
  await page.goto("/requests");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(t.requests);
  const nav = page.locator("header.top nav.nav");
  for (const width of [1024, 1200]) {
    await page.setViewportSize({ width, height: 800 });
    await expect
      .poll(() => nav.evaluate((el) => el.scrollWidth - el.clientWidth), { message: `${width}px` })
      .toBeLessThanOrEqual(0);
    // Все девять разделов администратора — в строке или в «Ещё»
    const inline = await nav.locator("a").count();
    const more = nav.locator(".nav-more");
    if (inline < 9) {
      await more.click();
      const sheet = page.getByRole("dialog", { name: t.moreSections });
      await expect(sheet.getByRole("link")).toHaveCount(9 - inline);
      await expectHitAreas(page, `«Ещё» на ${width}px`, ".nav a, .nav-more");
      await sheet.getByRole("button", { name: t.close }).click();
    } else await expect(more).toHaveCount(0);
  }
  expect(api.unexpected).toEqual([]);
});

test("просмотр фото: «Увеличить» — крупный вариант, «Отклонить» рамкой, «Одобрить» — с «Отменить»", async ({
  page,
}) => {
  const api = await start(page);
  await page.goto("/moderation?queue=photos");
  await page.getByRole("button", { name: t.photoOpen(1, "Bogʻ zali") }).click();
  const viewer = page.locator(".photo-viewer");
  await expect(viewer).toBeVisible();
  // Отказ — рамкой, не второй залитой кнопкой рядом с «Одобрить»
  await expect(viewer.locator(".viewer-decline")).toHaveClass(/\bbtn-danger\b/);
  await expect(viewer.locator(".viewer-decline")).not.toHaveClass(/btn-danger-fill/);
  // Подсказка — про то, чем пользуются: клавиши с мышью, жесты на касаниях
  await expect(viewer.locator(isPhone(page) ? ".viewer-gestures" : ".viewer-keys")).toBeVisible();
  await expect(viewer.locator(isPhone(page) ? ".viewer-keys" : ".viewer-gestures")).toBeHidden();

  await viewer.getByRole("button", { name: t.photoZoomIn }).click();
  await expect(viewer.locator(".viewer-image")).toHaveAttribute("src", /\/1920\//);
  await viewer.getByRole("button", { name: t.photoZoomOut }).click();
  await expect(viewer.locator(".viewer-image")).toHaveAttribute("srcset", /.+/);

  // Смахнуть влево — следующее фото
  const frame = await viewer.locator(".viewer-frame").boundingBox();
  if (frame) {
    const y = frame.y + frame.height / 2;
    await page.mouse.move(frame.x + frame.width * 0.8, y);
    await page.mouse.down();
    await page.mouse.move(frame.x + frame.width * 0.2, y, { steps: 6 });
    await page.mouse.up();
  }
  await expect(page.getByRole("dialog", { name: t.photoViewerTitle(2, 2, "Bogʻ zali") })).toBeVisible();

  // «Одобрить» — решение ждёт 5 секунд, «Отменить» возвращает фото без запроса
  await viewer.getByRole("button", { name: t.photoApprove, exact: true }).click();
  const toast = page.locator(".ui-toast").filter({ hasText: t.photoApprovedUndo(2) });
  await expect(toast).toBeVisible();
  await toast.getByRole("button", { name: t.undo }).click();
  await page.waitForTimeout(5_500);
  expect(api.photoDecisions).toEqual([]);
  await expectNoAxeViolations(page, "просмотр фото: после отмены");
  expect(api.unexpected).toEqual([]);
});

test("недоставленное: «Бот заблокирован — позвоните»; вместо «Повторить» — к телефонам в заявке", async ({
  page,
}) => {
  const api = await start(page);
  await page.goto("/notifications");
  await expect(page.getByText(t.delivery.blocked).first()).toBeVisible();
  await expect(page.getByText("bot was blocked")).toHaveCount(0);
  await expect(page.getByRole("button", { name: new RegExp(t.retry) })).toHaveCount(0);
  await page.getByRole("link", { name: t.callRequest(1051) }).click();
  await expect(page).toHaveURL(`/requests/${REQUEST_ID}`);
  expect(api.unexpected).toEqual([]);
});

test("команда: приглашение создано — текст для сотрудника (бот → /start → панель) и «Отправить в Telegram»", async ({
  page,
}) => {
  const api = await start(page);
  await page.goto("/team");
  await page.getByRole("button", { name: t.inviteOpen }).click();
  const sheet = page.getByRole("dialog", { name: t.inviteTitle });
  await field(sheet, t.inviteName).fill("Дильноза");
  await field(sheet, t.inviteUsername).fill("dilnoza");
  await sheet.getByRole("button", { name: t.invite, exact: true }).click();
  const done = page.getByRole("dialog", { name: t.invited });
  await expect(done).toContainText(t.inviteSentHint);
  const text = done.getByRole("textbox", { name: t.inviteText });
  await expect(text).toHaveValue(/\/start/);
  await expect(text).toHaveValue(/@dilnoza/);
  await expect(done.getByRole("link", { name: t.shareTelegram })).toHaveAttribute(
    "href",
    /^https:\/\/t\.me\/share\/url\?url=https%3A%2F%2Ft\.me%2F/,
  );
  await expectNoAxeViolations(page, "команда: приглашение создано");
  await expectHitAreas(page, "команда: приглашение создано", ".invite-sent .btn");
  await done.getByRole("button", { name: t.done }).click();
  await expect(done).toHaveCount(0);
  expect(api.actions).toContain("POST /staff/team");
  expect(api.unexpected).toEqual([]);
});

test("витрину изменили, пока вписывали: «Показать свежую версию» — вписанное остаётся, общее — на выбор", async ({
  page,
}) => {
  const api = await start(page, { seeded: true, colleagueEdit: { descriptionRu: "Описание коллеги" } });
  await page.goto(`/listings/${CAR_LISTING_ID}`);
  // Поле — по подписи с пометкой: имя «Описание (RU)» без неё у выбора «ваш / новый» ниже
  const description = page.getByRole("textbox", {
    name: `${t.listingFields.descriptionRu} ${t.required}`,
    exact: true,
  });
  await description.fill("Моё описание кортежа");
  await page.getByRole("button", { name: t.save, exact: true }).click();
  await page.getByRole("button", { name: t.conflictShowFresh }).click();
  // Вписанное на месте, выбор — ваш вариант по умолчанию
  await expect(description).toHaveValue("Моё описание кортежа");
  const choice = page.getByRole("radiogroup", { name: t.listingFields.descriptionRu });
  await expect(choice.getByRole("radio", { name: t.conflictMine("Моё описание кортежа") })).toBeChecked();
  await expect(choice.getByRole("radio", { name: t.conflictTheirs("Описание коллеги") })).toBeVisible();
  await expectNoAxeViolations(page, "витрина: свежая версия");
  await page.getByRole("button", { name: t.save, exact: true }).click();
  await expect(page.getByText(t.saved, { exact: true })).toBeVisible();
  // Второй раз — от свежей версии и только то, что вписали
  expect(api.patches.at(-1)).toMatchObject({ descriptionRu: "Моё описание кортежа" });
  expect(api.patches.at(-1)?.version).toBe(((api.patches[0]?.version as number) ?? 0) + 1);
  expect(api.unexpected).toEqual([]);
});
