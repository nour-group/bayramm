import type { Page } from "@playwright/test";
import { t } from "../../apps/admin/src/texts";
import { expectHitAreas, expectNoAxeViolations, expectVisibleFocus } from "../support/a11y";
import { BOT } from "../support/account";
import { createVitrina, pick } from "../support/admin-ui";
import { expect, test } from "../support/offline";
import {
  CLIENT_ID,
  LISTING_ID,
  mockStaffApi,
  NOW,
  PHOTO_QUEUE_LISTING_ID,
  REQUEST_ID,
  REVISION_ID,
  STAFF,
  VENDOR_ID,
} from "../support/staff-api";
import { fakeTelegram, telegramState } from "../support/telegram";

/* Панель оператора: страница входа (хаб на сайте и бот окружения, виджета здесь нет),
   вход как Mini App по initData, работа сотрудника на перехваченном /api — карточка
   создаётся, и чего не хватает для публикации, панель говорит словами, а не кодами.
   Вход через хаб целиком — hub/hub.spec.ts. Идёт и на компьютере (admin-desktop), и на
   телефоне (admin-phone); телефонное — ещё и в mobile.spec.ts. */

const CONTROLS = [
  ".btn",
  ".action",
  ".nav a",
  ".tab",
  ".appbar-btn",
  ".appbar-account",
  ".chips button",
  "button.sort",
  "input:not([type=hidden])",
  ".ui-select",
  ".ui-icon-btn",
].join(", ");

/**
 * Вошедший сотрудник на экране: имя — в шапке (компьютер) или в подписи кнопки аккаунта
 * (телефон и планшет). На экране оно бывает и в списках (менеджер, автор заметки)
 */
const signedIn = (page: Page) =>
  page
    .locator(".who")
    .getByText(STAFF.displayName)
    .or(page.getByRole("banner").getByRole("button", { name: STAFF.displayName }));
// Коды блокеров из базы — на экране их быть не должно, только слова
const BLOCKER_CODES =
  /\b(price|capacity|district|descriptions|packages|photos|contract|stir|contacts|pd_consent)\b/;

async function start(page: Page, options: Parameters<typeof mockStaffApi>[1] = {}) {
  await page.clock.setFixedTime(NOW);
  return mockStaffApi(page, options);
}

const heading = (page: Page) => page.getByRole("heading", { level: 1 });

test.describe("вход", () => {
  test("страница входа: «Войти через Bayramm» и бот окружения; виджета Telegram нет", async ({ page }) => {
    const api = await start(page, { signedIn: false });
    await page.goto("/");
    await expect(page).toHaveURL("/login");
    await expect(heading(page)).toHaveText(t.login);
    await expect(page.getByRole("button", { name: t.loginHub })).toBeVisible();
    await expect(page.getByRole("link", { name: t.loginOpenBot })).toHaveAttribute(
      "href",
      `https://t.me/${BOT}?start=admin`,
    );
    // Виджет работает на одном домене бота — на сайте; у панели его нет
    await expect(page.locator("script[src*='telegram-widget']")).toHaveCount(0);
    await expectNoAxeViolations(page, "вход");
    await expectHitAreas(page, "вход", CONTROLS);
    expect(api.unexpected).toEqual([]);
  });

  test("API не ответило: в хаб не уйти — ошибка словами", async ({ page }) => {
    await start(page, { signedIn: false, methodsDown: true });
    await page.goto("/login");
    await page.getByRole("button", { name: t.loginHub }).click();
    await expect(page.getByRole("alert")).toHaveText(t.errors.unavailable);
    await expect(page).toHaveURL("/login");
    await expectNoAxeViolations(page, "вход: ошибка");
  });

  test("возврат из хаба без своего запроса: код не меняется, снова вход и объяснение", async ({ page }) => {
    const api = await start(page, { signedIn: false });
    await page.goto(`/auth/callback?code=${"c".repeat(43)}&state=forged_state_0123456789`);
    await expect(page).toHaveURL("/login");
    await expect(page.getByRole("alert")).toHaveText(t.errors.invalid);
    expect(api.elevated).toBe(0);
    expect(api.unexpected).toEqual([]);
  });

  test("панель как Mini App: вход по initData кнопки бота, сразу сессия сотрудника", async ({ page }) => {
    const api = await start(page, { signedIn: false });
    await fakeTelegram(page);
    await page.goto("/requests");
    await expect(signedIn(page)).toBeVisible();
    await expect(page).toHaveURL("/requests");
    expect(api.webapp).toHaveLength(1);
    expect(api.webapp[0]).toContain("hash=");
    expect((await telegramState(page)).calls.map((c) => c.name)).toEqual(
      expect.arrayContaining(["ready", "expand"]),
    );
    expect(api.unexpected).toEqual([]);
  });
});

test.describe("работа сотрудника", () => {
  test("новая витрина → чего не хватает для проверки и публикации — словами", async ({ page }) => {
    const api = await start(page);
    await page.goto(`/vendors/${VENDOR_ID}`);
    await page.getByRole("link", { name: t.addVitrina }).click();
    await expect(page).toHaveURL(`/vendors/${VENDOR_ID}/listings/new`);
    await expect(heading(page)).toHaveText(t.views.listingNew);
    await expectNoAxeViolations(page, "новая витрина");

    // Без категории витрину не завести: ошибка у поля, запроса нет
    await page.getByRole("button", { name: t.createVitrina }).click();
    await expect(page.locator(".field-error")).toHaveText(t.categoryRequired);
    expect(api.vitrinas).toEqual([]);
    await pick(page, t.categoryFirst, "Тойхона");
    await page.getByLabel(t.vitrinaName, { exact: true }).fill("Navruz zali");
    await page.getByRole("button", { name: t.createVitrina }).click();
    await expect(page).toHaveURL(`/listings/${LISTING_ID}`);
    expect(api.vitrinas).toEqual([{ categoryCode: "hall", name: "Navruz zali" }]);

    // Оба списка — словами из словаря панели
    const review = page.locator(".notice-warn").filter({ hasText: t.blockersReview });
    await expect(review).toBeVisible();
    for (const code of ["price", "capacity", "district", "descriptions", "phone", "packages", "photos"])
      await expect(review.getByRole("listitem").filter({ hasText: t.blockers[code] ?? code })).toHaveCount(1);
    const active = page.locator(".notice-warn").filter({ hasText: t.blockersActive });
    for (const code of ["contract", "stir", "contacts", "pd_consent"])
      await expect(active.getByRole("listitem").filter({ hasText: t.blockers[code] ?? code })).toHaveCount(1);
    expect((await page.locator(".notice-warn ul.blockers").allInnerTexts()).join("\n")).not.toMatch(
      BLOCKER_CODES,
    );

    // Попытка отправить на проверку: сервер отказал — объяснение и чего не хватает (из его
    // ответа) словами, а не код ошибки; раньше было «список ниже» без списка в шторке
    await page.getByRole("button", { name: t.actions.submit }).click();
    await page.locator("form.confirm").getByRole("button", { name: t.actions.submit }).click();
    const refusal = page.getByRole("alert");
    await expect(refusal).toContainText(t.api.publish_blocked ?? "");
    for (const code of ["price", "capacity", "district", "photos"])
      await expect(refusal.getByRole("listitem").filter({ hasText: t.blockers[code] ?? code })).toHaveCount(
        1,
      );
    expect(await refusal.innerText()).not.toMatch(BLOCKER_CODES);
    expect(api.actions).toEqual(["submit"]);
    await expectNoAxeViolations(page, "карточка");
    await expectHitAreas(page, "карточка", CONTROLS);
    expect(api.unexpected).toEqual([]);
  });

  const SCREENS = [
    { name: "вендоры", path: "/vendors" },
    { name: "вендор", path: `/vendors/${VENDOR_ID}` },
    { name: "новый вендор", path: "/vendors/new" },
    { name: "модерация", path: "/moderation" },
    { name: "заявки", path: "/requests" },
    { name: "заявка", path: `/requests/${REQUEST_ID}` },
    { name: "метрики", path: "/metrics" },
    { name: "клиенты", path: "/clients" },
    { name: "клиент", path: `/clients/${CLIENT_ID}` },
    { name: "правка карточки", path: `/revisions/${REVISION_ID}` },
    { name: "уведомления", path: "/notifications" },
    { name: "журнал", path: "/audit" },
    { name: "команда", path: "/team" },
    { name: "настройки", path: "/settings" },
  ] as const;

  for (const screen of SCREENS) {
    test(`${screen.name}: axe и зона нажатия`, async ({ page }) => {
      const api = await start(page);
      await page.goto(screen.path);
      // Имя — в шапке: на экране оно бывает и в списках (менеджер, автор заметки)
      await expect(signedIn(page)).toBeVisible();
      await expect(page.getByRole("status")).toHaveCount(0);
      await expectNoAxeViolations(page, screen.name);
      await expectHitAreas(page, screen.name, CONTROLS);
      expect(api.unexpected).toEqual([]);
    });
  }

  test("модерация: новые фото опубликованных карточек и кто предложил правку", async ({ page }) => {
    const api = await start(page);
    await page.goto("/moderation");
    const photos = page.getByRole("region", { name: t.photoQueue });
    await expect(photos.getByRole("link", { name: "Bogʻ zali" })).toHaveAttribute(
      "href",
      `/listings/${PHOTO_QUEUE_LISTING_ID}`,
    );
    await expect(photos).toContainText(t.pendingPhotos(2));
    await expect(page.getByRole("region", { name: t.revisions })).toContainText(
      t.proposedBy("partner", null),
    );
    expect(api.unexpected).toEqual([]);
  });

  test("занятые дни: отметка уходит с версией календаря, следующая — с новой", async ({ page }) => {
    const api = await start(page);
    await createVitrina(page);

    // «Сегодня» по Ташкенту при часах теста
    const today = page.locator(".cal-today");
    await expect(today).toHaveAttribute("aria-pressed", "false");
    await today.click();
    await expect(today).toHaveAttribute("aria-pressed", "true");
    await expect(today).toBeEnabled();
    await today.click();
    await expect(today).toHaveAttribute("aria-pressed", "false");

    // Несколько дней: занять три, освободить — через подтверждение со счётом
    await page.getByRole("button", { name: t.rangeMode }).click();
    await today.click();
    await page.locator(".cal-day").filter({ hasText: /^3$/ }).click();
    await page.getByRole("button", { name: t.rangeBusy(3) }).click();
    await expect(page.locator(".cal-day.cal-busy")).toHaveCount(3);
    await page.getByRole("button", { name: t.rangeMode }).click();
    await today.click();
    await page.locator(".cal-day").filter({ hasText: /^3$/ }).click();
    await page.getByRole("button", { name: t.rangeFree, exact: true }).click();
    const confirm = page.getByRole("alertdialog", { name: t.rangeFreeTitle });
    await expect(confirm).toContainText(t.rangeFreeText(3, 3, 0));
    await expectNoAxeViolations(page, "календарь: освободить несколько дней");
    await confirm.getByRole("button", { name: t.rangeFreeConfirm(3) }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page.locator(".cal-day.cal-busy")).toHaveCount(0);
    const three = ["2026-10-01", "2026-10-02", "2026-10-03"];
    expect(api.calendar).toEqual([
      { version: 0, busy: ["2026-10-01"] },
      { version: 1, free: ["2026-10-01"] },
      { version: 2, busy: three },
      { version: 3, free: three },
    ]);
    expect(api.unexpected).toEqual([]);
  });

  test("команда: приглашение по телефону — +998 и маска, чужой номер — ошибка у поля сразу", async ({
    page,
  }) => {
    const api = await start(page);
    await page.goto("/team");
    await expect(signedIn(page)).toBeVisible();
    const form = page.locator("form.fs");
    await form.getByRole("radio", { name: t.inviteByPhone }).check();
    // Вход по телефону в окружении выключен — подсказка честно об этом
    await expect(form).toContainText(t.inviteHintPhoneOff);
    const phone = form.getByLabel(t.invitePhone);
    await expect(phone).toHaveAttribute("type", "tel");
    await expect(phone).toHaveAttribute("inputmode", "numeric");
    await expect(form.locator(".affix-pre")).toHaveText("+998");
    await form.getByLabel(t.inviteName).fill("Новый менеджер");
    await phone.fill("+7 900 123 45 67");
    await expect(form.locator(".field-error")).toHaveText(t.input.phoneForeign);
    await expect(phone).toHaveValue("");
    await expect(form.getByRole("button", { name: t.invite })).toBeDisabled();
    // Номер в любой записи встаёт в маску
    await phone.fill("+998 (90) 123-45-67");
    await expect(phone).toHaveValue("90 123 45 67");
    await expect(form.locator(".field-error")).toHaveCount(0);
    // Роль — строками с пояснением
    await expect(form.getByRole("radio", { name: new RegExp(`^${t.roles.moderator}`) })).toBeVisible();
    await expectNoAxeViolations(page, "команда: приглашение по телефону");
    await expectHitAreas(page, "команда: приглашение по телефону", CONTROLS);
    expect(api.unexpected).toEqual([]);
  });

  test("вендоры: фокус с клавиатуры виден", async ({ page }) => {
    await start(page);
    await page.goto("/vendors");
    await expect(signedIn(page)).toBeVisible();
    await expectVisibleFocus(page, "вендоры", 12);
  });
});
