import type { VendorRole } from "@bayramm/shared/api/vendor";
import type { Page } from "@playwright/test";
import { fill, vendorDict } from "../../apps/vendor/src/i18n";
import { expectHitAreas, expectNoAxeViolations, expectVisibleFocus } from "../support/a11y";
import { expect, test } from "../support/offline";
import { clickBackButton, fakeTelegram } from "../support/telegram";
import { mockVendorApi, NOW, REQUEST_LATE, REQUEST_NEW, type SignIn } from "../support/vendor-api";

/* Кабинет вендора: экраны до входа (вне Telegram и отказы API), входящие, карточка
   заявки, календарь, площадка — на перехваченном /api. Роли: владелец кабинета меняет
   карточку (фото, правки), сотрудник площадки — только заявки и календарь. */

const t = vendorDict.ru;
const BOT = "https://t.me/bayramm_demo_bot?start=partner";
const CONTROLS = [
  ".btn",
  ".pill",
  ".tab",
  ".lang button",
  ".cal-day",
  ".icon-btn",
  ".back-link",
  ".rq",
  "label.ui-radio",
  "label.ui-check",
  ".ui-drop-face",
].join(", ");

async function start(
  page: Page,
  { telegram = true, signIn = "ok" as SignIn, role = "owner" as VendorRole } = {},
) {
  await page.clock.setFixedTime(NOW);
  const api = await mockVendorApi(page, { signIn, role });
  if (telegram) await fakeTelegram(page);
  return api;
}

/** Настоящий PNG из канваса страницы: сжатие в браузере перекодирует его, как фото с телефона */
async function pngFromCanvas(page: Page, width: number, height: number): Promise<Buffer> {
  const bytes = await page.evaluate(
    async ([w, h]) => {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const context = canvas.getContext("2d");
      if (context) {
        context.fillStyle = "rgb(214, 180, 140)";
        context.fillRect(0, 0, w, h);
        context.fillStyle = "rgb(120, 60, 90)";
        context.fillRect(w / 4, h / 4, w / 2, h / 2);
      }
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      return blob ? [...new Uint8Array(await blob.arrayBuffer())] : [];
    },
    [width, height] as const,
  );
  return Buffer.from(bytes);
}

const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const dayButton = (page: Page, day: number) =>
  page.locator("button.cal-day").filter({ has: page.getByText(String(day), { exact: true }) });

test.describe("до входа", () => {
  test("вне Telegram: «откройте из бота» и ссылка на бота окружения", async ({ page }) => {
    const api = await start(page, { telegram: false });
    await page.goto("/");
    await expect(heading(page)).toHaveText(t.gateOutsideTitle);
    const bot = page.getByRole("link", { name: t.openBot });
    await expect(bot).toHaveAttribute("href", BOT);
    // Кабинета без входа нет: ни вкладок, ни заявок
    await expect(page.locator(".tabbar")).toHaveCount(0);
    await expectNoAxeViolations(page, "вне Telegram");
    await expectHitAreas(page, "вне Telegram", CONTROLS);
    expect(api.unexpected).toEqual([]);
  });

  const GATES: readonly [SignIn, string, boolean][] = [
    ["not_linked", t.gateNotLinkedTitle, true],
    ["disabled", t.gateDisabledTitle, false],
    ["expired", t.gateExpiredTitle, true],
    ["error", t.gateErrorTitle, false],
  ];
  for (const [signIn, title, bot] of GATES) {
    test(`вход ответил ${signIn}: понятный экран`, async ({ page }) => {
      await start(page, { signIn });
      await page.goto("/");
      await expect(heading(page)).toHaveText(title);
      await expect(page.getByRole("link", { name: t.openBot })).toHaveCount(bot ? 1 : 0);
      if (signIn === "error") await expect(page.getByRole("button", { name: t.retry })).toBeVisible();
      await expect(page.locator(".tabbar")).toHaveCount(0);
      await expectNoAxeViolations(page, `вход: ${signIn}`);
    });
  }
});

test.describe("кабинет", () => {
  test("входящие → карточка заявки: телефон клиента, «Я связался», назад кнопкой Telegram", async ({
    page,
  }) => {
    const api = await start(page);
    await page.goto("/");
    await expect(heading(page)).toHaveText(t.requests);
    await expect(page).toHaveURL("/requests");

    const tabs = page.locator(".pills .pill");
    await expect(tabs.nth(0)).toContainText(`${t.tabNew}1`);
    const cards = page.locator(".rq-list .rq");
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText("Азиза");
    // Телефона клиента в списке нет — только в карточке
    await expect(page.locator(".rq-list a[href^='tel:']")).toHaveCount(0);
    await expectNoAxeViolations(page, "входящие");
    await expectHitAreas(page, "входящие", CONTROLS);

    await cards.first().click();
    await expect(page).toHaveURL(`/requests/${REQUEST_NEW}`);
    await expect(heading(page)).toContainText("1051");
    const phone = page.locator("a.btn-phone");
    await expect(phone).toHaveAttribute("href", "tel:+998901234567");
    await expect(page.getByText("Нужен детский стол")).toBeVisible();
    await expectNoAxeViolations(page, "карточка заявки");
    await expectHitAreas(page, "карточка заявки", CONTROLS);

    await page.getByRole("button", { name: t.actContacted }).click();
    await expect(page.locator(".detail-top .chip")).toHaveText(t.st_contacted);
    expect(api.patches).toEqual([{ id: REQUEST_NEW, body: { status: "contacted" } }]);

    // Отказ: форма с причинами, «Отмена» возвращает действия
    await page.getByRole("button", { name: t.actNoDeal }).click();
    await expect(page.locator("form.decline")).toBeVisible();
    await expectNoAxeViolations(page, "отказ");
    await expectHitAreas(page, "отказ", CONTROLS);
    await page.locator("form.decline").getByRole("button", { name: t.cancel }).click();

    await clickBackButton(page);
    await expect(page).toHaveURL("/requests");
    await page.locator(".pills .pill").nth(1).click();
    await expect(page.locator(".rq-list .rq")).toHaveCount(2);
    expect(api.unexpected).toEqual([]);
  });

  test("просроченная заявка помечена в списке и в карточке", async ({ page }) => {
    await start(page);
    await page.goto(`/requests/${REQUEST_LATE}`);
    await expect(page.locator(".detail-top .chip")).toHaveText(t.late);
    await expect(page.locator(".sla-late")).toBeVisible();
  });

  test("календарь: день занимается и освобождается одним нажатием; закрытый менеджером — нет", async ({
    page,
  }) => {
    const api = await start(page);
    await page.goto("/calendar");
    await expect(heading(page)).toHaveText(t.calendar);
    await expect(dayButton(page, 10)).toHaveAttribute("aria-pressed", "true");
    await expectNoAxeViolations(page, "календарь");
    await expectHitAreas(page, "календарь", CONTROLS);

    await dayButton(page, 20).click();
    await expect(dayButton(page, 20)).toHaveAttribute("aria-pressed", "true");
    // Отметка на экране — сразу, запрос — следом: состояние API ждём, а не читаем разом
    await expect.poll(() => api.busy.get("2026-10-20")?.source).toBe("vendor");

    await dayButton(page, 10).click();
    await expect(dayButton(page, 10)).toHaveAttribute("aria-pressed", "false");
    await expect.poll(() => api.busy.has("2026-10-10")).toBe(false);

    // aria-disabled, но нажимается: объясняет, почему день не освободить (Playwright такое сам не жмёт)
    await dayButton(page, 17).click({ force: true });
    await expect(page.getByRole("alert")).toHaveText(t.staffLocked);
    await expect(dayButton(page, 17)).toHaveAttribute("aria-pressed", "true");
    expect(api.busy.get("2026-10-17")?.source).toBe("staff");
    // Каждая правка — от версии календаря из прошлого ответа (If-Match)
    await expect
      .poll(() => api.calendarWrites)
      .toEqual(["PUT 2026-10-20 If-Match: 1", "DELETE 2026-10-10 If-Match: 2"]);
    expect(api.unexpected).toEqual([]);
  });

  test("календарь изменил кто-то другой: правка не затирает чужую, месяц перечитан, отметить заново", async ({
    page,
  }) => {
    const api = await start(page);
    await page.goto("/calendar");
    await expect(dayButton(page, 20)).toHaveAttribute("aria-pressed", "false");
    // Пока календарь открыт, отказ «занято» по другой заявке занял 25-е
    api.busy.set("2026-10-25", { day: "2026-10-25", source: "request_decline", requestId: REQUEST_LATE });
    api.calendar.version += 1;

    await dayButton(page, 20).click();
    await expect(page.getByRole("alert")).toHaveText(t.calendarConflict);
    await expect(dayButton(page, 25)).toHaveAttribute("aria-pressed", "true");
    await expect(dayButton(page, 20)).toHaveAttribute("aria-pressed", "false");
    expect(api.busy.has("2026-10-20")).toBe(false);
    await expectNoAxeViolations(page, "календарь: изменили");

    await dayButton(page, 20).click();
    await expect(dayButton(page, 20)).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect.poll(() => api.busy.get("2026-10-20")?.source).toBe("vendor");
    expect(api.calendarWrites).toEqual(["PUT 2026-10-20 If-Match: 1", "PUT 2026-10-20 If-Match: 2"]);
    expect(api.unexpected).toEqual([]);
  });

  test("площадка: карточка как в базе, без рейтинга", async ({ page }) => {
    const api = await start(page);
    await page.goto("/card");
    await expect(heading(page)).toHaveText(t.card);
    await expect(page.getByText("Lola zali").first()).toBeVisible();
    const text = await page.locator("main").innerText();
    expect(text).not.toMatch(/★|рейтинг|reyting|отзыв|sharh|брон|bron/i);
    await expectNoAxeViolations(page, "площадка");
    await expectHitAreas(page, "площадка", CONTROLS);
    expect(api.unexpected).toEqual([]);
  });

  test("фото: без галочки «лиц нет» файлы не выбрать; фото уходит сжатым и ждёт проверки; удаление — через подтверждение", async ({
    page,
  }) => {
    const api = await start(page);
    await page.goto("/card");
    await expect(heading(page)).toHaveText(t.card);
    const section = page.locator("section[aria-labelledby='photos-title']");
    const photos = section.locator(".photos img");
    await expect(photos).toHaveCount(4);
    await expect(section.getByText(t.noFacesWarning)).toBeVisible();
    await expect(section.getByText(fill(t.photosLimits, { min: 3, max: 10 }))).toBeVisible();

    // Галочка не отмечена заранее; без неё выбор файлов закрыт
    const ack = section.getByRole("checkbox", { name: t.noFacesAck });
    const input = section.locator('input[type="file"]');
    await expect(ack).not.toBeChecked();
    await expect(input).toBeDisabled();
    await expectNoAxeViolations(page, "площадка: фото");
    await expectHitAreas(page, "площадка: фото", CONTROLS);
    await ack.check();
    await expect(input).toBeEnabled();

    await input.setInputFiles({
      name: "zal.png",
      mimeType: "image/png",
      buffer: await pngFromCanvas(page, 800, 600),
    });
    await expect(photos).toHaveCount(5);
    // На сервер — перекодированный файл (WebP, где браузер умеет, иначе JPEG) и подтверждение
    expect(api.uploads).toHaveLength(1);
    expect(api.uploads[0]?.noFaces).toBe("1");
    expect(api.uploads[0]?.contentType).toMatch(/^image\/(webp|jpeg)$/);
    expect(api.uploads[0]?.bytes).toBeGreaterThan(0);
    await expect(section.locator(".photo-chip")).toHaveCount(2);
    await expect(section.getByRole("alert")).toHaveCount(0);
    // Подтверждение — про выбранные фото: для следующих — снова
    await expect(ack).not.toBeChecked();
    await expect(input).toBeDisabled();

    // Одобренное фото опубликованной площадки при минимуме не удалить — понятная причина
    await section.getByRole("button", { name: fill(t.photoDeleteLabel, { n: 1 }) }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(t.photoDeleteQ);
    await expectNoAxeViolations(page, "площадка: удаление фото");
    await dialog.getByRole("button", { name: t.photoDelete, exact: true }).click();
    await expect(dialog.getByRole("alert")).toHaveText(fill(t.photoDeleteBlocked, { min: 3 }));
    await dialog.getByRole("button", { name: t.cancel, exact: true }).click();
    await expect(dialog).toHaveCount(0);

    // Новое (ждёт проверки) — удаляется
    await section.getByRole("button", { name: fill(t.photoDeleteLabel, { n: 5 }) }).click();
    await dialog.getByRole("button", { name: t.photoDelete, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(photos).toHaveCount(4);
    expect(api.photos).toHaveLength(4);
    expect(api.unexpected).toEqual([]);
  });

  test("сотрудник площадки: календарь ведёт, карточку не меняет — ни фото, ни предложений", async ({
    page,
  }) => {
    const api = await start(page, { role: "member" });
    await page.goto("/card");
    await expect(heading(page)).toHaveText(t.card);
    await expect(page.getByText(t.venueNoteMember)).toBeVisible();
    await expect(page.locator(".photos img")).toHaveCount(4);
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    await expect(page.locator(".photo-delete")).toHaveCount(0);
    await expect(page.getByRole("button", { name: t.proposalStart })).toHaveCount(0);
    await expect(page.getByText(t.proposalOwnerOnly)).toBeVisible();
    await expectNoAxeViolations(page, "площадка: сотрудник площадки");
    await expectHitAreas(page, "площадка: сотрудник площадки", CONTROLS);

    await page.goto("/calendar");
    await dayButton(page, 20).click();
    await expect(dayButton(page, 20)).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => api.busy.get("2026-10-20")?.source).toBe("vendor");
    expect(api.ownerOnly).toEqual([]);
    expect(api.unexpected).toEqual([]);
  });

  test("изменения карточки: форма из набора контролов, предложение ждёт проверки, отзыв — через подтверждение", async ({
    page,
  }) => {
    const api = await start(page);
    await page.goto("/card");
    await expect(heading(page)).toHaveText(t.card);
    // Вход — общим адресом с app: vendor (в разработке StrictMode входит дважды)
    expect(api.signIns.length).toBeGreaterThan(0);
    for (const body of api.signIns) expect(body).toMatchObject({ app: "vendor" });

    await page.getByRole("button", { name: t.proposalStart }).click();
    const form = page.locator("form.proposal-form");
    await expect(form).toBeVisible();
    await expectNoAxeViolations(page, "изменения карточки: форма");
    await expectHitAreas(page, "изменения карточки: форма", CONTROLS);

    await form.getByLabel(t.priceFromLabel).fill("27 000 000");
    await form.getByRole("button", { name: t.proposalSubmit }).click();
    await expect(page.getByText(t.proposalSent)).toBeVisible();
    expect(api.revisions.map((r) => r.payload)).toEqual([{ price_from_uzs: 27_000_000 }]);
    await expectNoAxeViolations(page, "изменения карточки: на проверке");

    await page.getByRole("button", { name: t.proposalWithdraw }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(t.proposalWithdrawQ);
    await expectNoAxeViolations(page, "изменения карточки: отзыв");
    await dialog.getByRole("button", { name: t.proposalWithdraw }).click();
    await expect(page.getByRole("button", { name: t.proposalStart })).toBeVisible();
    expect(api.revisions.map((r) => r.status)).toEqual(["withdrawn"]);
    expect(api.unexpected).toEqual([]);
  });

  for (const path of ["/requests", "/calendar"]) {
    test(`${path}: фокус с клавиатуры виден`, async ({ page }) => {
      await start(page);
      await page.goto(path);
      await heading(page).waitFor();
      await expectVisibleFocus(page, path, 12);
    });
  }

  test("экраны без горизонтальной прокрутки", async ({ page }) => {
    await start(page);
    const width = page.viewportSize()?.width ?? 0;
    for (const path of ["/requests", `/requests/${REQUEST_NEW}`, "/calendar", "/card"]) {
      await page.goto(path);
      await heading(page).waitFor();
      const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
      expect.soft(scroll, path).toBeLessThanOrEqual(width);
    }
  });
});
