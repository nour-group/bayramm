import { dictionaries } from "@bayramm/shared";
import type { Page } from "@playwright/test";
import { t as adminT } from "../../apps/admin/src/texts";
import { vendorDict } from "../../apps/vendor/src/i18n";
import { expectNoAxeViolations } from "../support/a11y";
import { APPS, apiOf, watchHub } from "../support/account";
import { expect, test } from "../support/offline";
import { mockStaffApi, STAFF } from "../support/staff-api";
import { mockVendorApi, NOW } from "../support/vendor-api";

/* Один аккаунт — вход откуда угодно. Кабинет и панель в браузере входят через хаб на
   сайте: уводят туда с PKCE (state + challenge), хаб после входа возвращает на
   <приложение>/auth/callback с одноразовым кодом, приложение меняет код + verifier на свою
   сессию. Сайт — демо-API клиента в этой же вкладке; /api кабинета и панели — подмены,
   которые сверяют обмен с тем, что видел браузер (support/account.ts). */

const ru = dictionaries.ru;
const v = vendorDict.ru;
const heading = (page: Page) => page.getByRole("heading", { level: 1 });

async function start(page: Page) {
  await page.clock.setFixedTime(NOW);
  const hub = watchHub(page);
  const vendor = await mockVendorApi(page, { staff: true, hub, match: apiOf(APPS.vendor) });
  const staff = await mockStaffApi(page, { signedIn: false, hub, match: apiOf(APPS.admin) });
  return { hub, vendor, staff };
}

test("кабинет из браузера через хаб, оттуда — панель тем же входом, и назад в кабинет", async ({ page }) => {
  const { hub, vendor, staff } = await start(page);

  await page.goto(`${APPS.vendor}/calendar`);
  await expect(heading(page)).toHaveText(v.gateOutsideTitle);
  await page.getByRole("button", { name: v.signIn, exact: true }).click();

  // Демо-аккаунт на сайте уже вошёл: хаб сразу отдаёт код, кабинет открывается там, где уходили
  await expect(page).toHaveURL(`${APPS.vendor}/calendar`);
  await expect(heading(page)).toHaveText(v.calendar);
  expect(hub.requests.map((r) => r.app)).toEqual(["vendor"]);
  expect(hub.exchanges).toEqual([{ origin: APPS.vendor, ok: true }]);

  // Роль сотрудника у того же аккаунта: ссылка на панель — с ?signin=1, сразу в хаб
  const toAdmin = page.getByRole("link", { name: v.toAdmin });
  await expect(toAdmin).toHaveAttribute("href", `${APPS.admin}/?signin=1`);
  await toAdmin.click();
  await expect(page.locator(".who").getByText(STAFF.displayName)).toBeVisible();
  expect(new URL(page.url()).origin).toBe(APPS.admin);
  // Код, state и ?signin не остаются в адресе
  expect(page.url()).not.toMatch(/code=|state=|signin=/);
  expect(hub.requests.map((r) => r.app)).toEqual(["vendor", "admin"]);
  expect(hub.exchanges).toEqual([
    { origin: APPS.vendor, ok: true },
    { origin: APPS.admin, ok: true },
  ]);
  // Сессия аккаунта из обмена — только чтобы стать сотрудником: сразу отозвана
  expect(staff.elevated).toBe(1);
  expect(staff.loggedOut).toEqual(["account"]);

  // Из панели — в клиентское приложение и в кабинет; в кабинет — без второго входа
  await expect(page.getByRole("link", { name: adminT.toClientApp })).toHaveAttribute("href", APPS.web);
  const toCabinet = page.getByRole("link", { name: adminT.toCabinet });
  await expect(toCabinet).toHaveAttribute("href", `${APPS.vendor}/?signin=1`);
  await toCabinet.click();
  await expect(heading(page)).toHaveText(v.requests);
  expect(new URL(page.url()).origin).toBe(APPS.vendor);
  expect(hub.requests).toHaveLength(2);

  expect(vendor.unexpected).toEqual([]);
  expect(staff.unexpected).toEqual([]);
});

test("хаб без входа на сайте: код из сообщения, неверный код — словами, затем кабинет", async ({ page }) => {
  const { hub, vendor } = await start(page);
  // Сайт — гостем (?guest): в демо без него аккаунт уже вошёл
  await page.addInitScript((web) => {
    const { origin, pathname, search } = window.location;
    if (origin === web && pathname === "/auth" && search.includes("app=") && !search.includes("guest"))
      window.history.replaceState(null, "", `${pathname}${search}&guest`);
  }, APPS.web);

  await page.goto(`${APPS.vendor}/requests`);
  await page.getByRole("button", { name: v.signIn, exact: true }).click();
  await expect(page).toHaveURL(`${APPS.web}/auth`);
  await expect(heading(page)).toHaveText(ru.authTitle);
  await expect(page.getByText(ru.authForVendor)).toBeVisible();
  // state и challenge не остаются в истории вкладки
  expect(page.url()).not.toMatch(/state=|challenge=/);
  await expectNoAxeViolations(page, "хаб входа");

  const form = page.locator("form.phone-code");
  await form.getByLabel(ru.authPhoneLabel).fill("901234567");
  await form.getByRole("button", { name: ru.authSendCode }).click();
  await form.getByLabel(ru.authCodeLabel).fill("000000");
  await form.getByRole("button", { name: ru.authSignIn, exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(ru.authErrCode);
  await expectNoAxeViolations(page, "хаб входа: код");

  await form.getByLabel(ru.authCodeLabel).fill("123456");
  await form.getByRole("button", { name: ru.authSignIn, exact: true }).click();
  await expect(page).toHaveURL(`${APPS.vendor}/requests`);
  await expect(heading(page)).toHaveText(v.requests);
  expect(hub.exchanges).toEqual([{ origin: APPS.vendor, ok: true }]);
  expect(vendor.unexpected).toEqual([]);
});

test("профиль на сайте: роли аккаунта — ссылки в кабинет и панель со входом через хаб", async ({ page }) => {
  await page.clock.setFixedTime(NOW);
  await page.goto(`${APPS.web}/profile`);
  await expect(page.getByRole("link", { name: ru.accVendor })).toHaveAttribute(
    "href",
    `${APPS.vendor}/?signin=1`,
  );
  await expect(page.getByRole("link", { name: ru.accAdmin })).toHaveAttribute(
    "href",
    `${APPS.admin}/?signin=1`,
  );
});
