import { expect, test } from "../support/offline";
import { clickBackButton, clickMainButton, fakeTelegram, telegramState } from "../support/telegram";
import { isDesktop, LISTINGS, open, PATHS, prepare, T, VENUE } from "../support/web";

/* Клиент внутри Telegram (поддельный WebApp) и в обычном браузере: ссылка на площадку,
   безопасные зоны, кнопки Telegram, путь к заявке без Telegram. */

const ru = T.ru;
const DEMO_BOT = "bayramm_demo_bot";

test.describe("внутри Telegram", () => {
  test("start_param=vendor_<slug> открывает эту площадку; «назад» Telegram ведёт в каталог", async ({
    page,
  }) => {
    const venue = LISTINGS[5] ?? VENUE;
    await prepare(page);
    await fakeTelegram(page, { startParam: `vendor_${venue.slug}` });
    // Корень Mini App — каталог (в браузере на этом адресе лендинг)
    await open(page, PATHS.home);

    await expect(page).toHaveURL(PATHS.venue(venue.slug));
    await expect(page.locator(".venue-head h1")).toHaveText(venue.name);
    // Телефон — и здесь до заявки (на телефоне — раздел «Телефон», на компьютере — карточка справа)
    await expect(page.locator(`a.contact-phone[href="tel:${venue.phone}"]:visible`)).toHaveCount(1);

    // Своя кнопка заявки не рисуется: её место — главная кнопка Telegram с тем же текстом
    await expect
      .poll(async () => (await telegramState(page)).main)
      .toEqual({ text: ru.pfReq, visible: true });
    await expect(page.locator(".venue-bar").getByRole("link", { name: ru.pfReq })).toHaveCount(0);
    // «Назад» — кнопка Telegram, а не своя в шапке
    expect((await telegramState(page)).back.visible).toBe(true);
    await expect(page.locator(".top .back")).toHaveCount(0);

    await clickMainButton(page);
    await expect(page).toHaveURL(PATHS.request(venue.slug));
    await expect(page.getByRole("heading", { level: 1, name: ru.rqTitle })).toBeVisible();
    // На форме главной кнопки нет — отправка своей кнопкой рядом с «Не сейчас»
    await expect.poll(async () => (await telegramState(page)).main.visible).toBe(false);

    await clickBackButton(page);
    await expect(page).toHaveURL(PATHS.venue(venue.slug));
    await clickBackButton(page);
    await expect(page).toHaveURL(PATHS.home);
    await expect(page.locator(".catalog .card").first()).toBeVisible();
    await expect.poll(async () => (await telegramState(page)).back.visible).toBe(false);

    const calls = (await telegramState(page)).calls.map((c) => c.name);
    expect(calls).toEqual(expect.arrayContaining(["ready", "expand", "disableVerticalSwipes"]));
  });

  test("незнакомый start_param не уводит с главной", async ({ page }) => {
    await prepare(page);
    await fakeTelegram(page, { startParam: "vendor_Not_A_Slug" });
    await open(page, PATHS.home, ".card");
    await expect(page).toHaveURL(PATHS.home);
    // В Mini App ни лендинга, ни подвала сайта
    await expect(page.locator(".landing, .site-footer")).toHaveCount(0);
  });

  test("безопасные зоны: шапка ниже выреза и кнопок Telegram, панели выше жест-бара", async ({ page }) => {
    const safe = { top: 44, bottom: 34, left: 12, right: 12 };
    const content = { top: 46, bottom: 8 };
    await prepare(page);
    await fakeTelegram(page, { safeArea: safe, contentSafeArea: content });
    await open(page, PATHS.home, ".card");
    // Свои отступы шапки и полей: на телефоне 6 и 16px, в раскладке компьютера — 10 и 32px
    const desktop = isDesktop(page);
    const ownTop = desktop ? 10 : 6;
    const ownSide = desktop ? 32 : 16;

    const px = (selector: string, property: string) =>
      page
        .locator(selector)
        .first()
        .evaluate((el, prop) => Number.parseFloat(getComputedStyle(el).getPropertyValue(prop)), property);

    // Верх складывает обе зоны: вырез + кнопки Telegram (+ свой отступ шапки)
    expect(await px(".top", "padding-top")).toBe(safe.top + content.top + ownTop);
    // Низ панели вкладок: жест-бар + зона Telegram (+ 4px)
    expect(await px(".tabs", "padding-bottom")).toBe(safe.bottom + content.bottom + 4);
    // Бока содержимого — вырез в альбомной ориентации (+ свой отступ)
    expect(await px(".main", "padding-left")).toBe(safe.left + ownSide);
    expect(await px(".main", "padding-right")).toBe(safe.right + ownSide);

    await open(page, PATHS.venue(VENUE.slug), ".venue-head h1");
    // Панель действий площадки прилипает выше жест-бара; на компьютере она — карточка справа
    if (desktop) await expect(page.locator(".venue-side .venue-bar")).toBeInViewport();
    else expect(await px(".venue-bar", "padding-bottom")).toBe(safe.bottom + content.bottom + 12);
    // Шапка не залезает под кнопки Telegram: заголовок ниже обеих зон
    const brand = await page.locator(".top .brand").boundingBox();
    expect(brand?.y ?? 0).toBeGreaterThanOrEqual(safe.top + content.top);
  });

  test("без Telegram зон нет: отступы — только свои", async ({ page }) => {
    await prepare(page);
    await open(page, PATHS.catalog, ".card");
    const top = await page.locator(".top").evaluate((el) => getComputedStyle(el).paddingTop);
    const tabs = await page.locator(".tabs").evaluate((el) => getComputedStyle(el).paddingBottom);
    expect([top, tabs]).toEqual([isDesktop(page) ? "10px" : "6px", "4px"]);
  });
});

test.describe("вне Telegram", () => {
  test("заявка ведёт в бота на эту же площадку, телефон остаётся на экране", async ({ page }) => {
    await prepare(page);
    await open(page, PATHS.venue(VENUE.slug), ".venue-head h1", { guest: true });
    // SDK нет — своя кнопка заявки на месте
    await page.locator(".venue-bar").getByRole("link", { name: ru.pfReq }).click();
    await expect(page).toHaveURL((url) => url.pathname === PATHS.request(VENUE.slug));

    await expect(page.getByRole("heading", { level: 1, name: ru.tgOnlyH })).toBeVisible();
    const bot = page.getByRole("link", { name: ru.openInTg });
    await expect(bot).toHaveAttribute("href", `https://t.me/${DEMO_BOT}?startapp=vendor_${VENUE.slug}`);
    await expect(bot).toHaveAttribute("target", "_blank");
    await expect(bot).toHaveAttribute("rel", /noopener/);
    // Формы и согласий без входа нет; позвонить можно
    await expect(page.locator("form.request")).toHaveCount(0);
    await expect(page.locator(`a[href="tel:${VENUE.phone}"]`).first()).toBeVisible();
  });
});
