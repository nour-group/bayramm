import type { Page } from "@playwright/test";
import { DEMO_OTP_CODE } from "../../apps/web/src/api/mock";
import { expectHitAreas, expectNoAxeViolations, expectVisibleFocus } from "../support/a11y";
import { expect, test } from "../support/offline";
import { fakeTelegram } from "../support/telegram";
import { horizontalOverflow, isDesktop, open, PATHS, prepare, sections, T, VENUE } from "../support/web";

/* Сайт у гостя и после входа (apps/web/src/nav.ts). Гость в браузере — лендинг и шапка
   сайта: логотип, язык, «Войти» и меню-шторка; нижней панели приложения нет, личного нет —
   «Мои заявки» и профиль уводят во вход с возвратом. После входа — оболочка приложения:
   нижняя панель на телефоне, все разделы в шапке на компьютере. В Telegram — как раньше.

   Демо-API: без ?guest приложение считает себя вошедшим (демо-аккаунт), поэтому хаб без
   ?guest сразу возвращает назад — это и есть вход «понарошку». */

const ru = T.ru;
const CONTROLS = [
  ".btn",
  ".icon-btn",
  ".ui-btn",
  ".site-nav a",
  ".tabs a",
  ".top-signin",
  ".menu-links a",
  ".lang button",
  ".footer-nav a",
  ".link-btn",
  ".fav-btn",
  ".ui-select",
  ".ui-number-input",
].join(", ");

const menu = (page: Page) => page.getByRole("dialog", { name: ru.menu });

async function expectNoOverflow(page: Page, what: string) {
  const width = page.viewportSize()?.width ?? 0;
  const overflow = await horizontalOverflow(page);
  expect(overflow.scrollWidth, `${what}: ширина документа`).toBeLessThanOrEqual(width);
  expect(overflow.bodyWidth, `${what}: ширина body`).toBeLessThanOrEqual(width);
}

/** Элементы шапки не налезают друг на друга и не уходят за край экрана */
async function expectHeaderFits(page: Page, what: string) {
  const boxes = await page
    .locator(".top > *:visible")
    .evaluateAll((els) =>
      els
        .filter((el) => !el.classList.contains("skip"))
        .map((el) => ({ name: el.className, ...el.getBoundingClientRect().toJSON() })),
    );
  const width = page.viewportSize()?.width ?? 0;
  for (const box of boxes) {
    expect(box.left, `${what}: ${box.name} у левого края`).toBeGreaterThanOrEqual(0);
    expect(box.right, `${what}: ${box.name} у правого края`).toBeLessThanOrEqual(width);
  }
  for (let i = 1; i < boxes.length; i++) {
    const [prev, next] = [boxes[i - 1], boxes[i]];
    if (prev && next)
      expect(next.left, `${what}: ${next.name} после ${prev.name}`).toBeGreaterThanOrEqual(prev.right);
  }
}

test.describe("гость на телефоне", () => {
  test.skip(({ isMobile }) => !isMobile, "телефон: проект web-phone");

  test("лендинг: шапка сайта с «Войти» и меню, нижней панели нет; шапка остаётся при прокрутке", async ({
    page,
  }) => {
    await prepare(page);
    await open(page, PATHS.home, ".ln-cards .card", { guest: true });
    await expect(page.locator("nav.tabs")).toHaveCount(0);
    await expect(page.locator(".top .brand")).toBeVisible();
    // 390px: язык ещё влезает в шапку рядом со входом и меню
    await expect(page.locator(".top > .lang")).toBeVisible();
    const signIn = page.locator(".top-signin");
    await expect(signIn).toHaveText(ru.accSignIn);
    await expect(signIn).toHaveAttribute("href", "/auth?return=%2F%3Fguest%3D");
    await expect(page.locator(".top-menu")).toHaveAttribute("aria-label", ru.menu);
    await expectHeaderFits(page, "лендинг 390");

    // Залы — лентой вбок: первая карточка целиком, следующая выглядывает из-за края
    const cards = page.locator(".ln-cards > li");
    await expect(cards).toHaveCount(4);
    await page.locator(".ln-cards").scrollIntoViewIfNeeded();
    await expect(cards.nth(0)).toBeInViewport({ ratio: 0.9 });
    const second = await cards.nth(1).boundingBox();
    expect(second?.x ?? 0).toBeLessThan(page.viewportSize()?.width ?? 0);

    // Прокрутили к вопросам — шапка со входом на месте
    await page.locator(".ln-faq").scrollIntoViewIfNeeded();
    await expect(signIn).toBeInViewport();
    expect((await page.locator(".top").boundingBox())?.y).toBe(0);

    await expectNoAxeViolations(page, "лендинг гостя");
    await expectHitAreas(page, "лендинг гостя", CONTROLS);
    await expectNoOverflow(page, "лендинг гостя");
    await expectVisibleFocus(page, "лендинг гостя", 10);
  });

  test("меню: шторка снизу — разделы, бот, язык и вход; ссылка ведёт и закрывает; Esc возвращает фокус", async ({
    page,
  }) => {
    await prepare(page);
    // Залы приходят только от приложения: пререндер уже сменился (у его кнопки нет обработчика)
    await open(page, PATHS.home, ".ln-cards .card", { guest: true });
    const button = page.locator(".top-menu");
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await button.click();
    const sheet = menu(page);
    await expect(sheet).toBeVisible();
    await expect(button).toHaveAttribute("aria-expanded", "true");
    // Шторка у нижнего края экрана
    const box = await sheet.boundingBox();
    expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(page.viewportSize()?.height);

    const links = sheet.locator(".menu-links a");
    await expect(links).toHaveText([ru.navCatalog, ru.svTitle, ru.meDocs, ru.ftTelegram]);
    const bot = sheet.getByRole("link", { name: ru.ftTelegram });
    await expect(bot).toHaveAttribute("href", /^https:\/\/t\.me\/\w+bot\?startapp$/);
    await expect(bot).toHaveAttribute("target", "_blank");
    await expect(sheet.getByRole("group", { name: ru.language })).toBeVisible();
    await expect(sheet.getByRole("link", { name: ru.accSignIn })).toHaveAttribute(
      "href",
      "/auth?return=%2F%3Fguest%3D",
    );
    await expectNoAxeViolations(page, "меню гостя");
    await expectHitAreas(page, "меню гостя", CONTROLS);
    await expectNoOverflow(page, "меню гостя");

    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(button).toBeFocused();

    await button.click();
    await menu(page).getByRole("link", { name: ru.svTitle }).click();
    await expect(page).toHaveURL((url) => url.pathname === PATHS.favorites);
    await expect(menu(page)).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(ru.svTitle);
    // Сохранённое гостя — без входа, нижней панели по-прежнему нет
    await expect(page.locator("nav.tabs")).toHaveCount(0);
  });

  test("язык в меню: сайт переходит на узбекский, шторка — тоже", async ({ page }) => {
    await prepare(page);
    await open(page, PATHS.catalog, ".card", { guest: true });
    await page.locator(".top-menu").click();
    await menu(page).locator('button[lang="uz"]').click();
    await expect(page.locator("html")).toHaveAttribute("lang", "uz");
    await expect(page.getByRole("dialog").locator(".menu-links a").nth(1)).toHaveText(T.uz.svTitle);
    // Страница под шторкой inert (для диктора её нет) — заголовок ищем по разметке
    await expect(page.locator("main h1")).toHaveText(T.uz.hallsTitle);
  });
});

test.describe("гость и вход", () => {
  for (const [path, heading] of [
    [PATHS.requests, ru.mrTitle],
    [PATHS.profile, ru.navProfile],
  ] as const) {
    test(`${path} без входа — во вход с возвратом; после входа — сюда же, с оболочкой приложения`, async ({
      page,
    }) => {
      await prepare(page);
      const hub = page.waitForRequest(
        (request) => request.isNavigationRequest() && new URL(request.url()).pathname === "/auth",
      );
      await page.goto(`${path}?guest`);
      const url = new URL((await hub).url());
      expect(url.searchParams.get("return")).toBe(`${path}?guest=`);

      // Демо-аккаунт в хабе уже вошёл: хаб сразу возвращает туда, откуда пришли
      await expect(page).toHaveURL((next) => next.pathname === path);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
      await expect(sections(page).getByRole("link")).toHaveText([
        ru.navCatalog,
        ru.svTitle,
        ru.navRequests,
        ru.navProfile,
      ]);
      await expect(page.locator(isDesktop(page) ? "nav.site-nav" : "nav.tabs")).toBeVisible();
      await expect(page.locator(".top-signin, .top-menu")).toHaveCount(0);
    });
  }

  test("вход кодом из сообщения: после входа — нижняя панель (на компьютере — все разделы в шапке)", async ({
    page,
  }) => {
    await prepare(page);
    await page.goto(`/auth?guest&return=${encodeURIComponent(PATHS.catalog)}`);
    await page.getByLabel(ru.authPhoneLabel).first().fill("00 123 45 67");
    await page.getByRole("button", { name: ru.authSendCode }).click();
    await page.getByLabel(ru.authCodeLabel).fill(DEMO_OTP_CODE);
    await page.getByRole("button", { name: ru.authSignIn, exact: true }).click();

    await expect(page).toHaveURL((url) => url.pathname === PATHS.catalog);
    await page.locator(".card").first().waitFor();
    if (isDesktop(page)) {
      await expect(page.locator("nav.site-nav")).toBeVisible();
      await expect(page.locator("nav.tabs")).toBeHidden();
    } else {
      await expect(page.locator("nav.tabs")).toBeVisible();
    }
    await expect(sections(page).getByRole("link")).toHaveCount(4);
    await expect(page.locator(".top-signin, .top-menu")).toHaveCount(0);
  });

  test("«Войти» в шапке гостя ведёт в хаб и обратно на этот же экран", async ({ page }) => {
    await prepare(page);
    await open(page, PATHS.venue(VENUE.slug), ".venue-head h1", { guest: true });
    await expect(page.locator("nav.tabs")).toHaveCount(0);
    await page.locator(".top-signin").click();
    // Демо-аккаунт: хаб сразу возвращает — уже с оболочкой приложения
    await expect(page).toHaveURL((url) => url.pathname === PATHS.venue(VENUE.slug));
    await expect(page.locator(".venue-head h1")).toHaveText(VENUE.name);
    await expect(page.locator(".top-signin, .top-menu")).toHaveCount(0);
  });

  test("Telegram — как раньше: каталог в корне, вкладки, без «Войти», меню сайта и подвала", async ({
    page,
  }) => {
    await prepare(page);
    await fakeTelegram(page);
    await page.goto(PATHS.home);
    await page.locator(".catalog .card").first().waitFor();
    await expect(sections(page).getByRole("link")).toHaveText([
      ru.navHome,
      ru.svTitle,
      ru.navRequests,
      ru.navProfile,
    ]);
    await expect(page.locator(".top-signin, .top-menu, .site-footer")).toHaveCount(0);
  });
});

test.describe("пререндер — шапка гостя", () => {
  test("HTML лендинга несёт ту же шапку, что рисует приложение гостю: без скачка", async ({ browser }) => {
    const header = (page: Page) =>
      page
        .locator(".top > *")
        .evaluateAll((els) =>
          els.map(
            (el) =>
              `${el.tagName.toLowerCase()}.${el.className}|${el.getAttribute("aria-label") ?? ""}|${el.textContent}`,
          ),
        );
    const bare = await browser.newContext({ javaScriptEnabled: false, locale: "ru-RU" });
    const html = await bare.newPage();
    await html.goto(PATHS.home);
    const prerendered = await header(html);
    await expect(html.locator("nav.tabs")).toHaveCount(0);
    await bare.close();

    const live = await browser.newContext({ locale: "ru-RU" });
    const page = await live.newPage();
    await page.clock.setFixedTime(new Date("2026-10-01T07:00:00Z"));
    await page.goto(`${PATHS.home}?guest`);
    await page.locator(".landing .ln-cards .card").first().waitFor();
    await expect(page.locator("[data-prerendered]")).toHaveCount(0);
    expect(await header(page)).toEqual(prerendered);
    await live.close();
  });
});

test.describe("гость на всех ширинах", () => {
  test.skip(({ isMobile }) => isMobile, "ширины задаёт тест: проект web-desktop");

  for (const width of [320, 360, 390, 768, 1280]) {
    test(`${width}px: шапка влезает, без горизонтальной прокрутки, зоны нажатия; меню — до компьютера`, async ({
      page,
    }) => {
      await prepare(page, { lang: "uz" });
      await page.setViewportSize({ width, height: 800 });
      await open(page, PATHS.home, ".ln-cards .card", { guest: true });
      await expect(page.locator("nav.tabs")).toHaveCount(0);
      await expectHeaderFits(page, `${width} лендинг`);
      await expectNoOverflow(page, `${width} лендинг`);
      await expectHitAreas(page, `${width} лендинг`, CONTROLS);
      // Язык — в шапке, пока влезает (с 390px), и всегда в подвале
      await expect(page.locator(".top > .lang")).toBeVisible({ visible: width >= 390 });
      await expect(page.locator(".site-footer .lang")).toBeVisible();

      const button = page.locator(".top-menu");
      if (width >= 1024) {
        await expect(button).toBeHidden();
        await expect(page.locator("nav.site-nav a")).toHaveText([T.uz.navCatalog, T.uz.svTitle]);
      } else {
        await button.click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await expectNoOverflow(page, `${width} меню`);
        await expectHitAreas(page, `${width} меню`, CONTROLS);
        await page.keyboard.press("Escape");
      }

      // Внутренний экран: «назад», «Войти» и меню — тоже влезают
      await open(page, PATHS.venue(VENUE.slug), ".venue-head h1", { guest: true });
      await expectHeaderFits(page, `${width} площадка`);
      await expectNoOverflow(page, `${width} площадка`);
      await expect(page.locator(".top-signin")).toBeVisible();
    });
  }
});
