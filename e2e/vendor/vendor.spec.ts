import type { VendorRole } from "@bayramm/shared/api/vendor";
import type { Page } from "@playwright/test";
import { fill, vendorDict } from "../../apps/vendor/src/i18n";
import { expectHitAreas, expectNoAxeViolations, expectVisibleFocus } from "../support/a11y";
import { expect, test } from "../support/offline";
import { clickBackButton, fakeTelegram } from "../support/telegram";
import {
  CAKE_ID,
  CAR_ID,
  mockVendorApi,
  NOW,
  PHOTO_ID,
  REQUEST_CAR,
  REQUEST_LATE,
  REQUEST_NEW,
  SERVICE_CAR,
  type SignIn,
} from "../support/vendor-api";

/* Кабинет партнёра: экраны до входа (вне Telegram и отказы API), входящие, карточка
   заявки, календарь, витрина, услуги, аккаунт — на перехваченном /api. Роли: владелец
   кабинета меняет витрину (фото, предложения, услуги), сотрудник площадки — только заявки и
   календарь. Витрины в разных категориях (listings: "many") — в конце: выбор витрины,
   входящие по витрине, витрина не на сайте и её чек-лист готовности, поля заявки, услуги,
   данные витрины и видео, фото с согласием людей, части дня и срок заказа вместо календаря.

   Два проекта: vendor-phone (Mini App на телефоне, нижняя панель) и vendor-desktop (сайт,
   1280px: боковая панель, заявки списком и карточкой рядом). Проверки раскладки —
   по проекту (isDesktop); остальное одно на оба. */

const t = vendorDict.ru;
const BOT = "https://t.me/bayramm_demo_bot?start=partner";
const CONTROLS = [
  ".btn",
  ".pill",
  ".tab",
  ".side-link",
  ".rail-link",
  ".lang button",
  ".cal-day",
  ".icon-btn",
  ".back-link",
  ".rq",
  "label.ui-radio",
  "label.ui-check",
  ".ui-drop-face",
  ".side-vitrina",
  ".ui-select",
  ".ui-icon-btn",
].join(", ");

async function start(
  page: Page,
  {
    telegram = true,
    signIn = "ok" as SignIn,
    role = "owner" as VendorRole,
    listings = "one" as "one" | "many",
  } = {},
) {
  await page.clock.setFixedTime(NOW);
  const api = await mockVendorApi(page, { signIn, role, listings });
  if (telegram) await fakeTelegram(page);
  return api;
}

/** Настоящий PNG из канваса страницы: сжатие в браузере перекодирует его, как фото с телефона */
async function pngFromCanvas(page: Page, width: number, height: number): Promise<Buffer> {
  const bytes = await page.evaluate(
    async ([w, h]) => {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const context = canvas.getContext("2d");
      if (context) {
        context.fillStyle = "rgb(214, 180, 140)";
        context.fillRect(0, 0, w, h);
        context.fillStyle = "rgb(120, 60, 90)";
        context.fillRect(w / 4, h / 4, w / 2, h / 2);
      }
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      return blob ? [...new Uint8Array(await blob.arrayBuffer())] : [];
    },
    [width, height] as const,
  );
  return Buffer.from(bytes);
}

const heading = (page: Page) => page.getByRole("heading", { level: 1 });
/** Заголовок карточки заявки: h1 на телефоне, h2 рядом со списком на компьютере */
const requestTitle = (page: Page) => page.locator(".request .page-title");
const isDesktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;
/** Разделы кабинета: нижняя панель телефона или боковая панель компьютера */
const sections = (page: Page) => page.getByRole("navigation", { name: t.sections });

/** Ширина документа и body — не больше окна: прокрутки вбок нет */
async function expectNoOverflow(page: Page, screen: string) {
  const { doc, body, width } = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    width: window.innerWidth,
  }));
  expect.soft(doc, `${screen}: документ шире окна`).toBeLessThanOrEqual(width);
  expect.soft(body, `${screen}: body шире окна`).toBeLessThanOrEqual(width);
}
const dayButton = (page: Page, day: number) =>
  page.locator("button.cal-day").filter({ has: page.getByText(String(day), { exact: true }) });

test.describe("до входа", () => {
  test("вне Telegram: что это за кабинет, как получить доступ, вход через сайт и бот", async ({ page }) => {
    const api = await start(page, { telegram: false });
    await page.goto("/");
    await expect(heading(page)).toHaveText(t.welcomeTitle);
    for (const point of [t.welcomeRequests, t.welcome12h, t.welcomeCalendar, t.welcomeCard])
      await expect(page.getByText(point, { exact: true })).toBeVisible();
    await expect(page.getByText(t.welcomeAccessText)).toBeVisible();
    await expect(page.getByRole("button", { name: t.signIn, exact: true })).toBeVisible();
    const bot = page.getByRole("link", { name: t.openBot });
    await expect(bot).toHaveAttribute("href", BOT);
    // Чисел о площадке и партнёрах нет — только обещание 12 часов
    const text = await page.locator(".welcome").innerText();
    expect(text.match(/\d+/g)).toEqual(["12", "12"]);
    // Кабинета без входа нет: ни разделов, ни заявок
    await expect(sections(page)).toHaveCount(0);
    // На телефоне «Войти» — на первом экране, без прокрутки
    await expect(page.getByRole("button", { name: t.signIn, exact: true })).toBeInViewport();
    await expectNoAxeViolations(page, "вне Telegram");
    await expectHitAreas(page, "вне Telegram", CONTROLS);
    await expectNoOverflow(page, "вне Telegram");
    expect(api.unexpected).toEqual([]);
  });

  test("сессия в браузере кончилась: «войдите снова», а не «откройте из бота»", async ({ page }) => {
    await start(page, { telegram: false });
    await page.addInitScript(() => window.sessionStorage.setItem("bayramm.vendor.session", "expired-token"));
    await page.goto("/requests");
    await expect(heading(page)).toHaveText(t.gateExpiredTitle);
    await expect(page.getByText(t.gateExpiredTextWeb)).toBeVisible();
    await expect(page.getByRole("button", { name: t.signIn, exact: true })).toBeVisible();
  });

  const GATES: readonly [SignIn, string, boolean][] = [
    ["not_linked", t.gateNotLinkedTitle, true],
    ["disabled", t.gateDisabledTitle, false],
    ["expired", t.gateExpiredTitle, true],
    ["error", t.gateErrorTitle, false],
  ];
  for (const [signIn, title, bot] of GATES) {
    test(`вход ответил ${signIn}: понятный экран`, async ({ page }) => {
      await start(page, { signIn });
      await page.goto("/");
      await expect(heading(page)).toHaveText(title);
      await expect(page.getByRole("link", { name: t.openBot })).toHaveCount(bot ? 1 : 0);
      if (signIn === "error") await expect(page.getByRole("button", { name: t.retry })).toBeVisible();
      await expect(sections(page)).toHaveCount(0);
      await expectNoAxeViolations(page, `вход: ${signIn}`);
    });
  }
});

test.describe("кабинет", () => {
  test("входящие → карточка заявки: телефон клиента, «Я связался», назад кнопкой Telegram", async ({
    page,
  }) => {
    const api = await start(page);
    await page.goto("/");
    await expect(heading(page)).toHaveText(t.requests);
    await expect(page).toHaveURL("/requests");

    const tabs = page.locator(".pills .pill");
    await expect(tabs.nth(0)).toContainText(`${t.tabNew}1`);
    const cards = page.locator(".rq-list .rq");
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText("Азиза");
    // Телефона клиента в списке нет — только в карточке
    await expect(page.locator(".rq-list a[href^='tel:']")).toHaveCount(0);
    await expectNoAxeViolations(page, "входящие");
    await expectHitAreas(page, "входящие", CONTROLS);

    await cards.first().click();
    await expect(page).toHaveURL(`/requests/${REQUEST_NEW}`);
    await expect(requestTitle(page)).toContainText("1051");
    const phone = page.locator("a.btn-phone");
    await expect(phone).toHaveAttribute("href", "tel:+998001234567");
    await expect(page.getByText("Нужен детский стол")).toBeVisible();
    await expectNoAxeViolations(page, "карточка заявки");
    await expectHitAreas(page, "карточка заявки", CONTROLS);

    await page.getByRole("button", { name: t.actContacted }).click();
    await expect(page.locator(".detail-top .chip")).toHaveText(t.st_contacted);
    expect(api.patches).toEqual([{ id: REQUEST_NEW, body: { status: "contacted" } }]);

    // Отказ: форма с причинами, «Отмена» возвращает действия
    await page.getByRole("button", { name: t.actNoDeal }).click();
    await expect(page.locator("form.decline")).toBeVisible();
    await expectNoAxeViolations(page, "отказ");
    await expectHitAreas(page, "отказ", CONTROLS);
    await page.locator("form.decline").getByRole("button", { name: t.cancel }).click();

    await clickBackButton(page);
    await expect(page).toHaveURL("/requests");
    await page.locator(".pills .pill").nth(1).click();
    await expect(page.locator(".rq-list .rq")).toHaveCount(2);
    expect(api.unexpected).toEqual([]);
  });

  test("компьютер: список и карточка заявки рядом; заявка сама не открывается", async ({ page }) => {
    test.skip(!isDesktop(page), "раскладка компьютера");
    const api = await start(page);
    await page.goto("/requests");
    await expect(heading(page)).toHaveText(t.requests);
    // Разделы — в боковой панели, нижней нет
    await expect(page.locator("aside.side").getByRole("navigation", { name: t.sections })).toBeVisible();
    await expect(page.locator(".tabbar")).toHaveCount(0);
    // Без выбора — подсказка: открытие сделало бы новую заявку просмотренной
    await expect(page.getByText(t.pickRequest)).toBeVisible();
    expect(api.patches).toEqual([]);
    await expectNoAxeViolations(page, "компьютер: заявки");
    await expectHitAreas(page, "компьютер: заявки", CONTROLS);

    await page.locator(".rq-list .rq").first().click();
    await expect(page).toHaveURL(`/requests/${REQUEST_NEW}`);
    // Список на месте, открытая заявка отмечена; карточка — рядом, h2 под h1 «Заявки»
    await expect(heading(page)).toHaveText(t.requests);
    await expect(page.getByRole("heading", { level: 2, name: fill(t.requestNo, { n: 1051 }) })).toBeFocused();
    await expect(page.locator("a.btn-phone")).toBeVisible();
    await expect(page.getByRole("link", { name: t.back })).toHaveCount(0);
    // Открытая стала просмотренной и ушла во «В работе»: список перечитан, вкладка — та же
    await expect(page.locator(".pills .pill").nth(0)).toContainText(`${t.tabNew}0`);
    await expect(page.locator(".pills .pill").nth(1)).toContainText(`${t.tabActive}2`);
    await expectNoAxeViolations(page, "компьютер: заявка рядом со списком");
    await expectNoOverflow(page, "компьютер: заявка рядом со списком");

    await page.getByRole("button", { name: t.actContacted }).click();
    await expect(page.locator(".detail-top .chip")).toHaveText(t.st_contacted);
    await page.locator(".pills .pill").nth(1).click();
    await expect(page.locator(".rq-list .rq[aria-current='page']")).toContainText(t.st_contacted);
    expect(api.unexpected).toEqual([]);
  });

  test("просроченная заявка помечена в списке и в карточке", async ({ page }) => {
    await start(page);
    await page.goto(`/requests/${REQUEST_LATE}`);
    await expect(requestTitle(page)).toContainText("1047");
    await expect(page.locator(".detail-top .chip")).toHaveText(t.late);
    await expect(page.locator(".request .sla-late")).toBeVisible();
  });

  test("календарь: день занимается и освобождается одним нажатием; закрытый менеджером — нет", async ({
    page,
  }) => {
    const api = await start(page);
    await page.goto("/calendar");
    await expect(heading(page)).toHaveText(t.calendar);
    await expect(dayButton(page, 10)).toHaveAttribute("aria-pressed", "true");
    await expectNoAxeViolations(page, "календарь");
    await expectHitAreas(page, "календарь", CONTROLS);

    await dayButton(page, 20).click();
    await expect(dayButton(page, 20)).toHaveAttribute("aria-pressed", "true");
    // Отметка на экране — сразу, запрос — следом: состояние API ждём, а не читаем разом
    await expect.poll(() => api.busy.get("2026-10-20")?.source).toBe("vendor");

    await dayButton(page, 10).click();
    await expect(dayButton(page, 10)).toHaveAttribute("aria-pressed", "false");
    await expect.poll(() => api.busy.has("2026-10-10")).toBe(false);

    // aria-disabled, но нажимается: объясняет, почему день не освободить (Playwright такое сам не жмёт)
    await dayButton(page, 17).click({ force: true });
    await expect(page.getByRole("alert")).toHaveText(t.staffLocked);
    await expect(dayButton(page, 17)).toHaveAttribute("aria-pressed", "true");
    expect(api.busy.get("2026-10-17")?.source).toBe("staff");
    // Каждая правка — от версии календаря из прошлого ответа (If-Match)
    await expect
      .poll(() => api.calendarWrites)
      .toEqual(["PUT 2026-10-20 If-Match: 1", "DELETE 2026-10-10 If-Match: 2"]);
    expect(api.unexpected).toEqual([]);
  });

  test("календарь изменил кто-то другой: правка не затирает чужую, месяц перечитан, отметить заново", async ({
    page,
  }) => {
    const api = await start(page);
    await page.goto("/calendar");
    await expect(dayButton(page, 20)).toHaveAttribute("aria-pressed", "false");
    // Пока календарь открыт, отказ «занято» по другой заявке занял 25-е
    api.busy.set("2026-10-25", { day: "2026-10-25", source: "request_decline", requestId: REQUEST_LATE });
    api.calendar.version += 1;

    await dayButton(page, 20).click();
    await expect(page.getByRole("alert")).toHaveText(t.calendarConflict);
    await expect(dayButton(page, 25)).toHaveAttribute("aria-pressed", "true");
    await expect(dayButton(page, 20)).toHaveAttribute("aria-pressed", "false");
    expect(api.busy.has("2026-10-20")).toBe(false);
    await expectNoAxeViolations(page, "календарь: изменили");

    await dayButton(page, 20).click();
    await expect(dayButton(page, 20)).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect.poll(() => api.busy.get("2026-10-20")?.source).toBe("vendor");
    expect(api.calendarWrites).toEqual(["PUT 2026-10-20 If-Match: 1", "PUT 2026-10-20 If-Match: 2"]);
    expect(api.unexpected).toEqual([]);
  });

  test("площадка: карточка как в базе, без рейтинга", async ({ page }) => {
    const api = await start(page);
    await page.goto("/card");
    await expect(heading(page)).toHaveText(t.card);
    await expect(page.getByText("Lola zali").first()).toBeVisible();
    const text = await page.locator("main").innerText();
    expect(text).not.toMatch(/★|рейтинг|reyting|отзыв|sharh|брон|bron/i);
    await expectNoAxeViolations(page, "площадка");
    await expectHitAreas(page, "площадка", CONTROLS);
    expect(api.unexpected).toEqual([]);
  });

  test("фото: без галочки «лиц нет» файлы не выбрать; фото уходит сжатым и ждёт проверки; удаление — через подтверждение", async ({
    page,
  }) => {
    const api = await start(page);
    await page.goto("/card");
    await expect(heading(page)).toHaveText(t.card);
    const section = page.locator("section[aria-labelledby='photos-title']");
    const photos = section.locator(".photos img");
    await expect(photos).toHaveCount(4);
    await expect(section.getByText(t.noFacesWarning)).toBeVisible();
    await expect(section.getByText(fill(t.photosLimits, { min: 3, max: 10 }))).toBeVisible();

    // Галочка не отмечена заранее; без неё выбор файлов закрыт
    const ack = section.getByRole("checkbox", { name: t.noFacesAck });
    const input = section.locator('input[type="file"]');
    await expect(ack).not.toBeChecked();
    await expect(input).toBeDisabled();
    await expectNoAxeViolations(page, "площадка: фото");
    await expectHitAreas(page, "площадка: фото", CONTROLS);
    await ack.check();
    await expect(input).toBeEnabled();

    await input.setInputFiles({
      name: "zal.png",
      mimeType: "image/png",
      buffer: await pngFromCanvas(page, 800, 600),
    });
    await expect(photos).toHaveCount(5);
    // На сервер — перекодированный файл (WebP, где браузер умеет, иначе JPEG) и подтверждение
    expect(api.uploads).toHaveLength(1);
    expect(api.uploads[0]?.noFaces).toBe("1");
    expect(api.uploads[0]?.contentType).toMatch(/^image\/(webp|jpeg)$/);
    expect(api.uploads[0]?.bytes).toBeGreaterThan(0);
    await expect(section.locator(".photo-chip")).toHaveCount(2);
    await expect(section.getByRole("alert")).toHaveCount(0);
    // Подтверждение — про выбранные фото: для следующих — снова
    await expect(ack).not.toBeChecked();
    await expect(input).toBeDisabled();

    // Одобренное фото опубликованной площадки при минимуме не удалить — понятная причина
    await section.getByRole("button", { name: fill(t.photoDeleteLabel, { n: 1 }) }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(t.photoDeleteQ);
    await expectNoAxeViolations(page, "площадка: удаление фото");
    await dialog.getByRole("button", { name: t.photoDelete, exact: true }).click();
    await expect(dialog.getByRole("alert")).toHaveText(fill(t.photoDeleteBlocked, { min: 3 }));
    await dialog.getByRole("button", { name: t.cancel, exact: true }).click();
    await expect(dialog).toHaveCount(0);

    // Новое (ждёт проверки) — удаляется
    await section.getByRole("button", { name: fill(t.photoDeleteLabel, { n: 5 }) }).click();
    await dialog.getByRole("button", { name: t.photoDelete, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(photos).toHaveCount(4);
    expect(api.photos).toHaveLength(4);
    expect(api.unexpected).toEqual([]);
  });

  test("сотрудник площадки: календарь ведёт, карточку не меняет — ни фото, ни предложений", async ({
    page,
  }) => {
    const api = await start(page, { role: "member" });
    await page.goto("/card");
    await expect(heading(page)).toHaveText(t.card);
    await expect(page.getByText(t.venueNoteMember)).toBeVisible();
    await expect(page.locator(".photos img")).toHaveCount(4);
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    await expect(page.locator(".photo-delete")).toHaveCount(0);
    await expect(page.getByRole("button", { name: t.proposalStart })).toHaveCount(0);
    // Кто меняет витрину — сказано один раз, вверху; блока изменений без предложений нет
    await expect(page.locator(".proposal")).toHaveCount(0);
    await expectNoAxeViolations(page, "площадка: сотрудник площадки");
    await expectHitAreas(page, "площадка: сотрудник площадки", CONTROLS);

    await page.goto("/calendar");
    await dayButton(page, 20).click();
    await expect(dayButton(page, 20)).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => api.busy.get("2026-10-20")?.source).toBe("vendor");
    expect(api.ownerOnly).toEqual([]);
    expect(api.unexpected).toEqual([]);
  });

  test("изменения карточки: форма из набора контролов, предложение ждёт проверки, отзыв — через подтверждение", async ({
    page,
  }) => {
    const api = await start(page);
    await page.goto("/card");
    await expect(heading(page)).toHaveText(t.card);
    // Вход — общим адресом с app: vendor (в разработке StrictMode входит дважды)
    expect(api.signIns.length).toBeGreaterThan(0);
    for (const body of api.signIns) expect(body).toMatchObject({ app: "vendor" });

    await page.getByRole("button", { name: t.proposalStart, exact: true }).click();
    const form = page.locator("form.proposal-form");
    await expect(form).toBeVisible();
    // Цены в правке нет: она — из услуг; поля витрины зала — из конфигурации категории
    await expect(form.getByLabel("Цена от, сум")).toHaveCount(0);
    await expect(form.getByLabel("Мест на парковке", { exact: true })).toHaveValue("80");
    await expectNoAxeViolations(page, "изменения карточки: форма");
    await expectHitAreas(page, "изменения карточки: форма", CONTROLS);

    await form.getByLabel(t.nameLabel, { exact: true }).fill("Lola zali Grand");
    await form.getByLabel("Мест на парковке", { exact: true }).fill("120");
    await form.getByRole("button", { name: t.proposalSubmit }).click();
    await expect(page.getByText(t.proposalSent)).toBeVisible();
    expect(api.revisions.map((r) => r.payload)).toEqual([
      { name: "Lola zali Grand", attributes: { parking_spaces: 120 } },
    ]);
    await expectNoAxeViolations(page, "изменения карточки: на проверке");

    await page.getByRole("button", { name: t.proposalWithdraw }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(t.proposalWithdrawQ);
    await expectNoAxeViolations(page, "изменения карточки: отзыв");
    await dialog.getByRole("button", { name: t.proposalWithdraw }).click();
    await expect(page.getByRole("button", { name: t.proposalStart, exact: true })).toBeVisible();
    expect(api.revisions.map((r) => r.status)).toEqual(["withdrawn"]);
    expect(api.unexpected).toEqual([]);
  });

  test("аккаунт: кабинет, код и роль, язык в профиле; ссылки на другие приложения", async ({ page }) => {
    const api = await start(page);
    await page.goto("/account");
    await expect(heading(page)).toHaveText(t.account);
    await expect(page.getByText(fill(t.vendorCode, { code: "V101" })).first()).toBeVisible();
    await expect(page.getByText(t.roleOwner)).toBeVisible();
    await expect(page.getByRole("link", { name: t.toClientApp })).toBeVisible();
    // В Telegram выхода нет: вход — кнопка бота
    await expect(page.getByRole("button", { name: t.signOut })).toHaveCount(0);
    await expectNoAxeViolations(page, "аккаунт");
    await expectHitAreas(page, "аккаунт", CONTROLS);
    await page.locator("main").getByRole("radio", { name: "Oʻzbekcha" }).check();
    await expect(heading(page)).toHaveText(vendorDict.uz.account);
    expect(api.unexpected).toEqual([]);
  });

  test("разделы: переход по панели разделов, текущий отмечен; у «Заявок» — число новых", async ({ page }) => {
    await start(page);
    await page.goto("/requests");
    const nav = sections(page);
    await expect(nav.getByRole("link")).toHaveCount(5);
    await expect(nav.getByRole("link", { name: t.requests })).toHaveAttribute("aria-current", "page");
    await expect(nav.locator(".nav-count")).toHaveText("1");
    for (const [name, title] of [
      [t.calendar, t.calendar],
      [t.card, t.card],
      [t.services, t.services],
      [t.account, t.account],
    ] as const) {
      await nav.getByRole("link", { name }).click();
      await expect(heading(page)).toHaveText(title);
      await expect(nav.getByRole("link", { name })).toHaveAttribute("aria-current", "page");
      // Фокус — на заголовке нового экрана
      await expect(heading(page)).toBeFocused();
    }
  });

  test("Telegram: шапка ниже выреза и кнопок клиента, нижняя панель над жест-баром", async ({ page }) => {
    test.skip(isDesktop(page), "Mini App на телефоне");
    await page.clock.setFixedTime(NOW);
    await mockVendorApi(page);
    await fakeTelegram(page, { safeArea: { top: 47, bottom: 34 }, contentSafeArea: { top: 46 } });
    await page.goto("/requests");
    await expect(heading(page)).toHaveText(t.requests);
    const pad = await page.evaluate(() => ({
      top: Number.parseFloat(getComputedStyle(document.querySelector(".top") as Element).paddingTop),
      bottom: Number.parseFloat(getComputedStyle(document.querySelector(".tabbar") as Element).paddingBottom),
    }));
    expect(pad.top).toBe(47 + 46 + 8);
    expect(pad.bottom).toBe(34 + 6);
  });

  test("нет связи: полоса на виду и при прокрутке, связь вернулась — так и сказано", async ({ page }) => {
    await start(page);
    await page.goto("/card");
    await expect(heading(page)).toHaveText(t.card);
    await page.context().setOffline(true);
    const banner = page.locator(".ui-net-banner");
    await expect(banner).toHaveText(t.offline);
    await page.mouse.wheel(0, 4000);
    await expect(banner).toBeInViewport();
    await page.context().setOffline(false);
    await expect(banner).toHaveText(t.backOnline);
  });

  for (const path of ["/requests", "/calendar"]) {
    test(`${path}: фокус с клавиатуры виден`, async ({ page }) => {
      await start(page);
      await page.goto(path);
      await heading(page).waitFor();
      await expectVisibleFocus(page, path, 12);
    });
  }

  test("экраны без горизонтальной прокрутки", async ({ page }) => {
    await start(page);
    for (const path of [
      "/requests",
      `/requests/${REQUEST_NEW}`,
      "/calendar",
      "/card",
      "/services",
      "/account",
    ]) {
      await page.goto(path);
      await heading(page).waitFor();
      await expectNoOverflow(page, path);
    }
  });

  // Ширины, на которых кабинет открывают: узкие телефоны, планшет, ноутбук, монитор
  const WIDTHS = [320, 360, 390, 768, 1024, 1280, 1440] as const;
  test("каждый экран на 320–1440px: без прокрутки вбок, всё нажимаемое — от 44px", async ({ page }) => {
    test.skip(!isDesktop(page), "ширины перебирает один проект");
    test.setTimeout(120_000);
    await start(page);
    const screens = ["/requests", `/requests/${REQUEST_NEW}`, "/calendar", "/card", "/services", "/account"];
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of screens) {
        await page.goto(path);
        await heading(page).waitFor();
        await expect(page.locator(".status-line, .skeleton")).toHaveCount(0);
        await expectNoOverflow(page, `${width}px ${path}`);
        await expectHitAreas(page, `${width}px ${path}`, CONTROLS);
        // Разделы видны на любой ширине: панель снизу, колонка или боковая панель
        await expect(sections(page)).toBeVisible();
      }
    }
  });
});

test.describe("витрины в разных категориях", () => {
  /**
   * Выбрать витрину: на компьютере — в боковой панели, на телефоне (витрин больше двух) — список
   * выбора вверху экрана
   */
  async function chooseVitrina(page: Page, name: string) {
    if (isDesktop(page)) {
      await page.locator(".side-vitrinas").getByRole("button", { name }).click();
      return;
    }
    await page.locator("main .vitrina-select").getByRole("button").click();
    await page.getByRole("option", { name }).click();
  }

  test("входящие: все витрины или одна; заявка — категория, часть дня, поля категории и услуги", async ({
    page,
  }) => {
    const api = await start(page, { listings: "many" });
    await page.goto("/requests");
    await expect(heading(page)).toHaveText(t.requests);
    // Выбор витрины — один на экране: на компьютере в боковой панели, на телефоне — над списком
    if (isDesktop(page)) {
      await expect(page.locator("main .vitrina-select")).toHaveCount(0);
      await expect(
        page.locator(".side-vitrinas").getByRole("button", { name: t.allListings }),
      ).toHaveAttribute("aria-pressed", "true");
    } else {
      await expect(page.locator("main .vitrina-select").getByRole("button")).toContainText(t.allListings);
    }
    await expect(page.locator(".rq-list .rq")).toHaveCount(2);
    const car = page.locator(".rq-list .rq").filter({ hasText: "Дильноза" });
    await expect(car.locator(".chip-cat")).toHaveText("Кортеж");
    await expect(car.locator(".rq-meta")).toContainText(t.part_evening.toLowerCase());
    await expect(car.locator(".rq-details")).toContainText("Сколько машин: 3");
    await expectNoAxeViolations(page, "входящие: витрины");
    await expectHitAreas(page, "входящие: витрины", CONTROLS);
    await expectNoOverflow(page, "входящие: витрины");

    await chooseVitrina(page, "Kortej Premium");
    await expect(page.locator(".rq-list .rq")).toHaveCount(1);
    await expect.poll(() => api.inboxQueries.at(-1)).toEqual({ tab: "new", listingId: CAR_ID });
    // Значок у раздела — новые всех витрин
    await expect(sections(page).locator(".nav-count")).toHaveText("2");

    await car.click();
    await expect(requestTitle(page)).toContainText("1060");
    await expect(page).toHaveURL(`/requests/${REQUEST_CAR}`);
    const details = page.locator(".request-details");
    await expect(page.locator(".request .facts")).toContainText(`${t.part_evening} 17:00–24:00`);
    await expect(details.locator(".detail-rows")).toContainText("Класс машины");
    await expect(details.locator(".detail-rows")).toContainText("Премиум");
    await expect(details.locator(".chosen-list")).toContainText("Машина для молодожёнов × 5");
    await expect(details.locator(".chosen-list")).toContainText("+ Украшение живыми цветами");
    await expectNoAxeViolations(page, "заявка на кортеж");
    await expectHitAreas(page, "заявка на кортеж", CONTROLS);
    await expectNoOverflow(page, "заявка на кортеж");
    expect(api.unexpected).toEqual([]);
  });

  test("витрина не на сайте: во входящих — почему и путь к чек-листу; пункты ведут туда, где их делают", async ({
    page,
  }) => {
    const api = await start(page, { listings: "many" });
    await page.goto("/requests");
    const notLive = page.locator(".not-live");
    await expect(notLive).toContainText(fill(t.notLiveDraft, { name: "Kadr Studio" }));
    // Список с карточкой рядом (компьютер) не сжимает вкладки под строкой — они целиком
    const tabs = await page.getByRole("group", { name: t.requests, exact: true }).boundingBox();
    expect(tabs?.height ?? 0).toBeGreaterThanOrEqual(44);
    await expectNoAxeViolations(page, "входящие: витрина не на сайте");
    await notLive.getByRole("button", { name: t.whatIsLeft }).click();
    await expect(heading(page)).toHaveText(t.card);
    const ready = page.locator(".readiness");
    await expect(ready.getByRole("heading", { name: t.blockersTitle })).toBeVisible();
    await expect(ready).toContainText(t.readyDraft);
    await expectNoAxeViolations(page, "витрина: чек-лист готовности");
    await expectHitAreas(page, "витрина: чек-лист готовности", CONTROLS);
    await expectNoOverflow(page, "витрина: чек-лист готовности");
    // «Данные витрины» — форма предложения открывается, фокус — в первом поле
    await ready.getByRole("button", { name: t.proposalStart }).first().click();
    await expect(page.locator("form.proposal-form input").first()).toBeFocused();
    // «Добавьте услугу с ценой» — в «Услуги» той же витрины
    await ready.getByRole("button", { name: t.toServices }).click();
    await expect(heading(page)).toHaveText(t.services);
    await expect(page.locator(".svc-head")).toBeVisible();
    expect(api.unexpected).toEqual([]);
  });

  test("услуги: новая из каталога, правка услуги на витрине — предложением, отзыв — через подтверждение", async ({
    page,
  }) => {
    const api = await start(page, { listings: "many" });
    await page.goto("/services");
    await expect(heading(page)).toHaveText(t.services);
    await chooseVitrina(page, "Kortej Premium");
    const card = page.locator(".svc").filter({ hasText: "Машина для молодожёнов" });
    await expect(card.locator(".chip")).toHaveText(t.svcSt_active);
    await expectNoAxeViolations(page, "услуги");
    await expectHitAreas(page, "услуги", CONTROLS);
    await expectNoOverflow(page, "услуги");

    // Новая: тип — из каталога категории, дополнение — из шаблона
    await page.getByRole("button", { name: t.serviceAdd }).click();
    const editor = page.locator(".svc-editor");
    await expect(editor.getByRole("heading", { name: t.serviceNew })).toBeFocused();
    await editor.getByRole("button", { name: t.serviceType }).click();
    await page.getByRole("option", { name: /Лимузин/ }).click();
    await editor.getByLabel(t.packagePrice, { exact: true }).fill("1 200 000");
    await editor.getByRole("button", { name: "Добавить: Остановки для фотосессии" }).click();
    await editor.locator(".package-row").getByLabel(t.packagePrice, { exact: true }).fill("200000");
    await expectNoAxeViolations(page, "услуги: новая");
    await expectHitAreas(page, "услуги: новая", CONTROLS);
    await expectNoOverflow(page, "услуги: новая");
    await editor.getByRole("button", { name: t.proposalSubmit }).click();
    await expect(editor).toHaveCount(0);
    const limo = page.locator(".svc").filter({ hasText: "Лимузин" });
    await expect(limo.locator(".chip")).toHaveText(t.svcSt_review);
    expect(api.serviceWrites[0]?.body).toMatchObject({
      type: "limousine",
      priceUzs: 1_200_000,
      priceUnit: "per_hour",
      options: [{ code: "photo_stops", priceUzs: 200_000, priceUnit: "per_event" }],
    });

    // Правка услуги на витрине опубликованной карточки — предложение: было → предложено
    await card.getByRole("button", { name: t.svcEdit }).click();
    await expect(page.getByText(t.serviceProposalNote)).toBeVisible();
    await editor.getByLabel(t.packagePrice, { exact: true }).first().fill("350000");
    await editor.getByRole("button", { name: t.proposalStart }).click();
    await expect(card.locator(".svc-proposal")).toContainText(t.svcProposal);
    await expect(card.locator(".changes")).toContainText("350");
    expect(api.services.get(CAR_ID)?.find((s) => s.id === SERVICE_CAR)?.proposal?.changes).toEqual({
      priceUzs: 350_000,
    });
    await expectNoAxeViolations(page, "услуги: предложение");

    // Отозвать изменения — через подтверждение
    await card.getByRole("button", { name: t.svcWithdrawProposal }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(t.proposalWithdrawQ);
    await expectNoAxeViolations(page, "услуги: подтверждение");
    await dialog.getByRole("button", { name: t.svcWithdrawProposal }).click();
    await expect(dialog).toHaveCount(0);
    await expect(card.locator(".svc-proposal")).toHaveCount(0);
    expect(api.unexpected).toEqual([]);
    expect(api.ownerOnly).toEqual([]);
  });

  test("несохранённое в услуге: «назад» Telegram и браузера — вопрос; «Остаться» — вписанное на месте", async ({
    page,
  }) => {
    test.skip(isDesktop(page), "Mini App на телефоне");
    await start(page, { listings: "many" });
    await page.goto("/requests");
    await sections(page).getByRole("link", { name: t.services }).click();
    await chooseVitrina(page, "Kortej Premium");
    const card = page.locator(".svc").filter({ hasText: "Машина для молодожёнов" });
    await card.getByRole("button", { name: t.svcEdit }).click();
    const price = page.locator(".svc-editor").getByLabel(t.packagePrice, { exact: true }).first();
    await price.fill("350000");
    // «Назад» Telegram в форме — не явная «Отмена»: с правками — вопрос
    await clickBackButton(page);
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(t.unsavedTitle);
    await expectNoAxeViolations(page, "уйти без сохранения");
    await dialog.getByRole("button", { name: t.unsavedStay }).click();
    await expect(price).toHaveValue("350000");
    // «Назад» браузера — тот же вопрос; «Уйти» — туда, куда шли
    await page.goBack();
    await expect(dialog).toContainText(t.unsavedTitle);
    await dialog.getByRole("button", { name: t.unsavedLeave }).click();
    await expect(heading(page)).toHaveText(t.requests);
  });

  test("сотрудник площадки услуги только смотрит", async ({ page }) => {
    const api = await start(page, { listings: "many", role: "member" });
    await page.goto("/services");
    await chooseVitrina(page, "Kortej Premium");
    await expect(page.locator(".svc")).toHaveCount(1);
    await expect(page.getByText(t.servicesMember)).toBeVisible();
    await expect(page.getByRole("button", { name: t.serviceAdd })).toHaveCount(0);
    await expect(page.locator(".svc-actions")).toHaveCount(0);
    await expectNoAxeViolations(page, "услуги: сотрудник");
    expect(api.serviceWrites).toEqual([]);
  });

  test("кортеж: автопарк в правке карточки — записи списка, уходят только изменённые поля", async ({
    page,
  }) => {
    const api = await start(page, { listings: "many" });
    await page.goto("/card");
    await chooseVitrina(page, "Kortej Premium");
    // Какая витрина — называет выбор (телефон) или заголовок с категорией (компьютер)
    if (isDesktop(page)) await expect(page.locator(".venue .chip-cat")).toHaveText("Кортеж");
    else await expect(page.locator("main .vitrina-select")).toContainText("Kortej Premium · Кортеж");
    await page.getByRole("button", { name: t.proposalStart, exact: true }).click();
    const form = page.locator("form.proposal-form");
    await form.getByRole("button", { name: `${t.listAdd}: Автопарк` }).click();
    const rows = form.locator(".attr-list .package-row");
    await expect(rows).toHaveCount(2);
    await rows.nth(1).locator("input.field").first().fill("Lincoln Town Car");
    await rows.nth(1).getByRole("button", { name: /Класс/ }).click();
    await page.getByRole("option", { name: "Лимузин" }).click();
    await expectNoAxeViolations(page, "кортеж: правка");
    await expectHitAreas(page, "кортеж: правка", CONTROLS);
    await expectNoOverflow(page, "кортеж: правка");
    await form.getByRole("button", { name: t.proposalSubmit }).click();
    await expect(page.getByText(t.proposalSent)).toBeVisible();
    expect(api.revisionsOf.get(CAR_ID)?.map((r) => r.payload)).toEqual([
      {
        attributes: {
          fleet: [
            { model: "Chevrolet Malibu", class: "sedan", color: "white", seats: 4 },
            { model: "Lincoln Town Car", class: "limousine" },
          ],
        },
      },
    ]);
    expect(api.unexpected).toEqual([]);
  });

  test("фото и видео: чего не хватает; фото людей — с их согласием; ссылки на видео в правке", async ({
    page,
  }) => {
    const api = await start(page, { listings: "many" });
    await page.goto("/card");
    await chooseVitrina(page, "Kadr Studio");
    // Имя витрины — один раз: в выборе (телефон) или заголовком (выбор — в боковой панели)
    if (isDesktop(page)) await expect(page.locator(".venue-name")).toHaveText("Kadr Studio");
    else await expect(page.locator(".venue-name")).toHaveCount(0);
    await expect(page.locator(".readiness")).toContainText("Команда");
    const section = page.locator("section[aria-labelledby='photos-title']");
    await expect(section.getByText(t.portfolioWarning)).toBeVisible();
    const consent = section.getByRole("checkbox", { name: t.consentAck });
    const noFaces = section.getByRole("checkbox", { name: t.noFacesAck });
    await expect(consent).not.toBeChecked();
    await expect(noFaces).not.toBeChecked();
    const input = section.locator('input[type="file"]');
    await expect(input).toBeDisabled();
    await expectNoAxeViolations(page, "фото и видео: карточка");
    await expectHitAreas(page, "фото и видео: карточка", CONTROLS);
    await consent.check();
    await input.setInputFiles({
      name: "kadr.png",
      mimeType: "image/png",
      buffer: await pngFromCanvas(page, 800, 600),
    });
    await expect(section.locator(".photos img")).toHaveCount(1);
    expect(api.uploads).toEqual([
      expect.objectContaining({ listingId: PHOTO_ID, consent: "1", noFaces: "" }),
    ]);

    await page.getByRole("button", { name: t.proposalStart, exact: true }).click();
    const form = page.locator("form.proposal-form");
    await form.getByLabel(fill(t.videoLabel, { n: 1 })).fill("https://vimeo.com/123456");
    await form.getByRole("button", { name: t.proposalSubmit }).click();
    await expect(form.getByText(t.videoInvalid)).toBeVisible();
    await form.getByLabel(fill(t.videoLabel, { n: 1 })).fill("https://youtu.be/dQw4w9WgXcQ");
    await form.getByRole("checkbox", { name: "Фотограф" }).check();
    await form.getByRole("spinbutton", { name: /Готовый материал через/ }).fill("14");
    await expectNoAxeViolations(page, "фото и видео: правка");
    await expectNoOverflow(page, "фото и видео: правка");
    await form.getByRole("button", { name: t.proposalSubmit }).click();
    await expect(page.getByText(t.proposalSent)).toBeVisible();
    expect(api.revisionsOf.get(PHOTO_ID)?.map((r) => r.payload)).toEqual([
      {
        attributes: { team: ["photographer"], delivery_days: 14 },
        video_links: ["https://youtu.be/dQw4w9WgXcQ"],
      },
    ]);
    expect(api.unexpected).toEqual([]);
  });

  test("кортеж: календарь частей дня — часть дня и сколько заказов одновременно, от версии календаря", async ({
    page,
  }) => {
    const api = await start(page, { listings: "many" });
    await page.goto("/calendar");
    await chooseVitrina(page, "Kortej Premium");
    await expect(page.getByText(t.pickDay)).toBeVisible();
    await dayButton(page, 24).click();
    await expect(dayButton(page, 24)).toHaveAttribute("aria-pressed", "true");
    const panel = page.locator(".day-panel");
    await expect(panel.getByRole("heading", { level: 2 })).toContainText("24");
    // Части выбранного дня — на экране, даже если месяц занял его целиком (телефон)
    await expect(panel).toBeInViewport();
    // Часть дня — строка с переключателем «занято»: утро занято, вечер свободен (1 из 2 мест)
    const morning = panel.getByRole("switch", { name: t.part_morning });
    const evening = panel.getByRole("switch", { name: t.part_evening });
    await expect(morning).toBeChecked();
    await expect(evening).not.toBeChecked();
    await expect(panel.locator(".day-part").nth(3)).toContainText(fill(t.partBookings, { n: 1, cap: 2 }));
    await expectNoAxeViolations(page, "календарь частей дня");
    await expectHitAreas(page, "календарь частей дня", CONTROLS);
    await expectNoOverflow(page, "календарь частей дня");

    await evening.check();
    await expect(evening).toBeChecked();
    await expect.poll(() => api.calendarWrites).toEqual(["PUT 2026-10-24?part=evening If-Match: 1"]);

    await page.getByRole("button", { name: `${t.capacityTitle}: ${t.capacityMore}` }).click();
    await page.locator(".capacity").getByRole("button", { name: t.serviceSave }).click();
    await expect.poll(() => api.calendars.get(CAR_ID)?.capacity).toBe(3);
    expect(api.calendarWrites).toEqual([
      "PUT 2026-10-24?part=evening If-Match: 1",
      "PUT capacity If-Match: 2",
    ]);
    expect(api.unexpected).toEqual([]);
  });

  test("торты: календаря нет — срок заказа витрины и услуг", async ({ page }) => {
    const api = await start(page, { listings: "many" });
    await page.goto("/calendar");
    await chooseVitrina(page, "Shirin Tort");
    await expect(page.locator(".lead-days")).toHaveText(fill(t.leadText, { n: 3 }));
    await expect(page.locator(".lead-panel")).toContainText("Свадебный торт");
    await expect(page.locator(".cal-grid")).toHaveCount(0);
    await expectNoAxeViolations(page, "торты: срок заказа");
    await expectHitAreas(page, "торты: срок заказа", CONTROLS);
    await page.locator(".lead-panel").getByRole("link", { name: t.toServices }).click();
    await expect(heading(page)).toHaveText(t.services);
    // Календарь торта не запрашивался (иначе запрос был бы в unexpected)
    expect(api.unexpected).toEqual([]);
    expect(api.calendars.get(CAKE_ID)?.version).toBe(1);
  });

  test("телефон: пять разделов внизу — подписи целиком и на 320px, на обоих языках", async ({ page }) => {
    test.skip(isDesktop(page), "нижняя панель — телефон");
    await start(page, { listings: "many" });
    for (const width of [320, 360, 390]) {
      await page.setViewportSize({ width, height: 800 });
      for (const lang of ["ru", "uz"] as const) {
        await page.goto("/account");
        await expect(heading(page)).toBeVisible();
        await page.locator(".top .lang button", { hasText: lang.toUpperCase() }).click();
        await expect(heading(page)).toHaveText(vendorDict[lang].account);
        const clipped = await page.$$eval(".tabbar .nav-label", (labels) =>
          labels.filter((el) => el.scrollWidth > el.clientWidth + 0.5).map((el) => el.textContent),
        );
        expect(clipped, `${width}px ${lang}`).toEqual([]);
        await expectNoOverflow(page, `${width}px ${lang} разделы`);
      }
    }
  });

  test("новые экраны на 320–1440px: без прокрутки вбок, всё нажимаемое — от 44px", async ({ page }) => {
    test.skip(!isDesktop(page), "ширины перебирает один проект");
    test.setTimeout(120_000);
    await start(page, { listings: "many" });
    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [path, vitrina] of [
        ["/services", "Kortej Premium"],
        ["/calendar", "Kortej Premium"],
        ["/calendar", "Shirin Tort"],
        ["/card", "Kadr Studio"],
        [`/requests/${REQUEST_CAR}`, null],
      ] as const) {
        await page.goto(path);
        await heading(page).waitFor();
        if (vitrina) {
          if (width >= 1024) {
            await page.locator(".side-vitrinas").getByRole("button", { name: vitrina }).click();
          } else {
            await page.locator("main .vitrina-select").getByRole("button").click();
            await page.getByRole("option", { name: vitrina }).click();
          }
        }
        await expect(page.locator(".status-line, .skeleton")).toHaveCount(0);
        await expectNoOverflow(page, `${width}px ${path} ${vitrina ?? ""}`);
        await expectHitAreas(page, `${width}px ${path} ${vitrina ?? ""}`, CONTROLS);
      }
    }
  });
});
