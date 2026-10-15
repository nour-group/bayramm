import type { Page } from "@playwright/test";
import { addDays } from "../../apps/web/src/format";
import { expectHitAreas, expectNoAxeViolations } from "../support/a11y";
import { APPS } from "../support/account";
import { expect, test } from "../support/offline";
import {
  ALL_LISTINGS,
  BUSY_DAY,
  horizontalOverflow,
  LISTINGS,
  open,
  PATHS,
  prepare,
  sections,
  T,
  TODAY,
  VENUE,
} from "../support/web";

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
    // Витрины — настоящие опубликованные из API (демо), ряд из четырёх, по одной из разных разделов
    await expect(page.locator(".ln-cards .card")).toHaveCount(4);
    expect(await columns(page, ".ln-cards")).toBe(4);
    // Разделы перечислены один раз — сеткой: ни второго переключателя у витрин, ни «весь раздел»
    await expect(page.locator(".landing .cat-tile")).toHaveCount(12);
    await expect(page.locator(".landing .cat-chip, .landing .ln-head-link")).toHaveCount(0);
    for (const title of [ru.lnVenuesH, ru.lnHowH, ru.lnPromH, ru.lnPartnerH, ru.lnFaqH])
      await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
    await expect(page.locator(".ln-step")).toHaveCount(3);
    await expect(page.locator(".ln-promise h3")).toHaveText(ru.lnPromT);
    // Ни рейтингов, ни «брони», ни выдуманных цифр
    expect(await page.locator("main").innerText()).not.toMatch(FORBIDDEN_BOOKING);
    // Кабинет партнёра — его приветствие вне Telegram: что это и как получить доступ
    await expect(page.getByRole("link", { name: ru.accVendor })).toHaveAttribute(
      "href",
      `${APPS.vendor}/?lang=ru`,
    );
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

  test("подбор на лендинге: залы — в каталог с датой и гостями; другая категория — без гостей", async ({
    page,
  }) => {
    await prepare(page);
    await at(page, 1280);
    await open(page, PATHS.home, ".ln-search", { guest: true });
    const form = page.locator("form.ln-search");
    // Что ищете — залы по умолчанию
    await expect(form.locator("button[aria-haspopup=listbox]")).toContainText(ru.catName.hall);
    await form.locator("button[aria-haspopup=dialog]").click();
    const day = addDays(TODAY, 19);
    await page
      .locator(".ui-layer button.ui-cal-day:not([aria-disabled])")
      .filter({ hasText: /^20$/ })
      .first()
      .click();
    await form.getByRole("spinbutton").fill("150");
    await form.getByRole("button", { name: ru.lnSearch }).click();

    await expect(page).toHaveURL((url) => url.pathname === PATHS.catalog);
    const params = new URL(page.url()).searchParams;
    expect(params.get("date")).toBe(day);
    expect(params.get("guests")).toBe("150");
    expect(params.get("category")).toBe("hall");
    // Каталог применил фильтры: поле гостей заполнено, отметки на дату у карточек
    const filters = page.locator(".catalog .filter-row");
    await expect(filters.getByRole("spinbutton")).toHaveValue("150");
    await page.locator(".cards .card .chip").first().waitFor();

    // Кортеж: гостей в подборе нет — каталог по ним не отбирает
    await open(page, PATHS.home, ".ln-search", { guest: true });
    await form.locator("button[aria-haspopup=listbox]").click();
    await page.getByRole("option", { name: ru.catName.car }).click();
    await expect(form.getByRole("spinbutton")).toHaveCount(0);
    await form.getByRole("button", { name: ru.lnSearch }).click();
    await expect(page).toHaveURL(
      (url) => url.pathname === PATHS.catalog && url.search.includes("category=car"),
    );
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(ru.catTitle(ru.catName.car));
  });

  test("старая ссылка на каталог в корне (/?date=…) ведёт в /catalog; ?lang= — язык страницы", async ({
    page,
  }) => {
    await prepare(page);
    const date = addDays(TODAY, 10);
    await page.goto(`/?date=${date}&guests=200&lang=uz`);
    await expect(page).toHaveURL(`${PATHS.catalog}?date=${date}&guests=200`);
    await expect(page.locator("html")).toHaveAttribute("lang", "uz");
    // Без раздела — весь каталог: «Barchasi»
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(T.uz.catAllTitle);
  });

  test("шапка гостя: каталог и сохранённое, «Войти»; логотип — на лендинг", async ({ page }) => {
    await prepare(page);
    await at(page, 1280);
    await open(page, PATHS.catalog, ".card", { guest: true });
    const nav = sections(page);
    await expect(nav).toHaveClass(/site-nav/);
    // Личного без входа нет: ни «Заявок», ни «Профиля»; меню гостя на компьютере не нужно
    await expect(nav.getByRole("link")).toHaveText([ru.navCatalog, ru.svTitle]);
    await expect(page.locator(".top-signin")).toBeVisible();
    await expect(page.locator(".top-menu")).toBeHidden();
    await expect(nav.getByRole("link", { name: ru.navCatalog })).toHaveAttribute("aria-current", "page");
    await nav.getByRole("link", { name: ru.svTitle }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(ru.svTitle);
    await page.locator(".top .brand").click();
    await expect(page).toHaveURL((url) => url.pathname === PATHS.home);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(ru.lnTitle);
  });

  test("шапка после входа: все четыре раздела, без «Войти»", async ({ page }) => {
    await prepare(page);
    await at(page, 1280);
    await open(page, PATHS.catalog, ".card");
    const nav = sections(page);
    await expect(nav.getByRole("link")).toHaveText([
      ru.navCatalog,
      ru.svTitle,
      ru.navRequests,
      ru.navProfile,
    ]);
    await expect(page.locator(".top-signin")).toHaveCount(0);
    await nav.getByRole("link", { name: ru.navRequests }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(ru.mrTitle);
    await nav.getByRole("link", { name: ru.navProfile }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(ru.navProfile);
  });
});

test.describe("компьютер (1280)", () => {
  test("каталог: разделы в шапке, без нижней панели, фильтры колонкой слева, сетка в три колонки", async ({
    page,
  }) => {
    await prepare(page);
    await at(page, 1280);
    await open(page, PATHS.category("hall"), ".card");
    await expect(page.locator("nav.site-nav")).toBeVisible();
    await expect(page.locator("nav.tabs")).toBeHidden();
    // Разделы в шапке — кнопками со значком; текущий залит
    for (const link of await page.locator("nav.site-nav a").all()) {
      await expect(link.locator("svg")).toBeVisible();
      expect((await link.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    // Главные фильтры — одной строкой: место, дата, гости, порядок — на одной высоте
    const tops = await page
      .locator(".filter-row > :is(.ui-select, .filter-guests, .sort)")
      .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
    expect(tops.length).toBe(4);
    expect(new Set(tops).size).toBe(1);
    // У залов есть фильтры по полям витрины (парковка, кухня, доступность) — колонкой слева
    await expect(page.locator(".filters-side")).toBeVisible();
    await expect(page.locator(".filters-open")).toBeHidden();
    expect(await columns(page, ".cards")).toBe(3);
    // Содержимое — по центру, не шире сетки 1280px
    const main = await page.locator("main").boundingBox();
    expect(main?.width ?? 0).toBeLessThanOrEqual(1280);
    await expectHitAreas(page, "каталог 1280", CONTROLS);
    await expectNoOverflow(page, "каталог 1280");
  });

  test("площадка: карточка справа — цена, «Связаться» и заявка видны и после прокрутки", async ({ page }) => {
    await prepare(page);
    await at(page, 1280, 800);
    await open(page, PATHS.venue(VENUE.slug), ".venue-head h1", { guest: true });
    const side = page.locator(".venue-side");
    const gallery = await page.locator(".gallery").boundingBox();
    const card = await side.boundingBox();
    expect(gallery && card && card.x > gallery.x + gallery.width).toBe(true);
    const contact = side.getByRole("button", { name: `${ru.contactBtn}: ${VENUE.name}` });
    await expect(contact).toBeInViewport();
    await expect(side.getByRole("link", { name: ru.pfReq })).toBeInViewport();
    // Прокрутили к календарю — карточка прилипла под шапкой, «Связаться» на экране
    await page.locator(".ui-cal").scrollIntoViewIfNeeded();
    await expect(contact).toBeInViewport();
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
  test("колонка по центру, шапка гостя или нижняя панель, две колонки карточек, фото листают кнопками", async ({
    page,
  }) => {
    await prepare(page);
    await at(page, 768, 1024);
    await open(page, PATHS.home, ".ln-cards .card", { guest: true });
    // Гость: в шапке язык, «Войти» и меню; нижней панели нет
    await expect(page.locator("nav.tabs")).toHaveCount(0);
    await expect(page.locator("nav.site-nav")).toBeHidden();
    for (const part of [".top > .lang", ".top-signin", ".top-menu"])
      await expect(page.locator(part), part).toBeVisible();
    await expectNoAxeViolations(page, "лендинг 768");
    await expectHitAreas(page, "лендинг 768", CONTROLS);
    await expectNoOverflow(page, "лендинг 768");

    // После входа (демо без ?guest) — нижняя панель
    await open(page, PATHS.catalog, ".card");
    await expect(page.locator("nav.tabs")).toBeVisible();
    expect(await columns(page, ".cards")).toBe(2);
    const main = await page.locator("main").boundingBox();
    expect(main?.width ?? 0).toBeLessThanOrEqual(720);
    await expectNoOverflow(page, "каталог 768");

    await open(page, PATHS.venue(VENUE.slug), ".venue-head h1");
    await expect(page.getByRole("button", { name: ru.galleryNext })).toBeVisible();
    // Панель с заявкой и «Связаться» — у низа экрана; второй кнопки в описании нет
    await expect(page.locator(".venue-bar")).toBeInViewport();
    await expect(page.locator(".venue-bar").getByRole("button", { name: ru.contactBtn })).toBeVisible();
    await expect(page.locator(".venue .contact")).toHaveCount(0);
    await expectNoOverflow(page, "площадка 768");
  });
});

test.describe("строка фильтров каталога", () => {
  /** Каждый видимый контрол строки — целиком на экране: ни за краем, ни под прокруткой вбок */
  async function expectRowOnScreen(page: Page, what: string) {
    const width = page.viewportSize()?.width ?? 0;
    const row = page.locator(".filter-row");
    expect(
      await row.evaluate((el) => el.scrollWidth <= el.clientWidth),
      `${what}: строка не листается вбок`,
    ).toBe(true);
    const boxes = await row.evaluate((el) =>
      [...el.children]
        .filter((child) => !child.classList.contains("sr-only"))
        .map((child) => child.getBoundingClientRect())
        .filter((box) => box.width > 0 && box.height > 0)
        .map((box) => ({ left: box.left, right: box.right })),
    );
    expect(boxes.length, `${what}: пилюли`).toBeGreaterThan(1);
    for (const box of boxes) {
      expect(box.left, what).toBeGreaterThanOrEqual(0);
      expect(box.right, what).toBeLessThanOrEqual(width);
    }
  }

  for (const width of [320, 390, 768]) {
    for (const lang of ["ru", "uz"] as const) {
      test(`${width}px ${lang}: место, дата, гости и «Фильтры» — на экране, порядок — в шторке`, async ({
        page,
      }) => {
        test.slow();
        const t = T[lang];
        await prepare(page, { lang });
        await at(page, width, 800);
        await open(page, PATHS.category("hall"), ".card", { guest: true });
        await expectRowOnScreen(page, `${width} ${lang} залы`);
        const row = page.locator(".filter-row");
        await expect(row.getByRole("spinbutton", { name: t.fGuests })).toBeVisible();
        // Порядок у раздела с полями витрины — в шторке «Фильтры», вместе с ними
        await expect(row.locator(".sort")).toBeHidden();
        await row.locator(".filters-open").click();
        const sheet = page.getByRole("dialog", { name: t.moreFilters });
        await expect(sheet.getByRole("radio", { name: t.s_rich })).toBeVisible();
        await sheet.getByRole("radio", { name: t.s_rich }).check();
        await expect(page).toHaveURL(/sort=price_desc/);
        await page.keyboard.press("Escape");
        await expect(row.locator(".filters-open")).toHaveText(t.moreFiltersN(1));

        // Раздел без полей витрины («Все») и кортеж на дату — тоже без ленты вбок
        await open(page, PATHS.catalog, ".card", { guest: true });
        await expectRowOnScreen(page, `${width} ${lang} все`);
        await expect(row.locator(".sort")).toBeVisible();
        await open(page, `${PATHS.category("car")}&date=${addDays(TODAY, 7)}`, ".card", { guest: true });
        await expectRowOnScreen(page, `${width} ${lang} кортежи на дату`);
        await expectNoOverflow(page, `${width} ${lang} каталог`);
      });
    }
  }

  test("1280px: порядок — в конце строки, поля витрины — колонкой, шторки нет", async ({ page }) => {
    await prepare(page);
    await at(page, 1280);
    await open(page, PATHS.category("hall"), ".card", { guest: true });
    const row = page.locator(".filter-row");
    await expect(row.locator(".sort")).toBeVisible();
    await expect(row.locator(".filters-open")).toBeHidden();
    await expect(page.locator(".filters-side")).toBeVisible();
    await expectRowOnScreen(page, "1280 залы");
  });
});

test.describe("панель витрины на телефоне", () => {
  // Занятая на дату витрина: кнопка — «Заявка на другую дату», самая длинная подпись
  const busy = LISTINGS.find((l) => l.busyDates.includes(BUSY_DAY)) ?? VENUE;
  const car = ALL_LISTINGS.find((l) => l.categoryCode === "car") ?? VENUE;

  for (const width of [320, 360, 390]) {
    for (const lang of ["ru", "uz"] as const) {
      test(`${width}px ${lang}: цена целиком, кнопки рядом или строкой ниже`, async ({ page }) => {
        test.slow();
        await prepare(page, { lang });
        await at(page, width, 800);
        for (const path of [
          PATHS.venue(VENUE.slug),
          `${PATHS.venue(busy.slug)}?date=${BUSY_DAY}`,
          PATHS.venue(car.slug),
        ]) {
          await open(page, path, ".venue-head h1", { guest: true });
          const bar = page.locator(".venue-bar");
          await expect(bar).toBeInViewport();
          // Ни цена, ни её единица, ни подпись кнопки не обрезаны
          const clipped = await bar
            .locator(".bar-price, .bar-price b, .bar-price .unit, .btn-primary")
            .evaluateAll((els) =>
              els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent),
            );
          expect(clipped, `${width} ${lang} ${path}`).toEqual([]);
          const box = await bar.boundingBox();
          const price = await bar.locator(".bar-price").boundingBox();
          const button = await bar.locator(".btn-primary").boundingBox();
          expect(box && price && button).toBeTruthy();
          if (box && price && button) {
            expect(price.x + price.width, path).toBeLessThanOrEqual(box.x + box.width);
            expect(button.x + button.width, path).toBeLessThanOrEqual(box.x + box.width);
          }
          await expectNoOverflow(page, `${width} ${lang} ${path}`);
        }
      });
    }
  }
});

test.describe("фокус и прилипшие панели", () => {
  for (const [what, path, barSelector] of [
    ["витрина", PATHS.venue("oq-kortej"), ".venue-bar"],
    ["форма заявки", PATHS.request("oq-kortej"), ".form-bar"],
  ] as const) {
    test(`320px, ${what}: высота панели — в запасе прокрутки, Tab не прячет фокус под неё`, async ({
      page,
    }) => {
      test.slow();
      await prepare(page);
      await at(page, 320, 640);
      await open(page, path, "main h1");
      const bar = page.locator(barSelector);
      await expect(bar).toBeInViewport();
      const height = await bar.evaluate((el) => el.getBoundingClientRect().height);
      await expect
        .poll(() =>
          page.evaluate(() =>
            Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sticky-b")),
          ),
        )
        .toBeGreaterThanOrEqual(Math.floor(height));
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press("Tab");
        const stop = await page.evaluate((selector) => {
          const el = document.activeElement;
          const panel = document.querySelector(selector);
          if (!(el instanceof HTMLElement) || !panel || panel.contains(el) || el === document.body)
            return null;
          const box = el.getBoundingClientRect();
          if (box.height === 0) return null;
          const p = panel.getBoundingClientRect();
          return {
            what: `${el.tagName.toLowerCase()}.${el.className} «${(el.textContent ?? "").trim().slice(0, 30)}»`,
            // Сколько элемента — под панелью (в конце страницы панель в потоке: подвал ниже неё — не под ней)
            covered: Math.max(0, Math.min(box.bottom, p.bottom) - Math.max(box.top, p.top)),
          };
        }, barSelector);
        if (stop) expect(stop.covered, stop.what).toBeLessThanOrEqual(1);
      }
    });
  }
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
