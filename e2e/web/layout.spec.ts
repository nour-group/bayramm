import type { Page } from "@playwright/test";
import { addDays } from "../../apps/web/src/format";
import { expectHitAreas, expectNoAxeViolations } from "../support/a11y";
import { expect, test } from "../support/offline";
import { horizontalOverflow, open, PATHS, prepare, sections, T, TODAY, VENUE } from "../support/web";

/* Сайт на всех ширинах: лендинг для браузера, раскладка планшета (колонка по центру,
   нижняя панель) и компьютера (разделы в шапке, сетка, карточка площадки справа).
   Ширины задаёт сам тест, поэтому — только в проекте web-desktop (без эмуляции телефона). */

const ru = T.ru;
const FORBIDDEN_BOOKING = /брон|bron|band\s+qil/i;
const CONTROLS =
  ".btn, .icon-btn, .ui-icon-btn, .ui-select, .ui-number-input, .site-nav a, .tabs a, .lang button, .footer-nav a, .link-btn, .fav-btn";

// Ширины задаёт сам тест — в проекте компьютера (у телефона эмуляция устройства)
test.skip(({ isMobile }) => isMobile, "ширины задаёт тест: проект web-desktop");

async function at(page: Page, width: number, height = 900) {
  await page.setViewportSize({ width, height });
}

/** Сколько колонок в первом ряду сетки карточек */
const columns = (page: Page, list: string) =>
  page.locator(`${list} > li`).evaluateAll((items) => {
    const tops = items.map((li) => li.getBoundingClientRect().top);
    const first = Math.min(...tops);
    return tops.filter((top) => Math.abs(top - first) < 2).length;
  });

async function expectNoOverflow(page: Page, what: string) {
  const width = page.viewportSize()?.width ?? 0;
  const overflow = await horizontalOverflow(page);
  expect(overflow.scrollWidth, `${what}: ширина документа`).toBeLessThanOrEqual(width);
}

test.describe("лендинг в браузере", () => {
  test("первый экран, залы из каталога, как это работает, обещания, площадкам, вопросы, подвал", async ({
    page,
  }) => {
    await prepare(page);
    await at(page, 1280);
    await open(page, PATHS.home, ".ln-cards .card", { guest: true });
    await expect(page).toHaveTitle(ru.metaHomeTitle);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(ru.lnTitle);
    // Залы — настоящие опубликованные из API (демо), ряд из четырёх
    await expect(page.locator(".ln-cards .card")).toHaveCount(4);
    expect(await columns(page, ".ln-cards")).toBe(4);
    for (const title of [ru.lnVenuesH, ru.lnHowH, ru.lnPromH, ru.lnPartnerH, ru.lnFaqH])
      await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
    await expect(page.locator(".ln-step")).toHaveCount(3);
    await expect(page.locator(".ln-promise h3")).toHaveText(ru.lnPromT);
    // Ни рейтингов, ни «брони», ни выдуманных цифр
    expect(await page.locator("main").innerText()).not.toMatch(FORBIDDEN_BOOKING);
    // Кабинет партнёра — со входом через хаб
    await expect(page.getByRole("link", { name: ru.accVendor })).toHaveAttribute("href", /\/\?signin=1$/);
    // Подвал: документы, бот, язык
    const footer = page.locator(".site-footer");
    await expect(footer.getByRole("link", { name: ru.meDocs })).toHaveAttribute("href", PATHS.docs);
    await expect(footer.getByRole("link", { name: ru.ftTelegram })).toHaveAttribute(
      "href",
      /^https:\/\/t\.me\//,
    );
    await expect(footer.getByRole("group", { name: ru.language })).toBeVisible();
    // Гостю в шапке — «Войти» в хаб, назад — на лендинг
    await expect(page.locator(".top-signin")).toHaveAttribute("href", "/auth?return=%2F%3Fguest%3D");
    await expectNoAxeViolations(page, "лендинг 1280");
    await expectNoOverflow(page, "лендинг 1280");
  });

  test("подбор на лендинге ведёт в каталог с этими датой, гостями и районом", async ({ page }) => {
    await prepare(page);
    await at(page, 1280);
    await open(page, PATHS.home, ".ln-search", { guest: true });
    const form = page.locator("form.ln-search");
    await form.locator("button[aria-haspopup=dialog]").click();
    const day = addDays(TODAY, 19);
    await page
      .locator(".ui-layer button.ui-cal-day:not([aria-disabled])")
      .filter({ hasText: /^20$/ })
      .first()
      .click();
    await form.getByRole("spinbutton").fill("150");
    await form.locator("button[aria-haspopup=listbox]").click();
    await page.getByRole("option", { name: "Чиланзар" }).click();
    await form.getByRole("button", { name: ru.lnSearch }).click();

    await expect(page).toHaveURL((url) => url.pathname === PATHS.catalog);
    const params = new URL(page.url()).searchParams;
    expect(params.get("date")).toBe(day);
    expect(params.get("guests")).toBe("150");
    expect(params.get("district")).toBe("chilonzor");
    // Каталог применил фильтры: поля заполнены, выдача — только этот район
    const filters = page.locator(".catalog .filters");
    await expect(filters.getByRole("spinbutton")).toHaveValue("150");
    await expect(filters.locator("button[aria-haspopup=listbox]")).toContainText("Чиланзар");
    await page.locator(".cards .card").first().waitFor();
    for (const meta of await page.locator(".cards .card-meta").allInnerTexts())
      expect(meta).toContain("Чиланзар");
  });

  test("старая ссылка на каталог в корне (/?date=…) ведёт в /catalog; ?lang= — язык страницы", async ({
    page,
  }) => {
    await prepare(page);
    const date = addDays(TODAY, 10);
    await page.goto(`/?date=${date}&guests=200&lang=uz`);
    await expect(page).toHaveURL(`${PATHS.catalog}?date=${date}&guests=200`);
    await expect(page.locator("html")).toHaveAttribute("lang", "uz");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(T.uz.hallsTitle);
  });

  test("шапка: логотип — на лендинг, разделы — на свои экраны", async ({ page }) => {
    await prepare(page);
    await at(page, 1280);
    await open(page, PATHS.catalog, ".card", { guest: true });
    const nav = sections(page);
    await expect(nav).toHaveClass(/site-nav/);
    await expect(nav.getByRole("link", { name: ru.navCatalog })).toHaveAttribute("aria-current", "page");
    await nav.getByRole("link", { name: ru.svTitle }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(ru.svTitle);
    await nav.getByRole("link", { name: ru.navRequests }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(ru.mrTitle);
    await nav.getByRole("link", { name: ru.navProfile }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(ru.navProfile);
    await page.locator(".top .brand").click();
    await expect(page).toHaveURL((url) => url.pathname === PATHS.home);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(ru.lnTitle);
  });
});

test.describe("компьютер (1280)", () => {
  test("каталог: разделы в шапке, без нижней панели, сетка в четыре колонки", async ({ page }) => {
    await prepare(page);
    await at(page, 1280);
    await open(page, PATHS.catalog, ".card");
    await expect(page.locator("nav.site-nav")).toBeVisible();
    await expect(page.locator("nav.tabs")).toBeHidden();
    expect(await columns(page, ".cards")).toBe(4);
    // Содержимое — по центру, не шире сетки 1280px
    const main = await page.locator("main").boundingBox();
    expect(main?.width ?? 0).toBeLessThanOrEqual(1280);
    await expectHitAreas(page, "каталог 1280", CONTROLS);
    await expectNoOverflow(page, "каталог 1280");
  });

  test("площадка: карточка справа — цена, телефон и заявка видны и после прокрутки", async ({ page }) => {
    await prepare(page);
    await at(page, 1280, 800);
    await open(page, PATHS.venue(VENUE.slug), ".venue-head h1", { guest: true });
    const side = page.locator(".venue-side");
    const gallery = await page.locator(".gallery").boundingBox();
    const card = await side.boundingBox();
    expect(gallery && card && card.x > gallery.x + gallery.width).toBe(true);
    const phone = side.locator(`a.bar-phone[href="tel:${VENUE.phone}"]`);
    await expect(phone).toBeInViewport();
    await expect(side.getByRole("link", { name: ru.pfReq })).toBeInViewport();
    // Прокрутили к календарю — карточка прилипла под шапкой, номер на экране
    await page.locator(".ui-cal").scrollIntoViewIfNeeded();
    await expect(phone).toBeInViewport();
    // Фото листают и кнопками
    const next = page.getByRole("button", { name: ru.galleryNext });
    await expect(page.getByRole("button", { name: ru.galleryPrev })).toBeDisabled();
    await next.click();
    await expect(page.getByRole("button", { name: ru.galleryPrev })).toBeEnabled();
    await expectNoAxeViolations(page, "площадка 1280");
    await expectNoOverflow(page, "площадка 1280");
  });

  test("форма заявки и профиль — колонкой для чтения по центру", async ({ page }) => {
    await prepare(page);
    await at(page, 1280);
    for (const [path, ready] of [
      [PATHS.request(VENUE.slug), "form.request .consents"],
      [PATHS.profile, ".docs"],
      [PATHS.requests, ".reqs"],
    ] as const) {
      await open(page, path, ready);
      const box = await page.locator("main").boundingBox();
      expect(box?.width ?? 0, path).toBeLessThanOrEqual(784);
      expect(
        Math.abs((box?.x ?? 0) * 2 + (box?.width ?? 0) - 1280),
        `${path}: по центру`,
      ).toBeLessThanOrEqual(2);
    }
  });
});

test.describe("планшет (768)", () => {
  test("колонка по центру, нижняя панель, две колонки карточек, фото листают кнопками", async ({ page }) => {
    await prepare(page);
    await at(page, 768, 1024);
    await open(page, PATHS.home, ".ln-cards .card", { guest: true });
    await expect(page.locator("nav.tabs")).toBeVisible();
    await expect(page.locator("nav.site-nav")).toBeHidden();
    await expectNoAxeViolations(page, "лендинг 768");
    await expectHitAreas(page, "лендинг 768", CONTROLS);
    await expectNoOverflow(page, "лендинг 768");

    await open(page, PATHS.catalog, ".card");
    expect(await columns(page, ".cards")).toBe(2);
    const main = await page.locator("main").boundingBox();
    expect(main?.width ?? 0).toBeLessThanOrEqual(720);
    await expectNoOverflow(page, "каталог 768");

    await open(page, PATHS.venue(VENUE.slug), ".venue-head h1");
    await expect(page.getByRole("button", { name: ru.galleryNext })).toBeVisible();
    // Панель с заявкой — у низа экрана, номер — в разделе «Телефон»
    await expect(page.locator(".venue-bar")).toBeInViewport();
    await expect(page.locator(`.contact a.contact-phone[href="tel:${VENUE.phone}"]`)).toBeVisible();
    await expectNoOverflow(page, "площадка 768");
  });
});

test.describe("узкие телефоны", () => {
  for (const width of [320, 360]) {
    test(`${width}px: лендинг, каталог и площадка без горизонтальной прокрутки`, async ({ page }) => {
      await prepare(page, { lang: "uz" });
      await at(page, width, 740);
      for (const [path, ready] of [
        [PATHS.home, ".ln-search"],
        [PATHS.catalog, ".card"],
        [PATHS.venue(VENUE.slug), ".venue-head h1"],
        [PATHS.request(VENUE.slug), "form.request .consents"],
      ] as const) {
        await open(page, path, ready, { guest: path === PATHS.home });
        await expectNoOverflow(page, `${width} ${path}`);
        // Подписи в полях выбора не обрезаны многоточием: «istalgan», «barcha tumanlar»
        const clipped = await page
          .locator("main .ui-select-value")
          .evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth + 1).length);
        expect(clipped, `${width} ${path}: обрезанные подписи`).toBe(0);
      }
    });
  }
});
