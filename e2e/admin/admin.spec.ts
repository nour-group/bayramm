import type { Page } from "@playwright/test";
import { t } from "../../apps/admin/src/texts";
import { expectHitAreas, expectNoAxeViolations, expectVisibleFocus } from "../support/a11y";
import { BOT } from "../support/account";
import { expect, test } from "../support/offline";
import {
  CLIENT_ID,
  LISTING_ID,
  mockStaffApi,
  NOW,
  REQUEST_ID,
  REVISION_ID,
  STAFF,
  VENDOR_ID,
} from "../support/staff-api";
import { fakeTelegram, telegramState } from "../support/telegram";

/* Панель оператора: страница входа (хаб на сайте и бот окружения, виджета здесь нет),
   вход как Mini App по initData, работа сотрудника на перехваченном /api — карточка
   создаётся, и чего не хватает для публикации, панель говорит словами, а не кодами.
   Вход через хаб целиком — hub/hub.spec.ts. */

const CONTROLS = [
  ".btn",
  ".action",
  ".nav a",
  ".chips button",
  "input:not([type=hidden])",
  ".ui-select",
  ".ui-icon-btn",
].join(", ");
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
    await expect(page.locator(".who").getByText(STAFF.displayName)).toBeVisible();
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
  test("новая карточка → чего не хватает для проверки и публикации — словами", async ({ page }) => {
    const api = await start(page);
    await page.goto(`/vendors/${VENDOR_ID}`);
    await page.getByRole("link", { name: t.newListing }).click();
    await expect(page).toHaveURL(`/vendors/${VENDOR_ID}/listings/new`);
    await expect(heading(page)).toHaveText(t.views.listingNew);
    await expectNoAxeViolations(page, "новая карточка");

    await page.getByLabel(t.listingFields.name ?? "", { exact: true }).fill("Navruz zali");
    await page.getByRole("button", { name: t.createListing }).click();
    await expect(page).toHaveURL(`/listings/${LISTING_ID}`);
    expect(api.created).toHaveLength(1);
    expect(api.created[0]).toMatchObject({ vendorId: VENDOR_ID, name: "Navruz zali" });

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

    // Попытка отправить на проверку: сервер отказал — объяснение, а не код ошибки
    await page.getByRole("button", { name: t.actions.submit }).click();
    await page.locator("form.confirm").getByRole("button", { name: t.actions.submit }).click();
    await expect(page.getByRole("alert")).toHaveText(t.api.publish_blocked ?? "");
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
      await expect(page.locator(".who").getByText(STAFF.displayName)).toBeVisible();
      await expect(page.getByRole("status")).toHaveCount(0);
      await expectNoAxeViolations(page, screen.name);
      await expectHitAreas(page, screen.name, CONTROLS);
      expect(api.unexpected).toEqual([]);
    });
  }

  test("вендоры: фокус с клавиатуры виден", async ({ page }) => {
    await start(page);
    await page.goto("/vendors");
    await expect(page.getByText(STAFF.displayName)).toBeVisible();
    await expectVisibleFocus(page, "вендоры", 12);
  });
});
