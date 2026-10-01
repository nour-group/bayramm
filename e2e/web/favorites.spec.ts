import { expectNoAxeViolations } from "../support/a11y";
import { expect, test } from "../support/offline";
import { goToSection, isDesktop, LISTINGS, open, PATHS, prepare, sections, T } from "../support/web";

/* Избранное без входа, язык гостя между визитами, связь (баннер и повтор) и проверка
   «не робот» в хабе. Всё — на демо-API клиента в браузере, без сети. */

const ru = T.ru;
const [FIRST, SECOND] = LISTINGS;
if (!FIRST || !SECOND) throw new Error("нет демо-площадок");

const heart = (name: string) => `button.fav-btn[aria-label="${ru.favToggle(name)}"]`;

test.describe("избранное гостя", () => {
  test("сердечко в каталоге и на площадке → раздел «Сохранённое»; переживает перезагрузку", async ({
    page,
  }) => {
    await prepare(page);
    await open(page, PATHS.catalog, ".card", { guest: true });

    const first = page.locator(heart(FIRST.name));
    await expect(first).toHaveAttribute("aria-pressed", "false");
    await first.click();
    await expect(first).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".ui-toasts")).toContainText(ru.saved);

    await open(page, `${PATHS.venue(SECOND.slug)}?guest`, ".venue-head h1");
    await page.locator(heart(SECOND.name)).click();
    await expect(page.locator(heart(SECOND.name))).toHaveAttribute("aria-pressed", "true");

    // Раздел — из меню гостя (на компьютере — из шапки); последние отмеченные — первыми
    await open(page, PATHS.catalog, ".card", { guest: true });
    await goToSection(page, ru.svTitle);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(ru.svTitle);
    const names = page.locator(".favorites .card-name");
    await expect(names).toHaveText([SECOND.name, FIRST.name]);

    // Гость: список в браузере — и после перезагрузки на месте
    await page.reload();
    await expect(names).toHaveText([SECOND.name, FIRST.name]);
    await expectNoAxeViolations(page, "сохранённое");

    // Сняли сердечко здесь же — карточка ушла; последнюю — пустое состояние со ссылкой в поиск
    await page.locator(heart(SECOND.name)).click();
    await expect(names).toHaveText([FIRST.name]);
    await page.locator(heart(FIRST.name)).click();
    await expect(page.locator(".state-empty")).toContainText(ru.svEmptyH);
    await expect(page.getByRole("link", { name: ru.svGo })).toHaveAttribute("href", PATHS.catalog);
  });

  test("после входа четыре раздела — каждый не меньше 44px: внизу на телефоне, в шапке на компьютере", async ({
    page,
  }) => {
    await prepare(page);
    // Демо без ?guest — вошедший: оболочка приложения
    await open(page, PATHS.catalog, ".card");
    const tabs = sections(page).locator("a");
    await expect(page.locator(isDesktop(page) ? "nav.site-nav" : "nav.tabs")).toBeVisible();
    await expect(page.locator(isDesktop(page) ? "nav.tabs" : "nav.site-nav")).toBeHidden();
    // На сайте первый раздел — «Каталог»: главная сайта — лендинг (в Telegram — «Главная»)
    await expect(tabs).toHaveText([ru.navCatalog, ru.svTitle, ru.navRequests, ru.navProfile]);
    for (const box of await tabs.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()))) {
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  });
});

test("гость: язык, выбранный в прошлый визит, остаётся в новой вкладке", async ({ page, context }) => {
  await prepare(page);
  await open(page, PATHS.docs, ".docs", { guest: true });
  // Язык — в подвале сайта (в шапке он есть не на всякой ширине)
  await page.locator('.site-footer button[lang="uz"]').click();
  await expect(page.locator("html")).toHaveAttribute("lang", "uz");

  // Новая вкладка — sessionStorage пуст, язык — из localStorage
  const next = await context.newPage();
  await next.clock.setFixedTime(new Date("2026-10-01T07:00:00Z"));
  await next.goto(`${PATHS.docs}?guest`);
  await expect(next.locator("html")).toHaveAttribute("lang", "uz");
  await expect(next.getByRole("heading", { level: 1 })).toHaveText(T.uz.meDocs);
});

test("нет связи — полоса под шапкой; вернулась — «связь вернулась»", async ({ page, context }) => {
  await prepare(page);
  await open(page, PATHS.catalog, ".card", { guest: true });
  await context.setOffline(true);
  await expect(page.locator(".ui-net")).toHaveText(ru.offline);
  await expectNoAxeViolations(page, "нет связи");
  await context.setOffline(false);
  await expect(page.locator(".ui-net")).toHaveText(ru.backOnline);
});

test("хаб: код на телефон — после проверки «не робот», токен уходит в запрос", async ({ page }) => {
  await prepare(page);
  await page.goto("/auth?guest&turnstile");
  const check = page.locator("fieldset.human-check");
  await expect(check.locator("legend")).toHaveText(ru.humanCheck);
  await expect(check.locator(".e2e-turnstile")).toBeVisible();
  await expectNoAxeViolations(page, "хаб с проверкой");

  await page.getByLabel(ru.authPhoneLabel).first().fill("00 123 45 67");
  await page.getByRole("button", { name: ru.authSendCode }).click();
  // Демо-API без токена ответило бы turnstile_required: код отправлен — значит, токен ушёл
  await expect(page.getByText(ru.authCodeSent("+998 00 123 45 67"))).toBeVisible();
});
