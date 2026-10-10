import type { Locator, Page } from "@playwright/test";
import { t } from "../../apps/admin/src/texts";
import { expectHitAreas, expectNoAxeViolations } from "../support/a11y";
import { pick } from "../support/admin-ui";
import { expect, test } from "../support/offline";
import {
  BENTO_ID,
  BOOKED_DAY,
  BRIDE_CAR_ID,
  CAKE_LISTING_ID,
  CAR_LISTING_ID,
  CAR_REQUEST_ID,
  LIMOUSINE_ID,
  LISTING_ID,
  mockStaffApi,
  NOW,
  PHOTO_LISTING_ID,
  type StaffApiOptions,
  VENDOR_ID,
} from "../support/staff-api";
import { horizontalOverflow } from "../support/web";

/* Категории в панели (v0.2): вендор заводится с категорией первой витрины, витрина в другой
   категории — с его страницы; форма витрины строится по категории (автопарк кортежа, видео и
   портфолио фото, срок заказа тортов вместо календаря), услуги — из каталога категории с
   добавками, их модерация — в очереди «Модерации» (сейчас → предлагают), занятость по частям
   дня с местами, заявки — с частью дня и тем, что нужно клиенту. Подмена API проверяет поля
   теми же функциями @bayramm/shared/categories, что сервер. Телефон и компьютер. */

const CONTROLS = [
  ".btn",
  ".chip",
  "input:not([type=hidden])",
  "textarea",
  ".ui-select",
  ".ui-check",
  ".ui-radio",
  ".cal-day",
].join(", ");

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 720;

/** Кнопка действия над объектом: «Снять с витрины: Лимузин» (объект — скрытой подписью) */
const act = (scope: Locator, action: string, object: string) =>
  scope.getByRole("button", { name: action }).filter({ hasText: object });

async function start(page: Page, options: StaffApiOptions = { seeded: true }) {
  await page.clock.setFixedTime(NOW);
  return mockStaffApi(page, options);
}

const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const save = (page: Page) => page.getByRole("button", { name: t.save, exact: true });

test("новый вендор: без категории не создать; с ней — первая витрина этой категории", async ({ page }) => {
  const api = await start(page, {});
  await page.goto("/vendors/new");
  await page.getByLabel(t.fields.name ?? "", { exact: true }).fill("Navruz");
  await page.getByRole("button", { name: t.createVendor }).click();
  await expect(page.locator(".field-error").first()).toHaveText(t.categoryRequired);
  expect(api.vendorsCreated).toEqual([]);
  await expectNoAxeViolations(page, "новый вендор: ошибка категории");

  await pick(page, t.categoryFirst, "Кортеж");
  await page.getByRole("button", { name: t.createVendor }).click();
  await expect(page).toHaveURL(`/vendors/${VENDOR_ID}`);
  expect(api.vendorsCreated).toEqual([{ name: "Navruz", categoryCode: "car" }]);
  const vitrinas = page.getByRole("region", { name: t.listings });
  await expect(vitrinas.getByRole("link", { name: "Navruz" })).toBeVisible();
  await expect(vitrinas.locator(".cat-chip")).toHaveText("Кортеж");
  expect(api.unexpected).toEqual([]);
});

test("вторая витрина в другой категории: категория — плашкой; у фото — видео и согласие на фото", async ({
  page,
}) => {
  const api = await start(page, {});
  await page.goto(`/vendors/${VENDOR_ID}`);
  await page.getByRole("link", { name: t.addVitrina }).click();
  await pick(page, t.categoryFirst, "Фото и видео");
  await page.getByRole("button", { name: t.createVitrina }).click();
  await expect(page).toHaveURL(`/listings/${LISTING_ID}`);
  expect(api.vitrinas).toEqual([{ categoryCode: "photo" }]);
  await expect(page.locator(".listing-head .cat-chip")).toHaveText("Фото и видео");
  await expect(page.getByRole("heading", { name: t.listingDataSections.videos })).toBeVisible();
  await expect(page.getByRole("heading", { name: t.listingDataSections.occupancy })).toBeVisible();
  // Портфолио: согласие людей на фото или «лиц нет» — ничего не отмечено заранее
  const ack = page.getByRole("radiogroup", { name: t.photoAckLabel });
  await expect(ack.getByRole("radio", { name: t.photoAckConsent })).not.toBeChecked();
  await expect(ack.getByRole("radio", { name: t.photoAckNoFaces })).not.toBeChecked();
  await expect(page.getByText(t.portfolioWarning)).toBeVisible();
  // Категорию сменить можно, пока услуг нет: что будет — в форме, кнопка — цвета отказа
  await page.getByRole("button", { name: t.categoryChange }).click();
  const change = page.locator("form.confirm").filter({ hasText: t.categoryChangeConsequence });
  await expect(change).toBeVisible();
  await expect(change.getByRole("button", { name: t.categoryChange })).toHaveClass(/btn-danger/);
  await change.getByRole("button", { name: t.cancel }).click();
  await expect(change).toHaveCount(0);
  expect(api.unexpected).toEqual([]);
});

test("кортеж: автопарк — ошибка поля до отправки; правка уходит только изменённым", async ({ page }) => {
  const api = await start(page);
  await page.goto(`/listings/${CAR_LISTING_ID}`);
  await expect(heading(page)).toHaveText("Oq kortej");
  await page.getByRole("button", { name: `${t.listAdd}: автопарк` }).click();
  const car = page.getByRole("region", { name: t.listItem("Автопарк", 2) });
  await car.getByLabel("Марка и модель").fill("Lexus LX");
  // Число — с «−» и «+»: буквы в поле не попадают, границы видны заранее
  const seats = car.getByLabel("Мест", { exact: true });
  await seats.fill("семь");
  await expect(seats).toHaveValue("");
  await expect(car.getByText(t.input.range(1, 60))).toBeVisible();
  await seats.fill("70");
  await save(page).click();
  await expect(car.locator(".field-error")).toContainText([t.attributeIntError(1, 60)]);
  expect(api.patches).toEqual([]);

  await seats.fill("7");
  await pick(page, "Класс", "Премиум", car);
  await save(page).click();
  await expect(page.getByText(t.saved, { exact: true })).toBeVisible();
  expect(api.patches).toHaveLength(1);
  expect(api.patches[0]).toEqual({
    version: 1,
    attributes: {
      fleet: [
        { model: "Chevrolet Malibu", class: "sedan", color: "white", seats: 4 },
        { model: "Lexus LX", class: "premium", seats: 7 },
      ],
    },
  });
  // Нажатое «Сохранить» оставило страницу прокрученной: запись автопарка — под нижней панелью
  // телефона. Проверка — с начала страницы, как её открывают
  await page.evaluate(() => window.scrollTo(0, 0));
  await expectNoAxeViolations(page, "кортеж: данные витрины");
  await expectHitAreas(page, "кортеж: данные витрины", CONTROLS);
  expect(api.unexpected).toEqual([]);
});

test("фото и видео: чего не хватает — по полям; ссылка не YouTube — ошибка; правка — поля и видео", async ({
  page,
}) => {
  const api = await start(page);
  await page.goto(`/listings/${PHOTO_LISTING_ID}`);
  const review = page.locator(".notice-warn").filter({ hasText: t.blockersReview });
  await expect(review).toContainText(t.blockers.attributes ?? "");
  await expect(review).toContainText(t.readinessAttributes("Команда, Готовый материал через, дней"));

  await page.getByLabel(t.videoLink(1)).fill("https://example.com/clip");
  await save(page).click();
  await expect(page.getByText(t.videoLinkError)).toBeVisible();
  expect(api.patches).toEqual([]);

  await page.getByLabel(t.videoLink(1)).fill("https://youtu.be/dQw4w9WgXcQ");
  await page.getByRole("group", { name: "Команда" }).getByRole("checkbox", { name: "Фотограф" }).check();
  await page.getByLabel("Готовый материал через, дней", { exact: true }).fill("30");
  await save(page).click();
  await expect(page.getByText(t.saved, { exact: true })).toBeVisible();
  expect(api.patches[0]).toEqual({
    version: 1,
    attributes: { team: ["photographer"], delivery_days: 30 },
    videoLinks: ["https://youtu.be/dQw4w9WgXcQ"],
  });
  // Обязательные поля заполнены — этого пункта больше нет
  await expect(review).not.toContainText(t.blockers.attributes ?? "");
  expect(api.unexpected).toEqual([]);
});

test("торты: календаря нет — срок заказа витрины и услуг", async ({ page }) => {
  const api = await start(page);
  await page.goto(`/listings/${CAKE_LISTING_ID}`);
  const lead = page.getByRole("region", { name: t.leadTitle });
  await expect(lead).toContainText(t.leadDaysValue(3));
  await expect(lead).toContainText("Свадебный торт — 5 дн.");
  await expect(page.locator(".cal")).toHaveCount(0);
  await expectNoAxeViolations(page, "торты");
  expect(api.unexpected).toEqual([]);
});

test("услуги: из каталога с добавкой; правка; снять с витрины; удалить", async ({ page }) => {
  const api = await start(page);
  await page.goto(`/listings/${CAR_LISTING_ID}`);
  const services = page.getByRole("region", { name: /^Услуги/ });
  await services.getByRole("button", { name: t.serviceAdd }).click();
  await pick(page, t.serviceAddFrom, "Ретро-автомобиль", services);
  const form = services.locator("form.service-form");
  await form.getByRole("button", { name: t.serviceCreate }).click();
  await expect(form.locator(".field-error")).toContainText([t.serviceErrors.priceUzs ?? ""]);
  expect(api.services.filter((c) => c.key.startsWith("POST"))).toEqual([]);

  const price = form.getByLabel(t.serviceFields.priceUzs ?? "", { exact: true });
  await price.fill("450000");
  // Разряды — узким неразрывным пробелом, «сум» — у поля
  await expect(price).toHaveValue("450\u202f000");
  // Две единицы — пилюлями, а не списком
  await form.getByRole("radio", { name: "за мероприятие" }).check();
  await pick(page, t.optionFromCatalog, "Остановки для фотосессии", form);
  await form
    .getByRole("region", { name: t.optionN(1) })
    .getByLabel(t.serviceFields.priceUzs ?? "")
    .fill("100000");
  await expectNoAxeViolations(page, "форма услуги");
  await form.getByRole("button", { name: t.serviceCreate }).click();
  await expect(form).toHaveCount(0);
  const created = api.services.find((c) => c.key === `POST /staff/listings/${CAR_LISTING_ID}/services`);
  expect(created?.body).toEqual({
    type: "retro_car",
    priceUzs: 450_000,
    priceUnit: "per_event",
    options: [
      {
        code: "photo_stops",
        name: { ru: "Остановки для фотосессии", uz: "Fotosessiya uchun toʻxtashlar" },
        priceUzs: 100_000,
        priceUnit: "per_event",
      },
    ],
  });
  const retro = services.getByRole("listitem").filter({ hasText: "Ретро-автомобиль" });
  await expect(retro).toContainText(t.serviceStatus.active ?? "");

  // Снять с витрины — через подтверждение: услуга пропадёт у клиентов
  await act(retro, t.servicePause, "Ретро-автомобиль").click();
  const pause = page.getByRole("alertdialog", { name: t.servicePauseTitle });
  await expect(pause).toContainText(t.servicePauseText("Ретро-автомобиль"));
  await pause.getByRole("button", { name: t.servicePause }).click();
  await expect(retro).toContainText(t.serviceStatus.paused ?? "");
  await act(retro, t.serviceDelete, "Ретро-автомобиль").click();
  await page
    .getByRole("alertdialog", { name: t.serviceDeleteTitle })
    .getByRole("button", { name: t.serviceDelete })
    .click();
  await expect(services.getByText("Ретро-автомобиль")).toHaveCount(0);

  // Правка: в форме — предложенная цена (правка ждёт решения), уходит новая
  await act(services, t.serviceEdit, "Машина для молодожёнов").click();
  const edit = services.locator("form.service-form");
  // Цена услуги — первое поле «Цена, сум» формы (дальше — цены добавок)
  const editPrice = edit.getByLabel(t.serviceFields.priceUzs ?? "", { exact: true }).first();
  await expect(editPrice).toHaveValue("350\u202f000");
  await editPrice.fill("380000");
  await edit.getByRole("button", { name: t.serviceSave }).click();
  await expect(edit).toHaveCount(0);
  const patched = api.services.find(
    (c) => c.key === `PATCH /staff/listings/${CAR_LISTING_ID}/services/${BRIDE_CAR_ID}`,
  );
  expect(patched?.body).toMatchObject({ priceUzs: 380_000, priceUnit: "per_hour", minQty: 3 });
  expect(api.services.map((c) => c.key)).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/^POST .*\/services\/[0-9a-f-]+\/pause$/),
      expect.stringMatching(/^DELETE .*\/services\/[0-9a-f-]+$/),
    ]),
  );
  expect(api.unexpected).toEqual([]);
});

test("модерация услуг: правка — сейчас → предлагают; одобрить; новую — отклонить с причиной", async ({
  page,
}) => {
  const api = await start(page);
  await page.goto("/moderation");
  const queue = page.getByRole("region", { name: t.serviceQueue });
  const proposal = queue.getByRole("listitem").filter({ hasText: "Машина для молодожёнов" });
  await expect(proposal).toContainText(t.serviceQueueKinds.proposal ?? "");
  await expect(proposal.locator(".diff-before")).toContainText("300 000 сум");
  await expect(proposal.locator(".diff-after")).toContainText("350 000 сум");
  await expect(proposal.locator(".cat-chip")).toHaveText("Кортеж");
  await expectNoAxeViolations(page, "модерация услуг");
  await expectHitAreas(page, "модерация услуг", CONTROLS);

  await act(proposal, t.serviceApprove, "Машина для молодожёнов").click();
  await expect(proposal).toHaveCount(0);
  expect(api.services.map((c) => c.key)).toContain(`POST /staff/services/${BRIDE_CAR_ID}/approve`);

  const limo = queue.getByRole("listitem").filter({ hasText: "Лимузин" });
  await expect(limo).toContainText(t.serviceQueueKinds.review ?? "");
  // Решили — фокус на следующей услуге очереди: разбор подряд, без поиска глазами и пальцем
  await expect(act(limo, t.serviceApprove, "Лимузин")).toBeFocused();
  // Сводка вверху и число у заголовка очереди — уже без решённой
  await expect(queue.getByRole("heading", { level: 2 })).toHaveText(`${t.serviceQueue} 1`);
  await act(limo, t.serviceDecline, "Лимузин").click();
  const reasonForm = page.locator("form.confirm");
  await reasonForm.getByLabel(t.reason).fill("Нужно фото лимузина");
  await reasonForm.getByRole("button", { name: t.serviceDecline }).click();
  await expect(queue.getByText(t.serviceQueueEmpty)).toBeVisible();
  expect(api.services.find((c) => c.key === `POST /staff/services/${LIMOUSINE_ID}/decline`)?.body).toEqual({
    reason: "Нужно фото лимузина",
  });
  expect(api.unexpected).toEqual([]);
});

test("услуга партнёра у черновика — в очереди со статусом витрины; на её странице — «Одобрить» и «Отклонить»", async ({
  page,
}) => {
  const api = await start(page, { seeded: true, draftService: true });
  await page.goto("/moderation");
  const queue = page.getByRole("region", { name: t.serviceQueue });
  const bento = queue.getByRole("listitem").filter({ hasText: "Shirin" });
  // Партнёр видит «на проверке» и у черновика: модератору видно, что витрины ещё нет на сайте
  await expect(bento).toContainText(t.serviceQueueKinds.review ?? "");
  await expect(bento).toContainText(t.status.draft);
  await expect(queue.getByRole("heading", { level: 2 })).toHaveText(`${t.serviceQueue} 3`);
  await expectNoAxeViolations(page, "модерация: услуга черновика");
  await expectHitAreas(page, "модерация: услуга черновика", CONTROLS);

  // Карточка очереди — ссылкой на витрину: там те же решения
  await bento.getByRole("link").click();
  await expect(page).toHaveURL(`/listings/${CAKE_LISTING_ID}`);
  const services = page.getByRole("region", { name: t.services });
  await expect(services.getByText(t.serviceWaits)).toBeVisible();
  await expect(act(services, t.serviceDecline, "Бенто")).toBeVisible();
  await expectNoAxeViolations(page, "витрина: услуга ждёт решения");
  await expectHitAreas(page, "витрина: услуга ждёт решения", CONTROLS);
  await act(services, t.serviceApprove, "Бенто").click();
  await expect(act(services, t.serviceApprove, "Бенто")).toHaveCount(0);
  expect(api.services.map((c) => c.key)).toContain(`POST /staff/services/${BENTO_ID}/approve`);
  // Решили — фокус на заголовке блока услуг: кнопки решения исчезли
  await expect(services.getByRole("heading", { level: 2 })).toBeFocused();
  expect(api.unexpected).toEqual([]);
});

test("части дня: вечер — одна машина из двух; отметить утро и весь день — с версией календаря", async ({
  page,
}) => {
  const api = await start(page);
  await page.goto(`/listings/${CAR_LISTING_ID}`);
  await expect(page.getByText(t.capacityNow(2))).toBeVisible();
  const day = page.locator(".cal-day").filter({ hasText: /^10$/ });
  await day.click();
  const parts = page.getByRole("region", { name: t.pickedDay("10 октября") });
  await expect(parts.locator(".day-part-row").filter({ hasText: "Вечер" })).toContainText(
    t.partBookings(1, 2),
  );
  await expectNoAxeViolations(page, "части дня");
  await expectHitAreas(page, "части дня", CONTROLS);

  await act(parts, t.markBusy, "Утро").click();
  await expect(day).toHaveClass(/cal-partial/);
  await act(parts, t.markBusy, t.wholeDay).click();
  await expect(day).toHaveClass(/cal-busy/);
  expect(api.calendar).toEqual([
    { version: 0, busyParts: [{ day: BOOKED_DAY, part: "morning" }] },
    { version: 1, busy: [BOOKED_DAY] },
  ]);
  expect(api.unexpected).toEqual([]);
});

test("заявки: фильтр по категории; заявка кортежа — часть дня, поля и выбранные услуги", async ({ page }) => {
  const api = await start(page);
  await page.goto("/requests");
  if (isPhone(page)) {
    await page.getByRole("button", { name: t.filters }).click();
    const sheet = page.getByRole("dialog", { name: t.filters });
    await sheet
      .getByRole("radiogroup", { name: t.colCategory })
      .getByRole("radio", { name: "Кортеж" })
      .check();
    await sheet.getByRole("button", { name: t.done }).click();
  } else {
    await pick(page, t.colCategory, "Кортеж");
  }
  await expect(page.getByRole("link", { name: t.requestNo(1051) })).toHaveCount(0);
  expect(api.queries.at(-1)).toContain("category=car");
  await page.getByRole("link", { name: t.requestNo(1052) }).click();
  await expect(page).toHaveURL(`/requests/${CAR_REQUEST_ID}`);
  await expect(page.getByText("Вечер · 17:00–24:00")).toBeVisible();
  const details = page.getByRole("region", { name: t.requestDetails });
  await expect(details).toContainText("Сколько машин");
  await expect(details).toContainText("Премиум");
  await expect(details).toContainText("Машина для молодожёнов × 4");
  await expect(details).toContainText("+ Шампанское и вода — 50 000 сум за штуку");
  await expectNoAxeViolations(page, "заявка кортежа");
  expect(api.unexpected).toEqual([]);
});

test("роли: модератор услуги только смотрит; менеджер очереди услуг не видит", async ({ page }) => {
  await start(page, { seeded: true, role: "moderator" });
  await page.goto(`/listings/${CAR_LISTING_ID}`);
  await expect(heading(page)).toHaveText("Oq kortej");
  await expect(page.getByRole("button", { name: t.serviceAdd })).toHaveCount(0);
  await expect(page.getByRole("button", { name: t.serviceEdit })).toHaveCount(0);
  await expect(page.getByRole("button", { name: t.categoryChange })).toHaveCount(0);

  await page.unrouteAll({ behavior: "ignoreErrors" });
  await start(page, { seeded: true, role: "manager" });
  await page.goto("/moderation");
  await expect(heading(page)).toHaveText(t.moderation);
  await expect(page.getByRole("region", { name: t.serviceQueue })).toHaveCount(0);
});

const SCREENS = [
  { name: "витрина: кортеж", path: `/listings/${CAR_LISTING_ID}` },
  { name: "витрина: фото и видео", path: `/listings/${PHOTO_LISTING_ID}` },
  { name: "витрина: торты", path: `/listings/${CAKE_LISTING_ID}` },
  { name: "новая витрина", path: `/vendors/${VENDOR_ID}/listings/new` },
  { name: "заявка кортежа", path: `/requests/${CAR_REQUEST_ID}` },
] as const;

for (const screen of SCREENS) {
  test(`${screen.name}: axe, 44px, без прокрутки вбок`, async ({ page }) => {
    const api = await start(page);
    await page.goto(screen.path);
    await expect(heading(page)).toBeVisible();
    await expect(page.getByRole("status")).toHaveCount(0);
    const width = page.viewportSize()?.width ?? 0;
    const overflow = await horizontalOverflow(page);
    expect(overflow.scrollWidth, screen.name).toBeLessThanOrEqual(width);
    await expectNoAxeViolations(page, screen.name);
    await expectHitAreas(page, screen.name, CONTROLS);
    expect(api.unexpected).toEqual([]);
  });
}
