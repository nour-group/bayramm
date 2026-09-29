import type { Page } from "@playwright/test";
import { t } from "../../apps/admin/src/texts";
import { expectHitAreas, expectNoAxeViolations, expectVisibleFocus } from "../support/a11y";
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

/* Панель оператора: страница входа с виджетом Telegram, вход по данным виджета,
   работа сотрудника на перехваченном /api — карточка создаётся, и чего не хватает для
   публикации, панель говорит словами, а не кодами. */

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
  test("страница входа: контейнер виджета Telegram с ботом окружения и адресом возврата", async ({
    page,
  }) => {
    const api = await start(page, { signedIn: false });
    await page.goto("/");
    await expect(page).toHaveURL("/login");
    await expect(heading(page)).toHaveText(t.login);

    const script = page.locator(".tg-login script");
    await expect(script).toHaveCount(1);
    await expect(script).toHaveAttribute("src", /^https:\/\/telegram\.org\/js\/telegram-widget\.js/);
    await expect(script).toHaveAttribute("data-telegram-login", "bayramm_demo_bot");
    await expect(script).toHaveAttribute("data-auth-url", `${new URL(page.url()).origin}/login/telegram`);
    // Колбэк через eval CSP не пропустит — только редирект data-auth-url
    await expect(script).not.toHaveAttribute("data-onauth", /.*/);
    await expectNoAxeViolations(page, "вход");
    expect(api.unexpected).toEqual([]);
  });

  test("API не отдало бота: ошибка словами и «Повторить»", async ({ page }) => {
    await start(page, { signedIn: false, botDown: true });
    await page.goto("/login");
    await expect(page.getByRole("alert")).toHaveText(t.loginBotFailed);
    await expect(page.getByRole("button", { name: t.retry })).toBeVisible();
    await expectNoAxeViolations(page, "вход: ошибка");
    await expectHitAreas(page, "вход: ошибка", CONTROLS);
  });

  test("возврат виджета: вход, подписанные данные убраны из адреса", async ({ page }) => {
    await start(page, { signedIn: false });
    const auth = Math.floor(NOW.getTime() / 1000);
    await page.goto(`/login/telegram?id=42&first_name=Dilnoza&auth_date=${auth}&hash=e2e-good`);
    await expect(page.getByText(STAFF.displayName)).toBeVisible();
    await expect(page).toHaveURL("/vendors");
    expect(page.url()).not.toContain("hash=");
    await expect(heading(page)).toHaveText(t.vendors);
  });

  test("возврат виджета с неверной подписью: снова вход и объяснение", async ({ page }) => {
    await start(page, { signedIn: false });
    await page.goto("/login/telegram?id=42&first_name=X&auth_date=1&hash=forged");
    await expect(page).toHaveURL("/login");
    await expect(page.getByRole("alert")).toHaveText(t.errors.invalid);
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
