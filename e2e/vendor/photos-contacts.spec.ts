import type { VendorRole } from "@bayramm/shared/api/vendor";
import type { Locator, Page } from "@playwright/test";
import { fill, vendorDict } from "../../apps/vendor/src/i18n";
import { expectHitAreas, expectNoAxeViolations } from "../support/a11y";
import { labelled } from "../support/field-name";
import { expect, test } from "../support/offline";
import { fakeTelegram } from "../support/telegram";
import { mockVendorApi, NOW, PHOTO_ID } from "../support/vendor-api";

/* Что партнёр делает на витрине сам: порядок и обложка фото (шторка по нажатию на плитку), «×» с
   невидимым слоем 44px, подтверждение «что на фото» не отмечено заранее, отзыв витрины с проверки,
   контакты — сразу на черновике и запросом на проверку на сайте; сотрудник площадки только смотрит. */

const t = vendorDict.ru;

/** Поле по подписи (с пометкой «обязательно / по желанию» у неё или без) */
const field = (scope: Page | Locator, label: string) => labelled(scope, label, [t.required, t.optionalPh]);
const CONTROLS = [
  ".btn",
  ".pill",
  ".icon-btn",
  ".photo-tile",
  ".photo-x",
  "label.ui-radio",
  "label.ui-check",
  ".ui-drop-face",
  ".ui-btn",
  ".ui-select",
].join(", ");

async function start(
  page: Page,
  { role = "owner" as VendorRole, listings = "one" as "one" | "many", readyDraft = false } = {},
) {
  await page.clock.setFixedTime(NOW);
  const api = await mockVendorApi(page, { role, listings, readyDraft });
  await fakeTelegram(page);
  return api;
}

const isDesktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;
const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const photosSection = (page: Page) => page.locator("section[aria-labelledby='photos-title']");
const tile = (page: Page, n: number) => page.getByRole("button", { name: fill(t.photoOpenLabel, { n }) });
/** Какие фото и в каком порядке: номер из адреса картинки (…/p3.webp) */
const order = async (page: Page) =>
  photosSection(page)
    .locator(".photos img")
    .evaluateAll((images) => images.map((img) => /\/p(\d+)\.webp/.exec((img as HTMLImageElement).src)?.[1]));

async function chooseVitrina(page: Page, name: string) {
  if (isDesktop(page)) {
    await page.locator(".side-vitrinas").getByRole("button", { name }).click();
    return;
  }
  // До четырёх витрин — пилюли (ListingPicker.tsx)
  await page.locator("main .vitrina-pills").getByRole("button", { name }).click();
}

test.describe("фото: порядок и обложка", () => {
  test("плитка — кнопка: шторка с действиями, порядок и обложка применяются сразу", async ({ page }) => {
    const api = await start(page);
    await page.goto("/card");
    await expect(heading(page)).toHaveText(t.card);
    const section = photosSection(page);
    // Одобрены три фото (первое — обложка), четвёртое ждёт решения
    expect(await order(page)).toEqual(["1", "2", "3", "4"]);
    await expect(section.locator(".photo-chip").first()).toHaveText(t.photoCover);

    // Второе (сразу после обложки) можно только отодвинуть назад
    await tile(page, 2).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByRole("heading", { name: fill(t.photoSheetTitle, { n: 2 }) })).toBeVisible();
    // Действия — в теле шторки; «Закрыть» — крестик набора в заголовке
    await expect(sheet.locator(".ui-dialog-body").getByRole("button")).toHaveText([
      t.photoMakeCover,
      t.photoLater,
      t.photoDelete,
    ]);
    await expect(sheet.locator(".ui-dialog-head").getByRole("button", { name: t.close })).toBeVisible();
    await expectNoAxeViolations(page, "фото: шторка действий");
    await expectHitAreas(page, "фото: шторка действий", CONTROLS);

    await sheet.getByRole("button", { name: t.photoLater }).click();
    await expect(sheet).toHaveCount(0);
    await expect.poll(() => order(page)).toEqual(["1", "3", "2", "4"]);
    expect(api.photoWrites).toHaveLength(1);
    expect(api.photoWrites[0]).toMatch(/^PUT order /);
    // Фокус вернулся на плитку того фото, которое двигали (теперь оно третье)
    await expect(tile(page, 3)).toBeFocused();

    // Третье — обложкой: оно первое по порядку и с меткой «обложка»
    await tile(page, 3).click();
    await expect(page.getByRole("dialog").locator(".ui-dialog-body").getByRole("button")).toHaveText([
      t.photoMakeCover,
      t.photoEarlier,
      t.photoDelete,
    ]);
    await page.getByRole("dialog").getByRole("button", { name: t.photoMakeCover }).click();
    await expect.poll(() => order(page)).toEqual(["2", "1", "3", "4"]);
    await expect(section.locator(".photo-chip").first()).toHaveText(t.photoCover);
    expect(api.photoWrites[1]).toMatch(/^POST cover /);
    expect(api.unexpected).toEqual([]);
  });

  test("обложке и фото на проверке — только «Удалить»; у ждущего решения порядка нет", async ({ page }) => {
    await start(page);
    await page.goto("/card");
    await tile(page, 1).click();
    await expect(page.getByRole("dialog").locator(".ui-dialog-body").getByRole("button")).toHaveText([
      t.photoDelete,
    ]);
    await page.getByRole("button", { name: t.close }).click();
    await tile(page, 4).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByRole("button", { name: t.photoMakeCover })).toHaveCount(0);
    await expect(sheet).toContainText(t.photoOnlyApproved);
    // Удалить из шторки — то же подтверждение, что и у «×»
    await sheet.getByRole("button", { name: t.photoDelete, exact: true }).click();
    await expect(page.getByRole("alertdialog")).toContainText(t.photoDeleteQ);
    await expectNoAxeViolations(page, "фото: подтверждение из шторки");
  });

  test("«×» — маленький рисунок в углу плитки, а нажимается с 44px (невидимый слой)", async ({ page }) => {
    const api = await start(page);
    await page.goto("/card");
    const cross = photosSection(page).getByRole("button", { name: fill(t.photoDeleteLabel, { n: 2 }) });
    await cross.scrollIntoViewIfNeeded();
    const small = await cross.boundingBox();
    expect(small?.width).toBeLessThanOrEqual(28);
    expect(small?.height).toBeLessThanOrEqual(28);
    await expectHitAreas(page, "фото: «×»", ".photo-x");
    await expectHitAreas(page, "фото: плитки", ".photo-tile");
    // Попасть можно и мимо рисунка, в слой вокруг него (после прокрутки — измерить заново)
    await cross.scrollIntoViewIfNeeded();
    const box = await cross.boundingBox();
    const pad = 9;
    await page.mouse.click((box?.x ?? 0) - pad, (box?.y ?? 0) + (box?.height ?? 0) / 2);
    await expect(page.getByRole("alertdialog")).toContainText(t.photoDeleteQ);
    await page.getByRole("button", { name: t.cancel, exact: true }).click();
    // Рисунок «×» — не красная кнопка во всю плитку
    await expect(photosSection(page).locator(".photo-delete")).toHaveCount(0);
    expect(api.unexpected).toEqual([]);
  });

  test("сотрудник площадки: плитки без кнопок — ни порядка, ни обложки, ни «×»", async ({ page }) => {
    const api = await start(page, { role: "member" });
    await page.goto("/card");
    await expect(heading(page)).toHaveText(t.card);
    await expect(photosSection(page).locator(".photos img")).toHaveCount(4);
    await expect(photosSection(page).locator("button")).toHaveCount(0);
    await expect(photosSection(page).locator(".photo-x")).toHaveCount(0);
    await expectNoAxeViolations(page, "фото: сотрудник площадки");
    expect(api.photoWrites).toEqual([]);
    expect(api.unexpected).toEqual([]);
  });
});

test.describe("фото: что на фото — не отмечено заранее", () => {
  test("портфолио: «Что на фото» — две кнопки, ничего не выбрано, без выбора файлы закрыты; «Лиц нет» → X-No-Faces", async ({
    page,
  }) => {
    const api = await start(page, { listings: "many" });
    await page.goto("/card");
    await chooseVitrina(page, "Kadr Studio");
    const section = photosSection(page);
    await expect(section.getByText(t.photoKindLabel)).toBeVisible();
    const noFaces = section.getByRole("radio", { name: t.photoKindNoFaces });
    const consent = section.getByRole("radio", { name: t.photoKindConsent });
    await expect(noFaces).not.toBeChecked();
    await expect(consent).not.toBeChecked();
    await expect(section.locator('input[type="file"]')).toBeDisabled();
    await expect(section.getByRole("checkbox")).toHaveCount(0);
    await expectNoAxeViolations(page, "фото: что на фото");
    await expectHitAreas(page, "фото: что на фото", CONTROLS);
    await noFaces.check();
    await expect(section.locator('input[type="file"]')).toBeEnabled();
    expect(api.uploads).toEqual([]);
  });
});

test.describe("отозвать с проверки", () => {
  test("витрина на проверке: кнопка → подтверждение → черновик; снова можно отправить", async ({ page }) => {
    const api = await start(page, { listings: "many", readyDraft: true });
    await page.goto("/card");
    await chooseVitrina(page, "Kadr Studio");
    const ready = page.locator(".readiness");
    await ready.getByRole("button", { name: t.submitListing }).click();
    await expect(ready).toContainText(t.readyReview);
    const withdraw = ready.getByRole("button", { name: t.withdrawListing });
    await expect(withdraw).toBeVisible();
    await expectNoAxeViolations(page, "витрина: на проверке");
    await expectHitAreas(page, "витрина: на проверке", CONTROLS);

    await withdraw.click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(t.withdrawListingQ);
    await expectNoAxeViolations(page, "витрина: отозвать с проверки");
    await dialog.getByRole("button", { name: t.cancel }).click();
    expect(api.withdraws).toEqual([]);

    await withdraw.click();
    await dialog.getByRole("button", { name: t.withdrawListingGo }).click();
    await expect(dialog).toHaveCount(0);
    expect(api.withdraws).toEqual([PHOTO_ID]);
    // Черновик: статус, чек-лист «готово» и «Отправить на проверку» — снова
    await expect(page.locator(".venue-chips .chip").last()).toHaveText(t.ls_draft);
    await expect(ready.getByRole("button", { name: t.submitListing })).toBeVisible();
    await expect(ready.getByRole("button", { name: t.withdrawListing })).toHaveCount(0);
    expect(api.unexpected).toEqual([]);
  });

  test("у опубликованной витрины и у черновика кнопки нет — отзывают только с проверки", async ({ page }) => {
    await start(page, { listings: "many" });
    await page.goto("/card");
    await expect(page.getByRole("button", { name: t.withdrawListing })).toHaveCount(0);
    await chooseVitrina(page, "Kadr Studio");
    await expect(page.getByRole("button", { name: t.withdrawListing })).toHaveCount(0);
  });
});

test.describe("контакты витрины", () => {
  test("опубликованная: карточка с телефоном и Telegram; «Изменить» → запрос на проверку, «на проверке», отзыв", async ({
    page,
  }) => {
    const api = await start(page);
    await page.goto("/card");
    await expect(heading(page)).toHaveText(t.card);
    const card = page.locator("section.contacts");
    await expect(card.getByRole("heading", { name: t.contactsTitle })).toBeVisible();
    await expect(card).toContainText("+998 00 000 00 01");
    await expect(card).toContainText("@lola_zali");
    // Телефон — один раз на экране: в «Основном» его нет
    await expect(page.locator('[data-group="basics"]')).not.toContainText("+998 00 000 00 01");
    await expectNoAxeViolations(page, "контакты: карточка");
    await expectHitAreas(page, "контакты: карточка", CONTROLS);

    await card.getByRole("button", { name: t.contactsEdit }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByRole("heading", { name: t.contactsSheetTitle })).toBeVisible();
    await expect(sheet).toContainText(t.contactsLiveNote);
    await expect(sheet.getByRole("button", { name: t.contactsSave })).toHaveCount(0);
    await expectNoAxeViolations(page, "контакты: шторка");
    await expectHitAreas(page, "контакты: шторка", CONTROLS);

    const phone = field(sheet, t.contactsPhone);
    await expect(phone).toHaveValue("00 000 00 01");
    await phone.fill("");
    await phone.pressSequentially("912223344");
    await expect(phone).toHaveValue("91 222 33 44");
    // Неполный номер и неверный Telegram — ошибки у полей, запроса нет
    const telegram = sheet.getByLabel(t.contactsTelegramLabel);
    await telegram.fill("ab");
    await telegram.blur();
    await sheet.getByRole("button", { name: t.contactsSend }).click();
    await expect(sheet.locator(".field-error")).toHaveText(t.telegramRule);
    expect(api.contactWrites).toEqual([]);
    await telegram.fill("https://t.me/new_lola");
    await expect(telegram).toHaveValue("new_lola");
    await sheet.getByRole("button", { name: t.contactsSend }).click();
    await expect(sheet).toHaveCount(0);
    expect(api.contactWrites).toEqual([{ phone: "+998912223344", telegram: "new_lola" }]);

    // Клиенты видят прежние контакты: карточка — прежние, рядом — «на проверке» и новые значения
    await expect(card).toContainText("+998 00 000 00 01");
    await expect(card.locator(".contact-pending .chip")).toHaveText(t.contactsOnReview);
    await expect(card.locator(".contact-pending-value")).toHaveText(
      fill(t.contactsPendingValue, { value: "+998 91 222 33 44 · @new_lola" }),
    );
    await expectNoAxeViolations(page, "контакты: на проверке");
    await expectHitAreas(page, "контакты: на проверке", CONTROLS);

    // Отозвать: запрос ушёл
    await card.getByRole("button", { name: t.contactsWithdraw }).click();
    await expect(card.locator(".contact-pending")).toHaveCount(0);
    expect(api.contactWrites.at(-1)).toBe("withdraw");
    await expect(card.getByRole("button", { name: t.contactsEdit })).toBeFocused();
    expect(api.unexpected).toEqual([]);
  });

  test("черновик: «Сохранить» — контакты меняются сразу, без запроса на проверку", async ({ page }) => {
    const api = await start(page, { listings: "many" });
    await page.goto("/card");
    await chooseVitrina(page, "Kadr Studio");
    const card = page.locator("section.contacts");
    await expect(card).toContainText("+998 00 000 00 01");
    await card.getByRole("button", { name: t.contactsEdit }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).not.toContainText(t.contactsLiveNote);
    await expect(sheet.getByRole("button", { name: t.contactsSend })).toHaveCount(0);
    await sheet.getByLabel(t.contactsTelegramLabel).fill("@kadr_studio");
    await expectNoAxeViolations(page, "контакты: черновик");
    await sheet.getByRole("button", { name: t.contactsSave }).click();
    await expect(sheet).toHaveCount(0);
    expect(api.contactWrites).toEqual([{ phone: "+998000000001", telegram: "kadr_studio" }]);
    await expect(card).toContainText("@kadr_studio");
    await expect(card.locator(".contact-pending")).toHaveCount(0);
    // Те же значения ещё раз — «ничего не изменили»
    await card.getByRole("button", { name: t.contactsEdit }).click();
    await page.getByRole("dialog").getByRole("button", { name: t.contactsSave }).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toHaveText(t.err_no_changes);
    expect(api.unexpected).toEqual([]);
  });

  test("сотрудник площадки: контакты только смотрит — ни «Изменить», ни полей", async ({ page }) => {
    const api = await start(page, { role: "member" });
    await page.goto("/card");
    const card = page.locator("section.contacts");
    await expect(card).toContainText("+998 00 000 00 01");
    await expect(card.getByRole("button")).toHaveCount(0);
    await expectNoAxeViolations(page, "контакты: сотрудник площадки");
    expect(api.contactWrites).toEqual([]);
    expect(api.ownerOnly).toEqual([]);
  });

  test("витрина другой категории: у каждой — свои контакты; страница без горизонтальной прокрутки", async ({
    page,
  }) => {
    await start(page, { listings: "many" });
    await page.goto("/card");
    await chooseVitrina(page, "Kortej Premium");
    await expect(page.locator("section.contacts")).toContainText(t.notSet);
    const { doc, width } = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      width: window.innerWidth,
    }));
    expect(doc).toBeLessThanOrEqual(width);
  });
});
