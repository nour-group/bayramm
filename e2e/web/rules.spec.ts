import { LANGS } from "@bayramm/shared";
import { comparablePriceUzs, type ListingDetail } from "@bayramm/shared/api";
import type { Locator, Page } from "@playwright/test";
import { formatDayMonth, formatPhone } from "../../apps/web/src/format";
import { expect, test } from "../support/offline";
import { fakeTelegram } from "../support/telegram";
import {
  BUSY_DAY,
  humanText,
  isDesktop,
  LISTINGS,
  open,
  PATHS,
  prepare,
  SCREENS,
  T,
  VENUE,
} from "../support/web";

/* Правила продукта (CLAUDE.md, «Правила продукта — нарушать нельзя») на живом клиенте
   в браузере — продолжение prototypes/client/smoke.js. Упал тест — нарушено обещание
   клиенту, а не вёрстка. */

const ru = T.ru;
// «band qilish» — «забронировать» по-узбекски; просто «band» — «занято», это можно
const FORBIDDEN_BOOKING = /брон|bron|band\s+qil/i;
// «baho» — оценка по-узбекски; «Bahor» — имя площадки, не оценка
const RATINGS = /★|☆|⭐|рейтинг|reyting|отзыв|sharh|\bbaho(?!r)|rating|review/i;

/** Заполнить форму заявки целиком, кроме согласий */
async function fillRequest(page: Page, comment: string) {
  const form = page.locator("form.request");
  await form.locator("label.ui-radio").first().click();
  // Первый свободный день в календаре поля даты (панель или шторка — в портале body)
  await form.locator("button[aria-haspopup=dialog]").click();
  await page.locator(".ui-layer button.ui-cal-day:not([aria-disabled])").first().click();
  await form.getByRole("spinbutton").fill("100");
  await form.locator('input[autocomplete="name"]').fill("Азиза");
  await form.locator('input[type="tel"]').fill("90 123 45 67");
  await form.locator("textarea").fill(comment);
}

test.describe("телефон виден сразу", () => {
  for (const who of ["гость в браузере", "Telegram"] as const) {
    test(`${who}: номер и «Позвонить» на площадке — до всякой заявки`, async ({ page }) => {
      await prepare(page);
      if (who === "Telegram") await fakeTelegram(page);
      await open(page, PATHS.venue(VENUE.slug), ".venue-head h1", { guest: who !== "Telegram" });

      const tel = `tel:${VENUE.phone}`;
      const desktop = isDesktop(page);
      // Телефон: на телефоне — раздел «Телефон» под названием, на компьютере — карточка справа
      const number = page.locator(
        desktop ? `.venue-side a.bar-phone[href="${tel}"]` : `.contact a.contact-phone[href="${tel}"]`,
      );
      await expect(number).toBeVisible();
      await expect(number).toBeInViewport();
      await expect(number).toHaveText(formatPhone(VENUE.phone));
      if (!desktop) await expect(page.locator(`.contact a.btn[href="${tel}"]`)).toContainText(ru.sentCall);
      // Кнопка звонка — в панели внизу (на компьютере — в карточке), на экране без прокрутки
      const barCall = page.locator(`.venue-bar a.call[href="${tel}"]`);
      await expect(barCall).toBeVisible();
      await expect(barCall).toBeInViewport();
      if (desktop) await expect(barCall).toContainText(ru.sentCall);
      // Цена в панели не уходит под кнопку звонка: рядом с ней на телефоне, над ней — на компьютере
      const priceBox = await page.locator(".venue-bar .bar-price b").boundingBox();
      const callBox = await barCall.boundingBox();
      expect(priceBox && callBox).toBeTruthy();
      if (priceBox && callBox)
        expect(
          desktop ? priceBox.y + priceBox.height <= callBox.y : priceBox.x + priceBox.width <= callBox.x,
        ).toBe(true);
      expect(
        await page.locator(".venue-bar .bar-price b").evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      // Ни формы, ни согласий на пути к номеру нет
      await expect(page.locator("form.request")).toHaveCount(0);
    });
  }
});

test.describe("тексты экранов", () => {
  for (const lang of LANGS) {
    test(`${lang}: ни «брони», ни рейтингов и отзывов — ни на одном экране`, async ({ page }) => {
      test.slow();
      await prepare(page, { lang });
      const seen: string[] = [];
      const check = async (name: string) => {
        const text = await humanText(page);
        expect.soft(text, `${lang} · ${name}: «брон»`).not.toMatch(FORBIDDEN_BOOKING);
        expect.soft(text, `${lang} · ${name}: рейтинг/отзывы`).not.toMatch(RATINGS);
        seen.push(name);
      };

      for (const screen of SCREENS) {
        await open(page, screen.path, screen.ready);
        await check(screen.name);
      }
      // Каталог с выбранной датой: отметки «занято/свободно»
      await open(page, `${PATHS.catalog}?date=${BUSY_DAY}`, ".card .chip");
      await check("каталог на дату");
      // Вне Telegram без входа форма ведёт в бота и во вход («Мои заявки» — сразу во вход)
      await open(page, PATHS.request(VENUE.slug), ".tg-cta", { guest: true });
      await check("заявка из браузера");
      // Экран после отправки
      await open(page, PATHS.request(VENUE.slug), "form.request .consents");
      await fillRequest(page, "");
      await page.locator(".consents input[type=checkbox]").first().check();
      await page.getByRole("button", { name: T[lang].rqSend }).click();
      await expect(page.getByRole("heading", { level: 1, name: T[lang].sentH })).toBeVisible();
      await check("заявка отправлена");

      // Лендинг гостя: вопросы раскрыты — их текст тоже без «брони» и рейтингов
      await open(page, PATHS.home, ".ln-faq", { guest: true });
      for (const item of await page.locator(".ln-faq summary").all()) await item.click();
      await check("лендинг с ответами");

      expect(seen).toHaveLength(SCREENS.length + 4);
      // Вместо рейтинга — «Новый»
      await open(page, PATHS.catalog, ".card");
      await expect(page.locator('.card .badge-new [aria-hidden="true"]').first()).toHaveText(
        T[lang].newBadge,
      );
    });
  }
});

test.describe("согласие", () => {
  test("галочки раздельные и не отмечены; «Не сейчас» того же размера, что «Отправить»", async ({ page }) => {
    await prepare(page);
    await open(page, PATHS.request(VENUE.slug), "form.request .consents");

    const boxes = page.locator(".consents input[type=checkbox]");
    await expect(boxes).toHaveCount(2);
    for (const box of await boxes.all()) {
      await expect(box).not.toBeChecked();
      expect(await box.evaluate((el: HTMLInputElement) => el.defaultChecked)).toBe(false);
    }
    // У каждой цели — своя подпись и свой полный текст
    const consents = page.locator(".consents .consent");
    await expect(consents.nth(0).locator("label")).toContainText(ru.consentTransfer(VENUE.name));
    await expect(consents.nth(1).locator("label")).toContainText(ru.consentNotify);
    const ids = await boxes.evaluateAll((els) => els.map((el) => el.id));
    expect(new Set(ids).size).toBe(2);
    for (const consent of await consents.all()) {
      const toggle = consent.getByRole("button", { name: ru.consentRead });
      await toggle.click();
      await expect(consent.locator(".consent-text")).toBeVisible();
    }
    const [first, second] = await consents.locator(".consent-text").allInnerTexts();
    expect(first).not.toEqual(second);

    // Отказ и отправка — одного размера
    const cancel = page.locator(".form-bar").getByRole("button", { name: ru.permCancel });
    const send = page.locator(".form-bar").getByRole("button", { name: ru.rqSend });
    const [a, b] = [await cancel.boundingBox(), await send.boundingBox()];
    expect(a && b).toBeTruthy();
    if (a && b) {
      expect(Math.abs(a.width - b.width), "ширина").toBeLessThanOrEqual(1);
      expect(Math.abs(a.height - b.height), "высота").toBeLessThanOrEqual(1);
    }

    // Без согласия на передачу заявка не уходит; уведомления — отдельная галочка по желанию
    await fillRequest(page, "");
    await send.click();
    await expect(page.getByText(ru.errConsent)).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: ru.sentH })).toHaveCount(0);
    await expect(boxes.nth(1)).not.toBeChecked();
    await boxes.nth(0).check();
    await send.click();
    await expect(page.getByRole("heading", { level: 1, name: ru.sentH })).toBeVisible();
  });
});

test.describe("занятые на дату", () => {
  const busyOn = (l: ListingDetail) => l.busyDates.includes(BUSY_DAY);
  // Цены за гостя и за мероприятие — на одной шкале, как у API (без числа гостей — на гостя)
  const price = (l: ListingDetail) => comparablePriceUzs(l, null);
  const ORDERS = {
    price_asc: (a: ListingDetail, b: ListingDetail) => price(a) - price(b),
    price_desc: (a: ListingDetail, b: ListingDetail) => price(b) - price(a),
    capacity_desc: (a: ListingDetail, b: ListingDetail) => (b.capMax ?? 0) - (a.capMax ?? 0),
  } as const;

  /** Долистать выдачу до конца: подгрузка по прокрутке или «Показать ещё» */
  async function loadAll(page: Page, cards: Locator, total: number) {
    await expect(async () => {
      const more = page.getByRole("button", { name: ru.loadMore });
      if (await more.isVisible()) await more.click();
      else await page.locator(".sentinel").scrollIntoViewIfNeeded();
      expect(await cards.count()).toBe(total);
    }).toPass({ timeout: 15_000 });
  }

  for (const [sort, order] of Object.entries(ORDERS)) {
    test(`${sort}: занятые — в конце, ни одна площадка не спрятана`, async ({ page }) => {
      const busy = LISTINGS.filter(busyOn);
      expect(busy.length, "в демо-данных есть занятые на эту дату").toBeGreaterThan(0);
      await prepare(page);
      const query = sort === "price_asc" ? "" : `&sort=${sort}`;
      await open(page, `${PATHS.catalog}?date=${BUSY_DAY}${query}`, ".card");
      const cards = page.locator(".cards .card");
      await loadAll(page, cards, LISTINGS.length);

      const expected = [...LISTINGS].sort((a, b) => Number(busyOn(a)) - Number(busyOn(b)) || order(a, b));
      expect(await cards.locator(".card-name").allInnerTexts()).toEqual(expected.map((l) => l.name));
      // Занятые помечены словами, свободные — тоже
      const busyCards = page.locator(".cards .card.busy");
      await expect(busyCards).toHaveCount(busy.length);
      for (const chip of await busyCards.locator(".chip-busy").all())
        await expect(chip).toHaveText(ru.dayBusy(formatDayMonth(BUSY_DAY, ru)));
      await expect(page.locator(".cards .card:not(.busy) .chip-free")).toHaveCount(
        LISTINGS.length - busy.length,
      );
    });
  }
});

test.describe("черновик заявки", () => {
  test("комментарий переживает уход с формы, возврат и перезагрузку", async ({ page }) => {
    const comment = "Нужен детский стол на 20 мест и пандус";
    await prepare(page);
    await open(page, PATHS.venue(VENUE.slug), ".venue-head h1");
    await page.locator(".venue-bar").getByRole("link", { name: ru.pfReq }).click();
    const field = page.getByLabel(ru.rqCom, { exact: false });
    await field.fill(comment);

    // «Не сейчас» — назад к площадке, потом снова к форме
    await page.locator(".form-bar").getByRole("button", { name: ru.permCancel }).click();
    await expect(page.locator(".venue-head h1")).toHaveText(VENUE.name);
    await page.locator(".venue-bar").getByRole("link", { name: ru.pfReq }).click();
    await expect(field).toHaveValue(comment);

    // Ушли на другую вкладку и вернулись «назад» браузера
    await page.goto(PATHS.profile);
    await page.goBack();
    await expect(field).toHaveValue(comment);

    await page.reload();
    await expect(field).toHaveValue(comment);
  });
});
