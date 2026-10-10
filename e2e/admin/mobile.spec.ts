import type { Page } from "@playwright/test";
import { t } from "../../apps/admin/src/texts";
import { expectHitAreas, expectNoAxeViolations } from "../support/a11y";
import { createVitrina } from "../support/admin-ui";
import { expect, test } from "../support/offline";
import {
  CAKE_LISTING_ID,
  CAR_LISTING_ID,
  CAR_REQUEST_ID,
  CLIENT_ID,
  mockStaffApi,
  NOW,
  PHOTO_LISTING_ID,
  REQUEST_ID,
  REVISION_ID,
  STAFF,
  VENDOR_ID,
} from "../support/staff-api";
import { clickBackButton, fakeTelegram, telegramState } from "../support/telegram";
import { horizontalOverflow } from "../support/web";

/* Панель на телефоне (только проект admin-phone): каждый экран на 360 и 390px — без
   прокрутки вбок, всё нажимаемое не меньше 44px, нижняя панель разделов на месте и
   работает, прилипшая панель действий в конце страницы не закрывает содержимое, axe чист.
   Отдельно — «Ещё» и аккаунт в шторках, панель действий заявки, Telegram: «назад» на
   вложенных экранах и безопасные зоны в шапке и нижней панели. */

/** Всё, во что попадают пальцем (и Tab): ссылки, кнопки, поля */
const INTERACTIVE = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "textarea",
  "select",
  "[role=button]",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

async function start(page: Page) {
  await page.clock.setFixedTime(NOW);
  // Витрины в других категориях (кортеж, фото и видео, торты) — сразу у вендора
  return mockStaffApi(page, { seeded: true });
}

/** Витрина, которой нет в подмене API, пока её не создали: создать через форму */
const openNewListing = (page: Page) => createVitrina(page);

const SCREENS: readonly { name: string; open: (page: Page) => Promise<unknown> }[] = [
  { name: "вендоры", open: (page) => page.goto("/vendors") },
  { name: "вендор", open: (page) => page.goto(`/vendors/${VENDOR_ID}`) },
  { name: "новый вендор", open: (page) => page.goto("/vendors/new") },
  { name: "новая витрина", open: (page) => page.goto(`/vendors/${VENDOR_ID}/listings/new`) },
  { name: "карточка", open: openNewListing },
  { name: "витрина: кортеж", open: (page) => page.goto(`/listings/${CAR_LISTING_ID}`) },
  { name: "витрина: фото и видео", open: (page) => page.goto(`/listings/${PHOTO_LISTING_ID}`) },
  { name: "витрина: торты", open: (page) => page.goto(`/listings/${CAKE_LISTING_ID}`) },
  { name: "заявка: кортеж", open: (page) => page.goto(`/requests/${CAR_REQUEST_ID}`) },
  { name: "модерация", open: (page) => page.goto("/moderation") },
  { name: "заявки", open: (page) => page.goto("/requests") },
  { name: "заявка", open: (page) => page.goto(`/requests/${REQUEST_ID}`) },
  { name: "метрики", open: (page) => page.goto("/metrics") },
  { name: "клиенты", open: (page) => page.goto("/clients") },
  { name: "клиент", open: (page) => page.goto(`/clients/${CLIENT_ID}`) },
  { name: "правка карточки", open: (page) => page.goto(`/revisions/${REVISION_ID}`) },
  { name: "уведомления", open: (page) => page.goto("/notifications") },
  { name: "журнал", open: (page) => page.goto("/audit") },
  { name: "команда", open: (page) => page.goto("/team") },
  { name: "настройки", open: (page) => page.goto("/settings") },
];

const tabbar = (page: Page) => page.locator("nav.tabbar");

/**
 * Страница прокручена до конца: последний блок содержимого — над панелью действий, а она и
 * содержимое — над нижней панелью разделов
 */
async function coveredAtEnd(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    const problems: string[] = [];
    const bar = document.querySelector(".actionbar")?.getBoundingClientRect();
    const tabs = document.querySelector(".tabbar")?.getBoundingClientRect();
    const page = document.querySelector(".page");
    const blocks = [...(page?.children ?? [])].filter((el) => !el.classList.contains("actionbar-slot"));
    const last = blocks.at(-1)?.getBoundingClientRect();
    if (last && bar && last.bottom > bar.top + 0.5) problems.push(`содержимое под панелью действий`);
    if (bar && tabs && bar.bottom > tabs.top + 0.5) problems.push("панель действий под нижней панелью");
    if (last && tabs && last.bottom > tabs.top + 0.5) problems.push("содержимое под нижней панелью");
    return problems;
  });
}

for (const width of [320, 360, 390] as const) {
  test.describe(`телефон ${width}px`, () => {
    test.use({ viewport: { width, height: 800 } });

    for (const screen of SCREENS) {
      test(`${screen.name}: без прокрутки вбок, 44px, нижняя панель, axe`, async ({ page }) => {
        const api = await start(page);
        await screen.open(page);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await expect(page.getByRole("status")).toHaveCount(0);
        // Нижняя панель разделов на месте, выбран раздел экрана
        await expect(tabbar(page)).toBeVisible();
        await expect(tabbar(page).locator("[aria-current=page], .is-current")).toHaveCount(1);
        const overflow = await horizontalOverflow(page);
        expect(overflow.scrollWidth, `${screen.name}: прокрутка вбок`).toBeLessThanOrEqual(width);
        expect(overflow.bodyWidth, `${screen.name}: прокрутка вбок`).toBeLessThanOrEqual(width);
        await expectHitAreas(page, `${screen.name} ${width}px`, INTERACTIVE);
        // Подписи нижней панели — целиком: ни обрезки «…», ни сокращений
        expect(
          await page.evaluate(() =>
            [...document.querySelectorAll<HTMLElement>(".tabbar .tab-label")]
              .filter((el) => el.scrollWidth > el.clientWidth || /\.$/.test(el.textContent ?? ""))
              .map((el) => el.textContent),
          ),
          `${screen.name}: подписи нижней панели`,
        ).toEqual([]);
        expect(await coveredAtEnd(page), screen.name).toEqual([]);
        await expectNoAxeViolations(page, `${screen.name} ${width}px`);
        expect(api.unexpected).toEqual([]);
      });
    }
  });
}

test.describe("календарь на 320px", () => {
  test.use({ viewport: { width: 320, height: 700 } });

  test("семь дней в строку по 44px и больше, без прокрутки вбок; день отмечается", async ({ page }) => {
    const api = await start(page);
    await openNewListing(page);
    const days = page.locator(".cal-day");
    await expect(days.first()).toBeVisible();
    const boxes = await days.evaluateAll((all) =>
      all.map((el) => {
        const r = el.getBoundingClientRect();
        return { width: r.width, height: r.height, left: r.left, right: r.right };
      }),
    );
    expect(boxes.length).toBeGreaterThanOrEqual(28);
    for (const box of boxes) {
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(320);
    }
    // Раньше месяц был шире экрана (333px): страница уезжала вбок
    const overflow = await horizontalOverflow(page);
    expect(overflow.scrollWidth).toBeLessThanOrEqual(320);
    await expectHitAreas(page, "календарь 320px", ".cal-day");
    await page.locator(".cal-today").click();
    await expect(page.locator(".cal-today")).toHaveAttribute("aria-pressed", "true");
    expect(api.calendar).toEqual([{ version: 0, busy: ["2026-10-01"] }]);
  });
});

test.describe("витрина на телефоне: оглавление блоков", () => {
  for (const width of [320, 390] as const) {
    test(`${width}px: прилипает под шапкой; переход к блоку — заголовок виден, не под оглавлением`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      const api = await start(page);
      await page.goto(`/listings/${CAR_LISTING_ID}`);
      const index = page.getByRole("navigation", { name: t.listingIndex });
      await expect(index.getByRole("button")).toHaveText([
        t.listingIndexItems.photos ?? "",
        t.listingIndexItems.services ?? "",
        t.listingIndexItems.calendar ?? "",
        t.listingIndexItems.main ?? "",
        t.listingIndexItems.attrs ?? "",
        t.listingIndexItems.phone ?? "",
        t.listingIndexItems.history ?? "",
      ]);
      await index.getByRole("button", { name: t.listingIndexItems.history }).click();
      const history = page.locator("#history-title");
      await expect(history).toBeFocused();
      // Оглавление прилипло под шапкой, заголовок блока — ниже него, а не под ним
      const boxes = await page.evaluate(() => {
        const box = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
        return { bar: box(".appbar"), index: box(".section-index"), title: box("#history-title") };
      });
      expect(Math.round(boxes.index?.top ?? -1)).toBe(Math.round(boxes.bar?.bottom ?? 0));
      expect(boxes.title?.top ?? 0).toBeGreaterThanOrEqual(boxes.index?.bottom ?? 0);
      // Само оглавление листается вбок внутри себя, страница — нет
      expect((await horizontalOverflow(page)).scrollWidth).toBeLessThanOrEqual(width);
      await expectHitAreas(page, `оглавление ${width}px`, ".section-index button");
      expect(api.unexpected).toEqual([]);
    });
  }
});

test.describe("навигация на телефоне", () => {
  test("нижняя панель: частые разделы и «Ещё» со всеми остальными; переход закрывает шторку", async ({
    page,
  }) => {
    await start(page);
    await page.goto("/requests");
    const tabs = tabbar(page);
    // Администратор: четыре частых раздела и «Ещё»
    await expect(tabs.getByRole("link")).toHaveText([/Заявки/, /Модерация/, /Вендоры/, /Метрики/]);
    await expect(tabs.getByRole("link", { name: t.requests })).toHaveAttribute("aria-current", "page");
    // Счётчики из очередей: просроченная заявка и решения модерации
    await expect(tabs.getByRole("link", { name: t.requests })).toContainText("1");

    await tabs.getByRole("link", { name: t.moderation }).click();
    await expect(page).toHaveURL("/moderation");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(t.moderation);

    const more = tabs.getByRole("button", { name: t.more });
    await more.click();
    const sheet = page.getByRole("dialog", { name: t.moreSections });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("link")).toContainText([
      t.clients,
      t.notifications,
      t.audit,
      t.team,
      t.settings,
    ]);
    await expectNoAxeViolations(page, "шторка «Ещё»");
    await sheet.getByRole("link", { name: t.team }).click();
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL("/team");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(t.team);
    // Раздел из «Ещё» открыт — «Ещё» выделено и говорит, какой
    await expect(tabs.getByRole("button", { name: t.moreCurrent(t.team) })).toBeVisible();
  });

  test("несохранённое и «Ещё»: шторка закрывается, вопрос — от «Ещё», «Остаться» — фокус туда же", async ({
    page,
  }) => {
    await start(page);
    await page.goto(`/vendors/${VENDOR_ID}/listings/new`);
    const name = page.getByLabel(t.vitrinaName, { exact: true });
    await name.fill("Navruz zali");
    await name.blur();
    const more = tabbar(page).getByRole("button", { name: t.more });
    await more.click();
    await page.getByRole("dialog", { name: t.moreSections }).getByRole("link", { name: t.team }).click();
    await expect(page.getByRole("dialog", { name: t.moreSections })).toHaveCount(0);
    const question = page.getByRole("alertdialog", { name: t.unsavedTitle });
    await expect(question).toBeVisible();
    await question.getByRole("button", { name: t.unsavedStay }).click();
    await expect(question).toHaveCount(0);
    await expect(more).toBeFocused();
    await expect(page).toHaveURL(`/vendors/${VENDOR_ID}/listings/new`);
  });

  test("аккаунт в шторке: имя, роль, другие приложения и выход", async ({ page }) => {
    const api = await start(page);
    await page.goto("/vendors");
    await page.getByRole("button", { name: t.accountOf(STAFF.displayName, t.roles[STAFF.role]) }).click();
    const sheet = page.getByRole("dialog", { name: t.account });
    await expect(sheet.getByText(STAFF.displayName)).toBeVisible();
    await expect(sheet.getByRole("link", { name: t.toCabinet })).toBeVisible();
    await expectNoAxeViolations(page, "шторка аккаунта");
    await sheet.getByRole("button", { name: t.signOut }).click();
    await expect(page).toHaveURL("/login");
    expect(api.loggedOut).toEqual(["staff"]);
  });

  test("вложенный экран: «назад» в шапке — к списку раздела, если пришли по ссылке", async ({ page }) => {
    await start(page);
    await page.goto(`/requests/${REQUEST_ID}`);
    await page.getByRole("banner").getByRole("button", { name: t.back }).click();
    await expect(page).toHaveURL("/requests");
    // Пришли из списка — «назад» как у браузера
    await page.getByRole("link", { name: /№ 1051/ }).click();
    await expect(page).toHaveURL(`/requests/${REQUEST_ID}`);
    await page.getByRole("banner").getByRole("button", { name: t.back }).click();
    await expect(page).toHaveURL("/requests");
  });

  test("заявка: действия — в панели внизу, «Связались» — в шторке с комментарием", async ({ page }) => {
    await start(page);
    await page.goto(`/requests/${REQUEST_ID}`);
    const bar = page.getByRole("group", { name: t.requestActions });
    await expect(bar.getByRole("button", { name: t.remindVendor })).toBeVisible();
    await bar.getByRole("button", { name: t.markContacted }).click();
    const sheet = page.getByRole("dialog", { name: t.markContacted });
    await expect(sheet.getByLabel(t.comment)).toBeVisible();
    // Поле — 16px: iOS не увеличивает страницу при фокусе
    expect(await sheet.getByLabel(t.comment).evaluate((el) => getComputedStyle(el).fontSize)).toBe("16px");
    await expectNoAxeViolations(page, "заявка: «Связались»");
    await sheet.getByRole("button", { name: t.cancel }).click();
    await expect(sheet).toBeHidden();
    await expect(bar.getByRole("button", { name: t.markContacted })).toBeFocused();
  });

  test("заявки: фильтры — в шторке, кнопка говорит, сколько выбрано", async ({ page }) => {
    await start(page);
    await page.goto("/requests");
    await page.getByRole("button", { name: t.filters, exact: true }).click();
    const sheet = page.getByRole("dialog", { name: t.filters });
    await sheet.getByRole("radio", { name: t.slaLate }).check();
    await sheet.getByRole("button", { name: t.done }).click();
    await expect(page.getByRole("button", { name: `${t.filters} (1)` })).toBeVisible();
    await expect(page.getByRole("button", { name: `${t.reset}: ${t.slaLate}` })).toBeVisible();
  });
});

test.describe("Telegram на телефоне", () => {
  test("нет связи: полоса — ниже выреза и кнопок Telegram, шапка — сразу под ней", async ({ page }) => {
    await start(page);
    await fakeTelegram(page, { safeArea: { top: 24, bottom: 20 }, contentSafeArea: { top: 40 } });
    await page.goto("/requests");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(t.requests);
    await page.evaluate(() => {
      Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
      window.dispatchEvent(new Event("offline"));
    });
    const banner = page.getByText(t.offline);
    await expect(banner).toBeVisible();
    // Раньше полоса стояла под кнопками Telegram (текст не прочесть), а шапка под ней ещё раз
    // отступала на 64px пустоты
    await expect
      .poll(() =>
        page.evaluate(() => {
          const text = document.querySelector(".ui-net-banner") as HTMLElement;
          const bar = document.querySelector(".appbar") as HTMLElement;
          const range = document.createRange();
          range.selectNodeContents(text);
          return {
            textTop: Math.round(range.getBoundingClientRect().top),
            gap: Math.round(bar.getBoundingClientRect().top - text.getBoundingClientRect().bottom),
            barPad: getComputedStyle(bar).paddingTop,
          };
        }),
      )
      .toEqual({ textTop: expect.any(Number), gap: 0, barPad: "8px" });
    const textTop = await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector(".ui-net-banner") as Node);
      return range.getBoundingClientRect().top;
    });
    expect(textTop).toBeGreaterThanOrEqual(64);
    // Прокрутили — полоса и шапка прилипают вместе, одна под другой
    await page.evaluate(() => window.scrollTo(0, 400));
    expect(
      await page.evaluate(() => {
        const net = document.querySelector(".net-slot")?.getBoundingClientRect();
        const bar = document.querySelector(".appbar")?.getBoundingClientRect();
        return net && bar ? [Math.round(net.top), Math.round(bar.top - net.bottom)] : null;
      }),
    ).toEqual([0, 0]);
  });

  test("несохранённое: «назад» Telegram спрашивает, закрыть Mini App — подтверждение Telegram", async ({
    page,
  }) => {
    await start(page);
    await fakeTelegram(page);
    await page.goto(`/vendors/${VENDOR_ID}/listings/new`);
    const name = page.getByLabel(t.vitrinaName, { exact: true });
    await name.fill("Navruz zali");
    await name.blur();
    await expect
      .poll(async () => (await telegramState(page)).calls.map((c) => c.name))
      .toContain("enableClosingConfirmation");

    await clickBackButton(page);
    const question = page.getByRole("alertdialog", { name: t.unsavedTitle });
    await expect(question).toBeVisible();
    await question.getByRole("button", { name: t.unsavedStay }).click();
    await expect(page).toHaveURL(`/vendors/${VENDOR_ID}/listings/new`);
    await expect(name).toHaveValue("Navruz zali");

    await clickBackButton(page);
    await question.getByRole("button", { name: t.unsavedLeave }).click();
    await expect(page).toHaveURL(`/vendors/${VENDOR_ID}`);
    // Правки брошены — Telegram больше не переспрашивает при закрытии
    expect((await telegramState(page)).calls.map((c) => c.name)).toContain("disableClosingConfirmation");
  });

  test("«назад» Telegram на вложенных экранах; безопасные зоны — в шапке и нижней панели", async ({
    page,
  }) => {
    await start(page);
    await fakeTelegram(page, { safeArea: { top: 24, bottom: 20 }, contentSafeArea: { top: 40 } });
    await page.goto(`/requests/${REQUEST_ID}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("1051");
    // Своей «назад» в шапке нет — есть кнопка Telegram
    await expect(page.getByRole("banner").getByRole("button", { name: t.back })).toHaveCount(0);
    expect((await telegramState(page)).back.visible).toBe(true);
    const calls = (await telegramState(page)).calls.map((c) => c.name);
    expect(calls).toEqual(
      expect.arrayContaining(["ready", "expand", "setHeaderColor", "disableVerticalSwipes"]),
    );

    // Верх шапки — обе зоны: вырез (24) и кнопки Telegram (40); низ панели — жест-бар (20)
    const pads = await page.evaluate(() => ({
      top: getComputedStyle(document.querySelector(".appbar") as Element).paddingTop,
      bottom: getComputedStyle(document.querySelector(".tabbar") as Element).paddingBottom,
    }));
    expect(pads).toEqual({ top: "72px", bottom: "26px" });

    await page.evaluate(() => (window as unknown as { __tg: { clickBack(): void } }).__tg.clickBack());
    await expect(page).toHaveURL("/requests");
    expect((await telegramState(page)).back.visible).toBe(false);
  });
});
