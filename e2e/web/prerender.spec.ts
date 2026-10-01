import type { Page } from "@playwright/test";
import { expectNoAxeViolations } from "../support/a11y";
import { expect, test } from "../support/offline";
import { fakeTelegram } from "../support/telegram";
import { PATHS, prepare, T } from "../support/web";

/* Пререндер лендинга: HTML главной уже несёт лендинг на языке страницы (без ?lang= —
   узбекский) — он виден до JS и без него. Приложение сменяет его своей первой отрисовкой
   без заглушки загрузки. Внутри Telegram (корень — каталог) и при другом языке приложения
   public/boot.js помечает <html> ещё до разбора body, и boot.css прячет пререндер с первой
   отрисовки: ни чужого экрана, ни чужого языка на миг.

   В разработке стили приложения приходят из JS, поэтому до приложения пререндер без них;
   прячут его стили boot.css — они в <head> и в разработке. */

const { ru, uz } = T;
const TITLE = ".ln-title";

/** Ошибки консоли и исключения страницы */
function consoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

interface Watch {
  /** data-boot у <html>, когда разборщик вставил пререндер в DOM (null — пререндера не было) */
  readonly bootAtInsert: string | null;
  /** display пререндера на DOMContentLoaded: стили из <head> уже применены, приложения ещё нет */
  readonly displayAtReady: string | null;
  /** Появлялась ли заглушка загрузки экрана */
  readonly fallback: boolean;
}

/**
 * Что было до приложения: с какой пометкой boot.js пререндер попал в DOM, виден ли он на
 * DOMContentLoaded и была ли потом заглушка Suspense. Без requestAnimationFrame: часы
 * Playwright (prepare) подменяют его таймером, кадры он больше не отражает
 */
async function watchBoot(page: Page): Promise<() => Promise<Watch>> {
  await page.addInitScript(() => {
    const state = {
      bootAtInsert: null as string | null,
      displayAtReady: null as string | null,
      fallback: false,
    };
    Object.defineProperty(window, "__watch", { value: state });
    new MutationObserver(() => {
      if (state.bootAtInsert === null && document.querySelector("[data-prerendered]"))
        state.bootAtInsert = document.documentElement.getAttribute("data-boot") ?? "none";
      if (document.querySelector(".screen-fallback")) state.fallback = true;
    }).observe(document, { childList: true, subtree: true });
    document.addEventListener("DOMContentLoaded", () => {
      const prerender = document.querySelector("[data-prerendered]");
      state.displayAtReady = prerender ? getComputedStyle(prerender).display : null;
    });
  });
  return () => page.evaluate(() => (window as unknown as { __watch: Watch }).__watch);
}

test.describe("без JS", () => {
  test.use({ javaScriptEnabled: false });

  test("главная — лендинг из HTML на узбекском: первый экран, как это работает, вопросы, подвал", async ({
    page,
  }) => {
    await page.goto(PATHS.home);
    await expect(page.locator("html")).toHaveAttribute("lang", "uz");
    await expect(page.locator(TITLE)).toHaveText(uz.lnTitle);
    await expect(page.locator(TITLE)).toBeVisible();
    await expect(page.locator("h1")).toHaveCount(1);
    for (const heading of [uz.lnHowH, uz.lnPromH, uz.lnPartnerH, uz.lnFaqH])
      await expect(page.getByRole("heading", { level: 2, name: heading })).toBeVisible();
    await expect(page.locator("form.ln-search")).toBeVisible();
    await expect(page.locator(".site-footer")).toContainText(uz.ftAbout);
    // Залы придут только с JS — места под них без JS нет
    await expect(page.locator(".ln-venues")).toBeHidden();
    // boot.js не работал: пометки нет, пререндер виден
    await expect(page.locator("html")).not.toHaveAttribute("data-boot", /.*/);
  });

  test("?lang=ru — тот же лендинг на русском", async ({ page }) => {
    await page.goto(`${PATHS.home}?lang=ru`);
    await expect(page.locator("html")).toHaveAttribute("lang", "ru");
    await expect(page.locator(TITLE)).toHaveText(ru.lnTitle);
    await expect(page.getByRole("heading", { level: 2, name: ru.lnFaqH })).toBeVisible();
  });

  test("другие страницы — как раньше: без пререндера", async ({ page }) => {
    await page.goto(PATHS.catalog);
    await expect(page.locator("[data-prerendered]")).toHaveCount(0);
    await expect(page.locator("template")).toHaveCount(0);
  });
});

test.describe("с JS в браузере", () => {
  test("до приложения виден пререндер (код приложения не загрузился)", async ({ page }) => {
    await prepare(page, { lang: "uz" });
    await page.route("**/src/main.tsx", (route) => route.abort());
    await page.goto(PATHS.home);
    await expect(page.locator("html")).toHaveAttribute("data-boot", "show");
    await expect(page.locator(TITLE)).toHaveText(uz.lnTitle);
    await expect(page.locator(TITLE)).toBeVisible();
  });

  test("язык совпал: пререндер с первого кадра, приложение сменяет его без заглушки", async ({ page }) => {
    const errors = consoleErrors(page);
    await prepare(page, { lang: "uz" });
    const watch = await watchBoot(page);
    await page.goto(PATHS.home);
    await expect(page.locator(".landing .ln-cards .card").first()).toBeVisible();

    expect(await watch()).toEqual({ bootAtInsert: "show", displayAtReady: "block", fallback: false });
    // Пререндер заменён целиком: один заголовок, один #ln-title, разметки пререндера нет
    await expect(page.locator("[data-prerendered]")).toHaveCount(0);
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.locator("#ln-title")).toHaveText(uz.lnTitle);
    await expectNoAxeViolations(page, "лендинг после пререндера");
    expect(errors).toEqual([]);
  });

  test("?lang=ru: русский пререндер у русской версии страницы", async ({ page }) => {
    const errors = consoleErrors(page);
    await prepare(page);
    const watch = await watchBoot(page);
    await page.goto(`${PATHS.home}?lang=ru`);
    await expect(page.locator(".landing .ln-cards .card").first()).toBeVisible();
    expect(await watch()).toEqual({ bootAtInsert: "show", displayAtReady: "block", fallback: false });
    await expect(page.locator(TITLE)).toHaveText(ru.lnTitle);
    // ?lang= стал выбором языка и ушёл из адреса
    await expect(page).toHaveURL(PATHS.home);
    expect(errors).toEqual([]);
  });

  test("язык приложения другой (браузер на русском): узбекский пререндер не мелькает", async ({ page }) => {
    const errors = consoleErrors(page);
    await prepare(page);
    const watch = await watchBoot(page);
    await page.goto(PATHS.home);
    await expect(page.locator(TITLE)).toHaveText(ru.lnTitle);
    await expect(page.locator(".landing .ln-cards .card").first()).toBeVisible();
    // Узбекский пререндер в DOM, но с первой отрисовки спрятан; заглушки тоже нет
    expect(await watch()).toEqual({ bootAtInsert: "skip", displayAtReady: "none", fallback: false });
    await expect(page.getByText(uz.lnTitle)).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("смена языка: второй словарь грузится по требованию, тексты меняются целиком", async ({ page }) => {
    const errors = consoleErrors(page);
    await prepare(page, { lang: "uz" });
    await page.goto(PATHS.home);
    await expect(page.locator(".landing .ln-cards .card").first()).toBeVisible();
    await page.locator('.top button[lang="ru"]').click();
    await expect(page.locator("html")).toHaveAttribute("lang", "ru");
    await expect(page.locator(TITLE)).toHaveText(ru.lnTitle);
    await expect(page.locator(".site-footer")).toContainText(ru.ftAbout);
    await expect(page.locator('.top button[lang="ru"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".lang button[aria-busy]")).toHaveCount(0);
    await page.locator('.top button[lang="uz"]').click();
    await expect(page.locator(TITLE)).toHaveText(uz.lnTitle);
    expect(errors).toEqual([]);
  });
});

test.describe("внутри Telegram", () => {
  test("корень — каталог: пререндер лендинга не мелькает ни в одном кадре", async ({ page }) => {
    const errors = consoleErrors(page);
    // Язык Mini App совпадает с языком страницы — прячет именно Telegram
    await prepare(page, { lang: "uz" });
    await fakeTelegram(page, { languageCode: "uz" });
    const watch = await watchBoot(page);
    await page.goto(PATHS.home);
    await expect(page.locator(".catalog .card").first()).toBeVisible();
    // Пререндер был в DOM с пометкой skip и на DOMContentLoaded не отображался
    const seen = await watch();
    expect(seen).toMatchObject({ bootAtInsert: "skip", displayAtReady: "none" });
    await expect(page.locator(".landing, .site-footer, [data-prerendered]")).toHaveCount(0);
    await expect(page).toHaveURL(PATHS.home);
    expect(errors).toEqual([]);
  });
});
