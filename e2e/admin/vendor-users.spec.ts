import type { Locator, Page } from "@playwright/test";
import { apiErrorText, t } from "../../apps/admin/src/texts";
import { expectHitAreas, expectNoAxeViolations } from "../support/a11y";
import { APPS, BOT } from "../support/account";
import { named } from "../support/admin-ui";
import { expect, test } from "../support/offline";
import { CABINET_OWNER, mockStaffApi, NOW, VENDOR_ID } from "../support/staff-api";
import { horizontalOverflow } from "../support/web";

/* Вход в кабинет вендора в панели: «+ Пригласить» открывает шторку — сотрудник площадки с ролью и
   языком, текст приглашения (бот с «Я партнёр» и кабинет со входом) — там же; у пользователя две
   кнопки, «Изменить» (шторка с телефоном) и «Ещё», — на любой ширине; убрать из кабинета. Последнего
   владельца сервер не убирает — панель говорит это словами. Телефон и компьютер. */

const CONTROLS = [".btn", "input:not([type=hidden])", ".ui-radio", "textarea"].join(", ");

const MEMBER = {
  ...CABINET_OWNER,
  id: "00000000-0000-4000-8200-000000000002",
  fullName: "Азиз Каримов",
  role: "member" as const,
};

const usersPanel = (page: Page) =>
  page.locator("section.panel").filter({ has: page.locator("#users-title") });
const card = (page: Page, name: string) => usersPanel(page).locator(".vuser").filter({ hasText: name });

/** Действие из «Ещё» у пользователя: на любой ширине — кнопка «Ещё» и пункт в шторке */
async function menuAction(page: Page, user: Locator, label: string) {
  await user.locator(".btn-more").click();
  await page.getByRole("dialog").getByRole("button", { name: label }).click();
}

async function start(page: Page, users = [CABINET_OWNER]) {
  await page.clock.setFixedTime(NOW);
  // Буфер обмена — в окно страницы: так видно, что именно скопировали
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as unknown as { copied: string }).copied = text;
        },
      },
    });
  });
  return mockStaffApi(page, { cabinetUsers: users });
}

test("пригласить сотрудника площадки в шторке, отправить ему приглашение и убрать из кабинета", async ({
  page,
}) => {
  const api = await start(page);
  await page.goto(`/vendors/${VENDOR_ID}`);
  const owner = card(page, CABINET_OWNER.fullName ?? "");
  await expect(owner).toContainText(t.vuStatus.accepted);
  // Уведомления приходят — строки про Telegram нет; у карточки две кнопки: «Изменить» и «Ещё»
  await expect(owner).not.toContainText("Telegram");
  await expect(owner.getByRole("button")).toHaveCount(2);
  await expect(page.locator(".vuser-invite")).toHaveCount(0);

  await usersPanel(page).getByRole("button", { name: t.vuInviteOpen }).click();
  const sheet = page.getByRole("dialog", { name: t.vuInviteTitle });
  const form = sheet.locator(".vuser-invite");
  await form.getByLabel(named(t.userName)).fill("Дильшод");
  await form.getByLabel(t.userPhone).fill("90 111 22 33");
  // Роль — явно: без неё приглашения нет
  await form.getByRole("button", { name: t.vuInvite }).click();
  await expect(form).toContainText(t.vuRoleRequired);
  expect(api.cabinet).toEqual([]);

  // Подсказка — только к выбранной роли
  await form.getByRole("radio", { name: t.vuRoles.member }).check();
  await expect(form).toContainText(t.vuRoleHints.member);
  await expect(form).not.toContainText(t.vuRoleHints.owner);
  await form.getByRole("radio", { name: t.vuLocales.ru }).check();
  await expectNoAxeViolations(page, "приглашение в кабинет");
  await expectHitAreas(page, "приглашение в кабинет", CONTROLS);
  await form.getByRole("button", { name: t.vuInvite }).click();
  await expect(sheet.getByRole("status").first()).toHaveText(t.vuInvited);
  expect(api.cabinet[0]).toEqual({
    key: `POST /staff/vendors/${VENDOR_ID}/users`,
    body: { phone: "+998901112233", role: "member", locale: "ru", fullName: "Дильшод" },
  });

  // Текст приглашения — на языке партнёра: бот с «Я партнёр» и кабинет со входом
  await sheet.getByRole("button", { name: t.vuCopy }).click();
  await expect(sheet).toContainText(t.vuCopied);
  const copied = await page.evaluate(() => (window as unknown as { copied?: string }).copied ?? "");
  expect(copied).toContain("Здравствуйте, Дильшод!");
  expect(copied).toContain("«Lola»");
  expect(copied).toContain(`https://t.me/${BOT}?start=partner`);
  expect(copied).toContain(`${APPS.vendor}/?signin=1&lang=ru`);
  await sheet.getByRole("button", { name: t.done }).click();
  await expect(sheet).toHaveCount(0);

  const invited = card(page, "Дильшод");
  await expect(invited).toContainText(t.vuRoles.member);
  await expect(invited).toContainText(t.vuStatus.pending);
  // Ждёт входа — «уведомления не приходят» не пишем: это не поломка
  await expect(invited).not.toContainText(t.vuNotNotifiable);

  const width = page.viewportSize()?.width ?? 0;
  expect((await horizontalOverflow(page)).scrollWidth).toBeLessThanOrEqual(width);
  await expectNoAxeViolations(page, "вход в кабинет");
  await expectHitAreas(page, "вход в кабинет", CONTROLS);

  await menuAction(page, invited, t.vuRemove);
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText(t.vuRemoveHintPending);
  await confirm.getByRole("button", { name: t.vuRemove }).click();
  await expect(confirm).toBeHidden();
  await expect(invited).toHaveCount(0);
  expect(api.cabinet.at(-1)?.key).toMatch(new RegExp(`^DELETE /staff/vendors/${VENDOR_ID}/users/`));
  expect(api.unexpected).toEqual([]);
});

test("последнего владельца при сотрудниках не убрать — ответ словами, пользователь на месте", async ({
  page,
}) => {
  const api = await start(page, [CABINET_OWNER, MEMBER]);
  await page.goto(`/vendors/${VENDOR_ID}`);
  const owner = card(page, CABINET_OWNER.fullName ?? "");
  await menuAction(page, owner, t.vuRemove);
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText(t.vuRemoveHint);
  await confirm.getByRole("button", { name: t.vuRemove }).click();
  await expect(confirm.getByRole("alert")).toHaveText(apiErrorText("vendor_last_owner"));
  await confirm.getByRole("button", { name: t.cancel }).click();
  await expect(owner).toBeVisible();
  await expect(usersPanel(page).locator(".vuser")).toHaveCount(2);
  expect(api.unexpected).toEqual([]);
});

test("сменить роль и язык: сотрудник площадки становится владельцем; телефон — в шторке «Изменить»", async ({
  page,
}) => {
  const api = await start(page, [CABINET_OWNER, MEMBER]);
  await page.goto(`/vendors/${VENDOR_ID}`);
  const member = card(page, MEMBER.fullName);
  await member.getByRole("button", { name: t.vuEdit }).click();
  const sheet = page.getByRole("dialog", { name: new RegExp(`^${t.vuEdit}`) });
  // Номер скрыт, пока не нажали «Показать»: на карточке его нет
  await expect(member).not.toContainText(t.input.phoneMasked);
  await expect(sheet).toContainText(t.input.phoneMasked);
  await expectNoAxeViolations(page, "изменить пользователя кабинета");
  await expectHitAreas(page, "изменить пользователя кабинета", CONTROLS);
  await sheet.getByRole("radio", { name: t.vuRoles.owner }).check();
  await sheet.getByRole("radio", { name: t.vuLocales.ru }).check();
  await sheet.getByRole("button", { name: t.save }).click();
  await expect(sheet).toHaveCount(0);
  await expect(member).toContainText(t.vuRoles.owner);
  await expect(member).toContainText(t.vuLocaleLine(t.vuLocales.ru));
  expect(api.cabinet.at(-1)).toEqual({
    key: `PATCH /staff/vendors/${VENDOR_ID}/users/${MEMBER.id}`,
    body: { role: "owner", locale: "ru" },
  });
  expect(api.unexpected).toEqual([]);
});
