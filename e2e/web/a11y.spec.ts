import type { Dict } from "@bayramm/shared";
import type { Page } from "@playwright/test";
import { expectHitAreas, expectNoAxeViolations, expectVisibleFocus } from "../support/a11y";
import { expect, test } from "../support/offline";
import { BUSY_DAY, horizontalOverflow, open, PATHS, prepare, sections, T, VENUE } from "../support/web";

/* Доступность и раскладка каждого главного экрана клиента: axe без серьёзных нарушений,
   кольцо фокуса, зона нажатия, ни одного пикселя горизонтальной прокрутки. */

const ru = T.ru;

// Главные элементы управления: кнопки, вкладки, поля, списки и календарь набора
// @bayramm/ui/react, выбор повода и бюджета, галочки согласий
const CONTROLS = [
  ".btn",
  ".icon-btn",
  ".ui-icon-btn",
  ".ui-btn",
  ".tabs a",
  ".site-nav a",
  ".top-signin",
  ".menu-links a",
  ".footer-nav a",
  ".gallery-nav",
  ".lang button",
  ".field-input",
  ".ui-select",
  ".ui-number-input",
  ".ui-option",
  "button.ui-cal-day",
  "label.ui-radio",
  "label.consent-check",
  ".link-btn",
  ".contact-phone",
  ".row-link",
  ".fav-btn",
].join(", ");

interface Screen {
  readonly name: string;
  readonly path: string;
  readonly ready: string;
  readonly guest?: boolean;
  /** Довести экран до нужного состояния после загрузки */
  readonly setup?: (page: Page, t: Dict) => Promise<void>;
}

const SCREENS: readonly Screen[] = [
  { name: "лендинг", path: PATHS.home, ready: ".ln-cards .card", guest: true },
  {
    name: "лендинг: вопросы раскрыты",
    path: PATHS.home,
    ready: ".ln-faq",
    guest: true,
    setup: async (page) => {
      for (const item of await page.locator(".ln-faq summary").all()) await item.click();
    },
  },
  { name: "каталог", path: PATHS.catalog, ready: ".card" },
  {
    name: "каталог: выбор даты",
    path: `${PATHS.catalog}?date=${BUSY_DAY}`,
    ready: ".card .chip",
    setup: async (page) => {
      await page.locator(".filters button[aria-haspopup=dialog]").click();
      await page.locator(".ui-layer .ui-cal").waitFor();
    },
  },
  {
    name: "каталог: список районов",
    path: PATHS.catalog,
    ready: ".card",
    setup: async (page) => {
      await page.locator(".filters button[aria-haspopup=listbox]").click();
      await page.getByRole("listbox").waitFor();
    },
  },
  { name: "площадка", path: PATHS.venue(VENUE.slug), ready: ".venue-head h1" },
  {
    // Сердечко на карточке каталога, потом вкладка «Сохранённое»
    name: "сохранённое",
    path: PATHS.catalog,
    ready: ".card",
    setup: async (page, t) => {
      await page.locator(".card .fav-btn").first().click();
      await sections(page).getByRole("link", { name: t.svTitle }).click();
      await page.locator(".favorites .card").first().waitFor();
    },
  },
  { name: "сохранённое пусто", path: PATHS.favorites, ready: ".state-empty", guest: true },
  {
    name: "форма заявки с ошибками",
    path: PATHS.request(VENUE.slug),
    ready: "form.request .consents",
    setup: async (page, t) => {
      await page.locator(".consent").first().getByRole("button", { name: t.consentRead }).click();
      await page.getByRole("button", { name: t.rqSend }).click();
      await page.locator(".form-error").waitFor();
    },
  },
  {
    name: "заявка отправлена",
    path: PATHS.request(VENUE.slug),
    ready: "form.request .consents",
    setup: async (page, t) => {
      const form = page.locator("form.request");
      await form.locator("label.ui-radio").first().click();
      await form.locator("button[aria-haspopup=dialog]").click();
      await page.locator(".ui-layer button.ui-cal-day:not([aria-disabled])").first().click();
      await form.getByRole("spinbutton").fill("100");
      await form.locator('input[autocomplete="name"]').fill("Азиза");
      await form.locator('input[type="tel"]').fill("90 123 45 67");
      await page.locator(".consents input[type=checkbox]").first().check();
      await page.getByRole("button", { name: t.rqSend }).click();
      await page.getByRole("heading", { level: 1, name: t.sentH }).waitFor();
    },
  },
  { name: "заявка из браузера", path: PATHS.request(VENUE.slug), ready: ".tg-cta .btn", guest: true },
  {
    name: "мои заявки",
    path: PATHS.requests,
    ready: ".reqs",
    setup: async (page, t) => {
      await page.locator(".req").first().getByRole("button", { name: t.withdraw }).click();
      await page.locator(".req fieldset.confirm").waitFor();
    },
  },
  {
    name: "профиль",
    path: PATHS.profile,
    ready: ".docs",
    setup: async (page) => {
      await page.locator(".docs summary").first().click();
    },
  },
  { name: "документы", path: PATHS.docs, ready: ".docs .doc", guest: true },
  { name: "хаб входа", path: "/auth", ready: ".auth-block", guest: true },
  { name: "не найдено", path: PATHS.notFound, ready: ".state-empty h1" },
];

async function show(page: Page, screen: Screen, t: Dict = ru) {
  await open(page, screen.path, screen.ready, { guest: screen.guest });
  await screen.setup?.(page, t);
}

test.describe("доступность", () => {
  for (const screen of SCREENS) {
    test(`${screen.name}: axe, зона нажатия, без горизонтальной прокрутки`, async ({ page }) => {
      await prepare(page);
      await show(page, screen);
      await expectNoAxeViolations(page, screen.name);
      await expectHitAreas(page, screen.name, CONTROLS);
      const width = page.viewportSize()?.width ?? 0;
      const overflow = await horizontalOverflow(page);
      expect(overflow.scrollWidth, `${screen.name}: ширина документа`).toBeLessThanOrEqual(width);
      expect(overflow.bodyWidth, `${screen.name}: ширина body`).toBeLessThanOrEqual(width);
    });
  }

  test("узбекский: длинные подписи не распирают экраны", async ({ page }) => {
    test.slow();
    await prepare(page, { lang: "uz" });
    const width = page.viewportSize()?.width ?? 0;
    for (const screen of SCREENS) {
      await show(page, screen, T.uz);
      const overflow = await horizontalOverflow(page);
      expect.soft(overflow.scrollWidth, `uz · ${screen.name}`).toBeLessThanOrEqual(width);
    }
  });

  for (const screen of SCREENS.filter((s) =>
    ["лендинг", "каталог", "площадка", "сохранённое", "форма заявки с ошибками", "профиль"].includes(s.name),
  )) {
    test(`${screen.name}: фокус с клавиатуры виден`, async ({ page }) => {
      await prepare(page);
      await show(page, screen);
      await expectVisibleFocus(page, screen.name, 15);
    });
  }

  test("список и календарь — одной клавиатурой: открыть, найти, выбрать; фокус вернулся, страница на месте", async ({
    page,
  }) => {
    // Узбекский: названия районов латиницей — буквы печатаются настоящими keydown
    await prepare(page, { lang: "uz" });
    await open(page, PATHS.catalog, ".card");
    const scrollY = () => page.evaluate(() => window.scrollY);
    const activeOption = () =>
      page.evaluate(() => {
        const list = document.querySelector('[role="listbox"]');
        return document.getElementById(list?.getAttribute("aria-activedescendant") ?? "")?.textContent ?? "";
      });

    // Список районов: стрелка открывает, буквы ищут, Enter выбирает
    const district = page.locator(".filters button[aria-haspopup=listbox]");
    await district.focus();
    const before = await scrollY();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("listbox")).toBeFocused();
    expect(await scrollY(), "фокус в списке не прокручивает страницу").toBe(before);
    await page.keyboard.type("chi");
    expect(await activeOption()).toBe("Chilonzor");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/[?&]district=chilonzor/);
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(district).toBeFocused();
    await expect(district).toHaveText("Chilonzor");

    // Esc закрывает без выбора
    await page.keyboard.press("Enter");
    await expect(page.getByRole("listbox")).toBeFocused();
    await page.keyboard.press("End");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(district).toBeFocused();
    await expect(page).toHaveURL(/[?&]district=chilonzor/);

    // Дата: Enter открывает календарь с фокусом на дне, стрелка — следующий день, Enter — выбор
    const date = page.locator(".filters button[aria-haspopup=dialog]");
    await date.focus();
    await page.keyboard.press("Enter");
    const focusedDay = page.locator(".ui-layer button.ui-cal-day:focus");
    await expect(focusedDay).toHaveText("1");
    await page.keyboard.press("ArrowRight");
    await expect(focusedDay).toHaveText("2");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/[?&]date=2026-10-02/);
    await expect(date).toBeFocused();
  });

  test("первый Tab — ссылка «к содержимому», она видна и ведёт в main", async ({ page }) => {
    await prepare(page);
    await open(page, PATHS.catalog, ".card");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: ru.skipToMain });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press("Enter");
    await expect(page.locator("main#main")).toBeFocused();
  });

  test("у каждого поля формы заявки есть подпись", async ({ page }) => {
    await prepare(page);
    await open(page, PATHS.request(VENUE.slug), "form.request .consents");
    const unlabeled = await page.locator("form.request").evaluate((form) =>
      [...form.querySelectorAll<HTMLInputElement>("input, select, textarea")]
        .filter((el) => el.type !== "hidden")
        .filter(
          (el) =>
            el.labels?.length === 0 && !el.getAttribute("aria-label") && !el.getAttribute("aria-labelledby"),
        )
        .map((el) => el.outerHTML.slice(0, 80)),
    );
    expect(unlabeled).toEqual([]);
  });
});
