import type { Dict } from "@bayramm/shared";
import type { Page } from "@playwright/test";
import { expectHitAreas, expectNoAxeViolations, expectVisibleFocus } from "../support/a11y";
import { expect, test } from "../support/offline";
import { BUSY_DAY, horizontalOverflow, open, PATHS, prepare, T, VENUE } from "../support/web";

/* Доступность и раскладка каждого главного экрана клиента: axe без серьёзных нарушений,
   кольцо фокуса, зона нажатия, ни одного пикселя горизонтальной прокрутки. */

const ru = T.ru;

// Главные элементы управления: кнопки, вкладки, поля, дни календаря, выбор повода и бюджета
const CONTROLS = [
  ".btn",
  ".icon-btn",
  ".tabs a",
  ".lang button",
  ".field-input",
  ".sort select",
  "button.cal-day",
  "label.choice",
  "label.consent-check",
  ".link-btn",
  ".contact-phone",
  ".row-link",
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
  { name: "каталог", path: PATHS.catalog, ready: ".card" },
  {
    name: "каталог: выбор даты",
    path: `${PATHS.catalog}?date=${BUSY_DAY}`,
    ready: ".card .chip",
    setup: async (page) => {
      await page.locator(".filters .field-button").click();
      await page.locator(".date-panel .cal").waitFor();
    },
  },
  { name: "площадка", path: PATHS.venue(VENUE.slug), ready: ".venue-head h1" },
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
      await form.locator("label.choice").first().click();
      await form.locator("button.cal-day:not([disabled])").first().click();
      await form.locator('input[type="number"]').fill("100");
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
  { name: "мои заявки из браузера", path: PATHS.requests, ready: ".tg-cta .btn", guest: true },
  {
    name: "профиль",
    path: PATHS.profile,
    ready: ".docs",
    setup: async (page) => {
      await page.locator(".docs summary").first().click();
    },
  },
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
    await prepare(page, { lang: "uz" });
    const width = page.viewportSize()?.width ?? 0;
    for (const screen of SCREENS) {
      await show(page, screen, T.uz);
      const overflow = await horizontalOverflow(page);
      expect.soft(overflow.scrollWidth, `uz · ${screen.name}`).toBeLessThanOrEqual(width);
    }
  });

  for (const screen of SCREENS.filter((s) =>
    ["каталог", "площадка", "форма заявки с ошибками", "профиль"].includes(s.name),
  )) {
    test(`${screen.name}: фокус с клавиатуры виден`, async ({ page }) => {
      await prepare(page);
      await show(page, screen);
      await expectVisibleFocus(page, screen.name, 15);
    });
  }

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
