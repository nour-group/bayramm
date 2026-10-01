import type { VendorRole } from "@bayramm/shared/api/vendor";
import type { Page } from "@playwright/test";
import { fill, vendorDict } from "../../apps/vendor/src/i18n";
import { expectHitAreas, expectNoAxeViolations, expectVisibleFocus } from "../support/a11y";
import { expect, test } from "../support/offline";
import { clickBackButton, fakeTelegram } from "../support/telegram";
import { mockVendorApi, NOW, REQUEST_LATE, REQUEST_NEW, type SignIn } from "../support/vendor-api";

/* Кабинет партнёра: экраны до входа (вне Telegram и отказы API), входящие, карточка
   заявки, календарь, площадка, аккаунт — на перехваченном /api. Роли: владелец кабинета
   меняет карточку (фото, правки), сотрудник площадки — только заявки и календарь.

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
].join(", ");

async function start(
  page: Page,
  { telegram = true, signIn = "ok" as SignIn, role = "owner" as VendorRole } = {},
) {
  await page.clock.setFixedTime(NOW);
  const api = await mockVendorApi(page, { signIn, role });
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
    await expect(phone).toHaveAttribute("href", "tel:+998901234567");
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
    await expect(page.getByText(t.proposalOwnerOnly)).toBeVisible();
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

    await page.getByRole("button", { name: t.proposalStart }).click();
    const form = page.locator("form.proposal-form");
    await expect(form).toBeVisible();
    await expectNoAxeViolations(page, "изменения карточки: форма");
    await expectHitAreas(page, "изменения карточки: форма", CONTROLS);

    await form.getByLabel(t.priceFromLabel).fill("27 000 000");
    await form.getByRole("button", { name: t.proposalSubmit }).click();
    await expect(page.getByText(t.proposalSent)).toBeVisible();
    expect(api.revisions.map((r) => r.payload)).toEqual([{ price_from_uzs: 27_000_000 }]);
    await expectNoAxeViolations(page, "изменения карточки: на проверке");

    await page.getByRole("button", { name: t.proposalWithdraw }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(t.proposalWithdrawQ);
    await expectNoAxeViolations(page, "изменения карточки: отзыв");
    await dialog.getByRole("button", { name: t.proposalWithdraw }).click();
    await expect(page.getByRole("button", { name: t.proposalStart })).toBeVisible();
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
    await expect(nav.getByRole("link")).toHaveCount(4);
    await expect(nav.getByRole("link", { name: new RegExp(t.requests) })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(nav.locator(".nav-count")).toHaveText("1");
    for (const [name, title] of [
      [t.calendar, t.calendar],
      [t.card, t.card],
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
    for (const path of ["/requests", `/requests/${REQUEST_NEW}`, "/calendar", "/card", "/account"]) {
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
    const screens = ["/requests", `/requests/${REQUEST_NEW}`, "/calendar", "/card", "/account"];
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of screens) {
        await page.goto(path);
        await heading(page).waitFor();
        await expect(page.locator(".status-line")).toHaveCount(0);
        await expectNoOverflow(page, `${width}px ${path}`);
        await expectHitAreas(page, `${width}px ${path}`, CONTROLS);
        // Разделы видны на любой ширине: панель снизу, колонка или боковая панель
        await expect(sections(page)).toBeVisible();
      }
    }
  });
});
