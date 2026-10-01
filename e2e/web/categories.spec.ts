import type { Locator, Page } from "@playwright/test";
import { addDays, formatDayMonth } from "../../apps/web/src/format";
import { expectHitAreas, expectNoAxeViolations } from "../support/a11y";
import { expect, test } from "../support/offline";
import { clickMainButton, fakeTelegram, telegramState } from "../support/telegram";
import {
  BUSY_DAY,
  horizontalOverflow,
  isDesktop,
  open,
  PATHS,
  prepare,
  T,
  TODAY,
  vitrina,
} from "../support/web";

/* Категории на живом клиенте: лендинг → каталог категории с её фильтрами (колонка на
   компьютере, шторка на телефоне), заявки кортежа (части дня, услуги и опции), фото и видео,
   торта (срок заказа) и студии — от формы до «Моих заявок»; Telegram; доступность. */

const ru = T.ru;
const CAR = vitrina("oq-kortej");
const PHOTO = vitrina("kadr-media");
const CAKE = vitrina("shirin-cake");
const STUDIO = vitrina("oydin-studio");

/** Свои контролы категорий: чипы, плитки, «в заявку», фильтры, галочки */
const CONTROLS = [
  ".btn",
  ".cat-chip",
  ".cat-tile",
  ".svc-pick",
  ".filters-open",
  "label.ui-check",
  "label.ui-radio",
  ".ui-select",
  ".ui-number-input",
  ".video-link",
  ".contact-phone",
  ".fav-btn",
].join(", ");

async function expectNoOverflow(page: Page, what: string) {
  const width = page.viewportSize()?.width ?? 0;
  const overflow = await horizontalOverflow(page);
  expect(overflow.scrollWidth, `${what}: ширина документа`).toBeLessThanOrEqual(width);
  expect(overflow.bodyWidth, `${what}: ширина body`).toBeLessThanOrEqual(width);
}

/** Галочка набора по подписи (подпись — вся строка, нажимаем её) */
const check = (root: Page | Locator, label: string | RegExp) =>
  root.locator("label.ui-check").filter({ hasText: label }).first();

/** Поле формы по подписи (метка .fld-label, «обязательно / по желанию» — рядом) */
const fieldOf = (page: Page, label: string) =>
  page
    .locator("form.request .fld")
    .filter({ has: page.locator(".fld-label", { hasText: label }) })
    .first();

/** Выбрать день в поле даты формы заявки (календарь — шторка или панель в портале body) */
async function pickDay(page: Page, date: string) {
  await fieldOf(page, ru.rqDate).locator("button[aria-haspopup=dialog]").click();
  // День — по имени для диктора: «20 окт, свободно» (первым — число и месяц)
  await page.locator(`.ui-layer button.ui-cal-day[aria-label^="${formatDayMonth(date, ru)},"]`).click();
}

/** Выбрать вариант выпадающего списка поля формы */
async function chooseIn(page: Page, label: string, option: string) {
  await fieldOf(page, label).locator("button[aria-haspopup=listbox]").click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

/** Имя, телефон, согласие на передачу — и отправить */
async function finishAndSend(page: Page) {
  await page.locator('form.request input[autocomplete="name"]').fill("Азиза");
  await page.locator('form.request input[type="tel"]').fill("90 123 45 67");
  await check(page.locator(".consents"), /Разрешаю передать/).click();
  await page.getByRole("button", { name: ru.rqSend }).click();
}

test.describe("лендинг → каталог категории", () => {
  test("плитка категории — её каталог; фильтры по полям витрины: колонка или шторка", async ({ page }) => {
    await prepare(page);
    await open(page, PATHS.home, ".cat-grid", { guest: true });
    await expect(page.locator(".cat-tile")).toHaveCount(8);
    // Чисел витрин нет; «скоро» — только у пустых (в демо пустых нет)
    await expect(page.locator(".cat-soon")).toHaveCount(0);
    await page.locator(".cat-tile").filter({ hasText: "Кортеж" }).click();
    await expect(page).toHaveURL((url) => url.pathname === PATHS.catalog && url.search === "?category=car");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(ru.catTitle(ru.catName.car));
    await expect(page.locator(".cat-switch a[aria-current=page]")).toHaveText(ru.catName.car);
    await expect(page.locator(".cards .card")).toHaveCount(3);
    await expectNoAxeViolations(page, "каталог кортежа");
    await expectHitAreas(page, "каталог кортежа", CONTROLS);
    await expectNoOverflow(page, "каталог кортежа");

    if (isDesktop(page)) {
      // Компьютер: колонка фильтров слева, кнопки шторки нет
      await expect(page.locator(".filters-side")).toBeVisible();
      await expect(page.locator(".filters-open")).toBeHidden();
      await check(page.locator(".filters-side"), "Премиум").click();
    } else {
      // Телефон: шторка снизу с теми же полями
      await expect(page.locator(".filters-side")).toBeHidden();
      await page.locator(".filters-open").click();
      const sheet = page.getByRole("dialog", { name: ru.moreFilters });
      await expect(sheet).toBeVisible();
      await expectNoAxeViolations(page, "шторка фильтров");
      await check(sheet, "Премиум").click();
      await sheet.getByRole("button", { name: ru.filtersApply }).click();
      await expect(sheet).toBeHidden();
      await expect(page.locator(".filters-open")).toHaveText(ru.moreFiltersN(1));
    }
    await expect(page).toHaveURL((url) => url.searchParams.get("a.fleet.class") === "premium");
    await expect(page.locator(".cards .card")).toHaveCount(1);
    await expect(page.locator(".cards .card-name")).toHaveText(CAR.name);
    // Фильтры — в адресе: перезагрузка показывает ту же выдачу
    await page.reload();
    await expect(page.locator(".cards .card")).toHaveCount(1);
  });

  test("дата: у частей дня — «частично занято»; переключатель категорий её сохраняет", async ({ page }) => {
    await prepare(page);
    await open(page, `${PATHS.catalog}?category=photo&date=${BUSY_DAY}`, ".card .chip");
    await expect(page.locator(".cards .chip")).toHaveText([
      ru.dayPartial(ru.dayMonth(8, "окт")),
      ru.dayPartial(ru.dayMonth(8, "окт")),
      ru.dayBusy(ru.dayMonth(8, "окт")),
    ]);
    await page.locator(".cat-switch a").filter({ hasText: "Декор" }).click();
    await expect(page).toHaveURL((url) => url.searchParams.get("category") === "decor");
    expect(new URL(page.url()).searchParams.get("date")).toBe(BUSY_DAY);
    await expect(page.locator(".cards .card")).toHaveCount(3);
    await expectNoOverflow(page, "каталог декора");
  });
});

test.describe("заявка по категории", () => {
  test("кортеж: услуга с витрины, часть дня занята — понятно; другое время, опция, примерная сумма", async ({
    page,
  }) => {
    await prepare(page);
    await open(page, PATHS.venue(CAR.slug), ".venue-head h1");
    await expectNoAxeViolations(page, "витрина кортежа");
    await expectHitAreas(page, "витрина кортежа", CONTROLS);
    await expectNoOverflow(page, "витрина кортежа");
    const pick = page.locator(".svc-pick").first();
    await pick.click();
    await expect(pick).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".bar-chosen")).toHaveText(ru.svcChosenN(1));
    await page.locator(".venue-bar").getByRole("link", { name: ru.pfReq }).click();
    await expect(page.getByRole("heading", { level: 1, name: ru.rqTitle })).toBeVisible();

    // Гостей у кортежа не спрашивают
    await expect(page.locator("form.request .fld-label", { hasText: ru.rqG })).toHaveCount(0);
    await page.locator("form.request label.ui-radio").first().click();
    await pickDay(page, BUSY_DAY);
    await expect(fieldOf(page, ru.rqDate)).toContainText(ru.partsTaken("вечер"));
    await chooseIn(page, "Начало", "17:30");
    await fieldOf(page, "Сколько часов").getByRole("spinbutton").fill("5");
    await fieldOf(page, "Сколько машин").getByRole("spinbutton").fill("2");
    // Услуга уже отмечена с витрины; количество — минимальное у вендора
    const chosen = page.locator(".svc-choice.on");
    await expect(chosen).toHaveCount(1);
    await expect(chosen.locator(".svc-qty input")).toHaveValue("3");
    await check(chosen, /Шампанское и вода/).click();
    await expect(page.locator(".estimate-sum b")).toHaveText(/≈\s1,2\sмлн\sсум/);
    await expect(page.locator(".estimate")).toContainText(ru.estimateNote);
    await finishAndSend(page);
    // Вечер у вендора занят: ошибка у времени, заявка не ушла
    await expect(fieldOf(page, "Начало").locator(".fld-error")).toHaveText(ru.errPartBusy("вечер"));
    await chooseIn(page, "Начало", "09:00");
    await expect(fieldOf(page, "Начало")).toContainText(ru.dayPartHint("утро", "05:00–11:00"));
    await page.getByRole("button", { name: ru.rqSend }).click();
    await expect(page.getByRole("heading", { level: 1, name: ru.sentH })).toBeVisible();

    // «Мои заявки» (переходом внутри приложения: демо-API живёт в памяти вкладки) — новая
    // заявка сверху: категория, часть дня и детали
    await page.getByRole("link", { name: ru.toMyRequests }).click();
    await page.locator(".reqs").waitFor();
    const request = page.locator(".req").first();
    await expect(request).toContainText(CAR.name);
    await expect(request.locator(".req-main .muted")).toContainText("Кортеж");
    await expect(request.locator(".req-main .muted")).toContainText("утро");
    await expect(request.locator(".req-details li")).toHaveText([
      "Начало: 09:00",
      "Сколько часов: 5",
      "Сколько машин: 2",
      "Какие услуги нужны: Машина для молодожёнов × 3 (+Шампанское и вода)",
    ]);
  });

  test("фото и видео: что снимать, услуга с количеством и опциями — сумма; видео — ссылками", async ({
    page,
  }) => {
    await prepare(page);
    await open(page, PATHS.venue(PHOTO.slug), ".venue-head h1");
    const videos = page.locator(".videos a");
    await expect(videos).toHaveCount(2);
    for (const link of await videos.all()) {
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(link).toHaveAttribute("rel", /noopener/);
    }
    await expect(page.locator("iframe")).toHaveCount(0);

    await open(page, PATHS.request(PHOTO.slug), "form.request .consents");
    await page.locator("form.request label.ui-radio").first().click();
    await pickDay(page, addDays(TODAY, 19));
    await chooseIn(page, "Начало", "10:00");
    await check(fieldOf(page, "Что снимать"), "Фото").click();
    await check(fieldOf(page, "Что снимать"), "Видео").click();
    const shoot = page.locator(".svc-choice").filter({ hasText: "Фотосъёмка в день свадьбы" });
    await check(shoot, /Фотосъёмка в день свадьбы/).click();
    await shoot.locator(".svc-qty input").fill("6");
    await check(shoot, /Второй фотограф/).click();
    // 6 ч × 500 000 + второй фотограф 1 500 000
    await expect(page.locator(".estimate-sum b")).toHaveText(/≈\s4,5\sмлн\sсум/);
    await expectNoAxeViolations(page, "форма заявки фото");
    await expectHitAreas(page, "форма заявки фото", CONTROLS);
    await expectNoOverflow(page, "форма заявки фото");
    await finishAndSend(page);
    await expect(page.getByRole("heading", { level: 1, name: ru.sentH })).toBeVisible();
  });

  test("торт: дата раньше срока заказа недоступна; доставка — с районом", async ({ page }) => {
    await prepare(page);
    await open(page, PATHS.venue(CAKE.slug), ".venue-head h1");
    await expect(page.locator(".lead-note")).toHaveText(ru.leadNote(5));
    await expect(page.locator(".venue .ui-cal")).toHaveCount(0);

    // Дата из каталога раньше срока (5 дней) в форму не переходит
    await open(page, `${PATHS.request(CAKE.slug)}?date=${addDays(TODAY, 2)}`, "form.request .consents");
    const date = fieldOf(page, ru.rqDate);
    await expect(date).toContainText(ru.pickAny);
    // Срок — с ближайшей датой, на которую можно заказать
    await expect(date).toContainText(ru.leadNoteFrom(5, formatDayMonth(addDays(TODAY, 5), ru)));
    await date.locator("button[aria-haspopup=dialog]").click();
    await expect(
      page.locator(`.ui-layer button.ui-cal-day[aria-label^="${ru.dayMonth(4, "окт")}"]`),
    ).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");
    await pickDay(page, addDays(TODAY, 9));
    await page.locator("form.request label.ui-radio").first().click();
    await fieldOf(page, "Как получить").locator("label.ui-radio", { hasText: "Доставка" }).click();
    await chooseIn(page, "Район доставки", "Чиланзар");
    const cake = page.locator(".svc-choice").filter({ hasText: "Свадебный торт" });
    await check(cake, /Свадебный торт/).click();
    await cake.locator(".svc-qty input").fill("4");
    await finishAndSend(page);
    await expect(page.getByRole("heading", { level: 1, name: ru.sentH })).toBeVisible();
    await page.getByRole("link", { name: ru.toMyRequests }).click();
    await page.locator(".reqs").waitFor();
    const request = page.locator(".req").first();
    await expect(request).toContainText(CAKE.name);
    await expect(request.locator(".req-details")).toContainText("Как получить: Доставка");
    await expect(request.locator(".req-details")).toContainText("Район доставки: Чиланзар");
  });

  test("студия: время, часы и сколько человек — обязательны; гостей не спрашивают", async ({ page }) => {
    await prepare(page);
    await open(page, PATHS.request(STUDIO.slug), "form.request .consents");
    await page.locator("form.request label.ui-radio").first().click();
    await pickDay(page, addDays(TODAY, 19));
    await finishAndSend(page);
    await expect(page.locator(".form-error").first()).toBeVisible();
    await expect(fieldOf(page, "Начало").locator(".fld-error")).toHaveText(ru.errTime);
    await chooseIn(page, "Начало", "15:00");
    await fieldOf(page, "Сколько часов").getByRole("spinbutton").fill("2");
    await fieldOf(page, "Сколько человек").getByRole("spinbutton").fill("4");
    await page.getByRole("button", { name: ru.rqSend }).click();
    await expect(page.getByRole("heading", { level: 1, name: ru.sentH })).toBeVisible();
  });
});

test.describe("категории в Telegram", () => {
  test("кнопка бота «похожие» (/?category=…&date=…) — каталог этой категории; заявка — главной кнопкой", async ({
    page,
  }) => {
    await prepare(page);
    await fakeTelegram(page);
    await open(page, `/?category=car&date=${BUSY_DAY}`, ".card .chip");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(ru.catTitle(ru.catName.car));
    await expect(page.locator(".landing, .site-footer")).toHaveCount(0);
    await page.locator(".cards .card-link").first().click();
    await expect(page.locator(".venue-head h1")).toHaveText(CAR.name);
    await expect(page.locator(`a.contact-phone[href="tel:${CAR.phone}"]:visible`)).toHaveCount(1);
    await expect
      .poll(async () => (await telegramState(page)).main)
      .toEqual({ text: ru.pfReq, visible: true });
    await clickMainButton(page);
    await expect(page).toHaveURL((url) => url.pathname === PATHS.request(CAR.slug));
    // Дата из каталога — в форме
    await expect(fieldOf(page, ru.rqDate)).toContainText(ru.dayMonth(8, "окт"));
  });
});
