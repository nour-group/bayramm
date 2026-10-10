import type { Page } from "@playwright/test";
import { t } from "../../apps/admin/src/texts";
import { expectHitAreas, expectNoAxeViolations } from "../support/a11y";
import { pick } from "../support/admin-ui";
import { expect, test } from "../support/offline";
import {
  CAKE_LISTING_ID,
  CAR_CONTACTS,
  CAR_LISTING_ID,
  CLIENT_ID,
  LISTING_ID,
  mockStaffApi,
  NOW,
  PHOTO_LISTING_ID,
} from "../support/staff-api";
import { horizontalOverflow } from "../support/web";

/* Люди и контакты в панели: клиенты — человеком, а не кодом (имя, вход, язык, последняя
   заявка; код — вторым текстом); контакты витрины для клиентов — телефон и Telegram (скрыты до
   «Показать», пишутся полем, Telegram можно убрать); «Контакты витрин» в метриках. Телефон и
   компьютер. */

const CONTROLS = [
  ".btn",
  ".chip",
  "input:not([type=hidden])",
  "textarea",
  ".ui-select",
  ".ui-check",
  ".ui-icon-btn",
].join(", ");

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 720;
const heading = (page: Page) => page.getByRole("heading", { level: 1 });

async function start(page: Page, options: Parameters<typeof mockStaffApi>[1] = { seeded: true }) {
  await page.clock.setFixedTime(NOW);
  return mockStaffApi(page, options);
}

/** Строка списка: карточка на телефоне, строка таблицы на компьютере */
const rows = (page: Page) => page.locator(".rcards .rcard, tbody tr");

test.describe("клиенты", () => {
  test("список: имя, вход, язык, последняя заявка; код клиента — вторым текстом, а не ссылкой", async ({
    page,
  }) => {
    const api = await start(page);
    await page.goto("/clients");
    await expect(heading(page)).toHaveText(t.clients);
    await expect(rows(page)).toHaveCount(4);

    const first = rows(page).nth(0);
    await expect(first.getByRole("link", { name: "Азиза К." })).toHaveAttribute(
      "href",
      `/clients/${CLIENT_ID}`,
    );
    await expect(first).toContainText("C-00000000");
    await expect(first).toContainText("Telegram");
    await expect(first).toContainText(t.locales.uz ?? "");
    await expect(first).toContainText(`${t.requestNo(1051)} · Lola zali`);
    await expect(first).toContainText(t.requestStatus.viewed ?? "");
    // Код — не название ссылки: по нему ищут, но человека им не называют
    await expect(page.getByRole("link", { name: "C-00000000" })).toHaveCount(0);

    await expect(rows(page).nth(1)).toContainText("Рустам Б.");
    await expect(rows(page).nth(1)).toContainText("Telegram, телефон");
    await expect(rows(page).nth(1)).toContainText(t.requestStatus.contacted ?? "");
    // Без имени и без заявок — словами, а не пустотой
    await expect(rows(page).nth(2)).toContainText(t.clientNoName);
    await expect(rows(page).nth(2)).toContainText(t.clientNoRequests);
    await expect(rows(page).nth(3)).toContainText(t.clientAccountDeleted);
    await expect(rows(page).nth(3)).toContainText(t.clientDeleted);

    const width = page.viewportSize()?.width ?? 0;
    expect((await horizontalOverflow(page)).scrollWidth).toBeLessThanOrEqual(width);
    await expectNoAxeViolations(page, "клиенты");
    await expectHitAreas(page, "клиенты", CONTROLS);
    expect(api.unexpected).toEqual([]);
  });

  test("клиент: заголовок — имя, код — мелко рядом с состоянием; способ входа — в профиле", async ({
    page,
  }) => {
    await start(page);
    await page.goto(`/clients/${CLIENT_ID}`);
    await expect(heading(page)).toHaveText("Азиза Каримова");
    await expect(page.locator(".client-ref")).toHaveText("C-00000000");
    const profile = page.getByRole("region", { name: t.clientProfile });
    await expect(profile).toContainText(`${t.clientSignIn}Telegram`);
    await expect(profile).toContainText("@aziza_k");
    // Источник согласия — словами, а не «tma»
    await expect(page.getByRole("region", { name: t.clientConsents })).toContainText(t.sources.tma ?? "");
    await expectNoAxeViolations(page, "клиент");
  });

  test("только заблокированные: фильтр уходит на сервер", async ({ page }) => {
    const api = await start(page);
    await page.goto("/clients");
    if (isPhone(page)) {
      await page.getByRole("button", { name: t.filters }).click();
      const sheet = page.getByRole("dialog", { name: t.filters });
      await sheet.getByRole("switch", { name: t.onlyBlocked }).click();
      await sheet.getByRole("button", { name: t.done }).click();
    } else {
      await page.getByRole("button", { name: t.onlyBlocked }).click();
    }
    await expect(page.getByText(t.clientsEmpty)).toBeVisible();
    expect(api.queries.at(-1)).toContain("blocked=1");
  });
});

test.describe("контакты витрины для клиентов", () => {
  const contacts = (page: Page) => page.locator(".contacts-reveal");
  const telegramField = (page: Page) => page.getByLabel(t.telegramChange);
  const save = (page: Page) => page.getByRole("button", { name: t.save, exact: true });

  test("телефон и Telegram скрыты до «Показать»; одно чтение открывает оба", async ({ page }) => {
    const api = await start(page);
    await page.goto(`/listings/${CAR_LISTING_ID}`);
    await expect(heading(page)).toHaveText("Oq kortej");
    await expect(contacts(page)).not.toContainText(CAR_CONTACTS.telegram);
    await expect(contacts(page)).not.toContainText("111 22 33");
    expect(api.reveals).toEqual([]);

    await contacts(page).getByRole("button", { name: t.contactsShow }).click();
    await expect(contacts(page).getByRole("link", { name: "+998 90 111 22 33" })).toHaveAttribute(
      "href",
      "tel:+998901112233",
    );
    await expect(contacts(page).getByRole("link", { name: `@${CAR_CONTACTS.telegram}` })).toHaveAttribute(
      "href",
      `https://t.me/${CAR_CONTACTS.telegram}`,
    );
    expect(api.reveals).toEqual([CAR_LISTING_ID]);
    // axe меряет цели под липкой шапкой «закрытыми»: проверяем с начала страницы
    await page.evaluate(() => window.scrollTo(0, 0));
    await expectNoAxeViolations(page, "контакты витрины: показаны");
    await expectHitAreas(page, "контакты витрины", CONTROLS);
    expect(api.unexpected).toEqual([]);
  });

  test("Telegram: плохое имя — ошибка под полем; имя, @имя и t.me/имя уходят как вписаны; после правки контакты снова скрыты", async ({
    page,
  }) => {
    const api = await start(page);
    await page.goto(`/listings/${CAR_LISTING_ID}`);
    await contacts(page).getByRole("button", { name: t.contactsShow }).click();
    await expect(contacts(page)).toContainText(`@${CAR_CONTACTS.telegram}`);

    await telegramField(page).fill("ab");
    await save(page).click();
    await expect(
      page.locator(".field-error").filter({ hasText: t.listingFieldErrors.telegram ?? "" }),
    ).toBeVisible();
    await expect(telegramField(page)).toHaveValue("ab");
    await page.evaluate(() => window.scrollTo(0, 0));
    await expectNoAxeViolations(page, "Telegram витрины: ошибка");

    await telegramField(page).fill("https://t.me/Oq_Kortej_Official");
    await save(page).click();
    await expect(page.getByRole("status").filter({ hasText: t.saved })).toBeVisible();
    expect(api.patches.map((body) => body.telegram)).toEqual(["ab", "https://t.me/Oq_Kortej_Official"]);
    // Показанное было до правки: контакты закрылись и просят нового «Показать»
    await expect(contacts(page)).not.toContainText(CAR_CONTACTS.telegram);
    await contacts(page).getByRole("button", { name: t.contactsShow }).click();
    await expect(contacts(page).getByRole("link", { name: "@Oq_Kortej_Official" })).toBeVisible();
    expect(api.reveals).toEqual([CAR_LISTING_ID, CAR_LISTING_ID]);
    expect(api.unexpected).toEqual([]);
  });

  test("«Убрать Telegram» — null; в контактах так и сказано", async ({ page }) => {
    const api = await start(page);
    await page.goto(`/listings/${CAR_LISTING_ID}`);
    await page.getByLabel(t.telegramRemove).check();
    await expect(telegramField(page)).toBeDisabled();
    await save(page).click();
    await expect(page.getByRole("status").filter({ hasText: t.saved })).toBeVisible();
    expect(api.patches.at(-1)?.telegram).toBeNull();
    await expect(contacts(page)).toContainText(t.telegramMissing);
    // Убрать больше нечего: галочки нет
    await expect(page.getByLabel(t.telegramRemove)).toHaveCount(0);
    expect(api.unexpected).toEqual([]);
  });

  test("«Убрать телефон» — пока витрина не на проверке и не в каталоге; Telegram уходит с ним", async ({
    page,
  }) => {
    const api = await start(page);
    // Опубликованную без телефона не оставить: галочки нет
    await page.goto(`/listings/${CAR_LISTING_ID}`);
    await expect(heading(page)).toHaveText("Oq kortej");
    await expect(page.getByLabel(t.phoneRemove)).toHaveCount(0);

    await page.goto(`/listings/${CAKE_LISTING_ID}`);
    await expect(heading(page)).toHaveText("Shirin");
    await expect(page.getByLabel(t.phoneRemove)).toHaveCount(0);
    await page.getByLabel(t.phoneChange).fill("+998 90 111 22 33");
    await save(page).click();
    await expect(page.getByRole("status").filter({ hasText: t.saved })).toBeVisible();

    await page.getByLabel(t.phoneRemove).check();
    await expect(page.getByLabel(t.phoneChange)).toBeDisabled();
    await expect(telegramField(page)).toBeDisabled();
    await expect(page.getByText(t.phoneRemoveHint)).toBeVisible();
    await save(page).click();
    await expect(page.getByRole("status").filter({ hasText: t.saved })).toBeVisible();
    expect(api.patches.map((body) => body.phone)).toEqual(["+998 90 111 22 33", null]);
    await expect(contacts(page)).toContainText(t.phoneMissing);
    await expect(page.getByLabel(t.phoneRemove)).toHaveCount(0);
    expect(api.unexpected).toEqual([]);
  });

  test("новая витрина без контактов: «нет» словами, кнопки «Показать» нет", async ({ page }) => {
    await start(page);
    // У фото и видео в подмене контактов нет
    await page.goto(`/listings/${PHOTO_LISTING_ID}`);
    await expect(heading(page)).toHaveText("Kadr studio");
    await expect(contacts(page)).toContainText(t.phoneMissing);
    await expect(contacts(page)).toContainText(t.telegramMissing);
    await expect(contacts(page).getByRole("button", { name: t.contactsShow })).toHaveCount(0);
  });
});

test.describe("метрики: контакты витрин", () => {
  const section = (page: Page) => page.getByRole("region", { name: t.metricsContacts });

  /** Фильтр категории метрик: список на компьютере, шторка на телефоне */
  async function chooseCategory(page: Page, name: string) {
    if (!isPhone(page)) return pick(page, t.colCategory, name);
    await page.getByRole("button", { name: t.filters }).click();
    const sheet = page.getByRole("dialog", { name: t.filters });
    await sheet.getByRole("radiogroup", { name: t.colCategory }).getByRole("radio", { name }).check();
    await sheet.getByRole("button", { name: t.done }).click();
  }

  test("за 30 дней: витрина ссылкой; открыли, позвонить, Telegram — числами", async ({ page }) => {
    const api = await start(page);
    await page.goto("/metrics");
    await expect(heading(page)).toHaveText(t.metrics);
    const list = section(page);
    await expect(list.getByRole("link", { name: "Lola zali" })).toHaveAttribute(
      "href",
      `/listings/${LISTING_ID}`,
    );
    await expect(list.getByRole("link", { name: "Oq kortej" })).toBeVisible();
    const first = list.locator(".rcard, tbody tr").first();
    await expect(first).toContainText("48");
    await expect(first).toContainText("21");
    await expect(first).toContainText("9");
    await expect(list.locator(".rcard, tbody tr")).toHaveCount(3);
    expect(api.queries).toContain("contacts?days=30");
    const width = page.viewportSize()?.width ?? 0;
    expect((await horizontalOverflow(page)).scrollWidth).toBeLessThanOrEqual(width);
    await expectNoAxeViolations(page, "метрики: контакты витрин");
    await expectHitAreas(page, "метрики", CONTROLS);
    expect(api.unexpected).toEqual([]);
  });

  test("фильтр категории сужает и контакты; пусто — словами", async ({ page }) => {
    const api = await start(page);
    await page.goto("/metrics");
    await expect(section(page).locator(".rcard, tbody tr")).toHaveCount(3);
    // До выбора фильтр говорит, что он сужает
    await expect(page.getByText(t.metricsFilterScope)).toBeVisible();
    await chooseCategory(page, "Кортеж");
    await expect(section(page).locator(".rcard, tbody tr")).toHaveCount(1);
    await expect(section(page)).toContainText("Oq kortej");
    expect(api.queries.some((q) => q === "contacts?days=30&category=car")).toBe(true);

    // Категория без контактов
    await chooseCategory(page, "Торты и сладости");
    await expect(section(page).getByText(t.metricsContactsEmpty)).toBeVisible();
    await expectNoAxeViolations(page, "метрики: контактов нет");
  });
});
