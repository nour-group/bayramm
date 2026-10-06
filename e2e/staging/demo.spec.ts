import { dictionaries } from "@bayramm/shared";
import { CATEGORIES } from "@bayramm/shared/categories";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { DEMO_VENUES } from "../../apps/api/src/demo/venues";
import { formatPhone } from "../../apps/web/src/format";
import { expectNoAxeViolations } from "../support/a11y";

/* Живой staging после seed демо-витрин (workflow «Demo data (staging)»): как их увидит
   человек — лендинг, каждый раздел каталога, каждая витрина раздела, «Связаться», язык.
   Витрины берутся из выдачи раздела, поэтому проверяется всё опубликованное, а демо-витрины
   из apps/api/src/demo/venues.ts обязаны быть в выдаче своего раздела (STAGING_DEMO=0 —
   без этого требования и без проверки картинок, например против локального демо-API).
   Фото, которое не загрузилось, приложение заменяет заглушкой (Photo.tsx), поэтому <img>
   на месте — уже признак, что воркер media его отдал. */

const ru = dictionaries.ru;
const uz = dictionaries.uz;
const DEMO = process.env.STAGING_DEMO !== "0";
// Картинки — с воркера media; у локального демо-API его нет (фото там — заглушки)
const MEDIA = DEMO;
const ENABLED = CATEGORIES.filter((c) => c.enabled)
  .sort((a, b) => a.sort - b.sort)
  .map((c) => c.code);
const catDesc = (code: string, lang: "ru" | "uz") =>
  (dictionaries[lang].catDesc as Readonly<Record<string, string | undefined>>)[code] ?? "";

// «Связаться» на staging ограничено 30 открытиями в минуту с адреса: окно открываем у первой
// витрины раздела на компьютере и у одной на телефоне
const CONTACTS_ON_PHONE = new Set(["zags"]);

test.describe.configure({ mode: "parallel" });

async function open(page: Page, path: string, ready: string): Promise<void> {
  await page.goto(path);
  // Пререндер лендинга заменяется первой отрисовкой приложения — ждём её
  await page.locator("[data-prerendered]").waitFor({ state: "detached" });
  await page.locator(ready).first().waitFor();
}

/** Каждая картинка из selector отдаётся (200, image/*): адрес — src, а не загруженный ли он */
async function expectImagesServed(page: Page, request: APIRequestContext, selector: string, label: string) {
  const urls = await page
    .locator(selector)
    .evaluateAll((imgs) =>
      imgs
        .map((img) => (img as HTMLImageElement).currentSrc || (img as HTMLImageElement).src)
        .filter(Boolean),
    );
  expect(urls.length, `${label}: картинки`).toBeGreaterThan(0);
  for (const url of new Set(urls)) {
    const res = await request.get(url);
    expect(res.status(), `${label}: ${url}`).toBe(200);
    expect(res.headers()["content-type"] ?? "", url).toMatch(/^image\//);
  }
}

async function expectNoSideScroll(page: Page, label: string) {
  const { doc, view } = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    view: window.innerWidth,
  }));
  expect(doc, `${label}: прокрутка вбок`).toBeLessThanOrEqual(view);
}

test("лендинг: все разделы с витринами, ни одного «скоро»", async ({ page }) => {
  await open(page, "/", ".landing .cat-tile");
  const tiles = page.locator(".landing .cat-tile");
  await expect(tiles).toHaveCount(ENABLED.length);
  await expect(page.locator(".landing .cat-tile.is-soon")).toHaveCount(0);
  if ((page.viewportSize()?.width ?? 0) >= 768) {
    // С планшета у плитки — что в разделе одной строкой
    for (const code of ENABLED) await expect(page.locator(".landing")).toContainText(catDesc(code, "ru"));
  }
  // Витрины из разных разделов на лендинге
  await expect(page.locator(".ln-cards .card").first()).toBeVisible();
  await expectNoSideScroll(page, "лендинг");
  await expectNoAxeViolations(page, "лендинг (staging)");
});

test("«Все»: витрины разных разделов вперемешку", async ({ page, request }) => {
  await open(page, "/catalog", ".cards .card");
  expect(await page.locator(".cards .card").count()).toBeGreaterThanOrEqual(12);
  if (MEDIA) await expectImagesServed(page, request, ".cards .card-photo img", "каталог «Все»");
  await expectNoSideScroll(page, "каталог «Все»");
});

for (const code of ENABLED) {
  test(`раздел ${code}: выдача и каждая витрина`, async ({ page, request }, info) => {
    test.setTimeout(180_000);
    const desktop = info.project.name.endsWith("desktop");
    await open(page, `/catalog?category=${code}`, ".cards .card");
    await expect(page.locator(".cat-lead")).toHaveText(catDesc(code, "ru"));
    if (MEDIA) await expectImagesServed(page, request, ".cards .card-photo img", `раздел ${code}`);
    await expectNoSideScroll(page, `раздел ${code}`);
    if (code === "zags" || code === "hall") await expectNoAxeViolations(page, `раздел ${code} (staging)`);

    const cards = await page.locator(".cards .card").evaluateAll((els) =>
      els.map((el) => ({
        name: el.querySelector(".card-name")?.textContent ?? "",
        href: el.querySelector("a.card-link")?.getAttribute("href") ?? "",
        price: el.querySelector(".card-price")?.textContent ?? "",
      })),
    );
    if (DEMO) {
      const demo = DEMO_VENUES.filter((v) => v.category === code).map((v) => v.name);
      expect(cards.map((c) => c.name)).toEqual(expect.arrayContaining(demo));
    }
    for (const card of cards) {
      // Цена обязательна и не «по запросу» (правила продукта)
      expect(card.price, card.name).toMatch(/\d/);
      expect(card.price.toLowerCase(), card.name).not.toContain("по запросу");
    }

    const summary: string[] = [];
    for (const [index, card] of cards.entries()) {
      const path = card.href.split("?")[0] ?? card.href;
      await open(page, path, ".venue-head h1");
      await expect(page.locator(".venue-head h1")).toHaveText(card.name);
      // Фото: не меньше трёх (правило продукта), первое загружено, остальные отдаются
      const photos = await page.locator(".gallery-item").count();
      expect(photos, `${card.name}: фото`).toBeGreaterThanOrEqual(3);
      if (MEDIA) {
        await expect
          .poll(() =>
            page
              .locator(".gallery-item img")
              .first()
              .evaluate(
                (img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0,
              ),
          )
          .toBe(true);
        await expectImagesServed(page, request, ".gallery-item img", card.name);
      }
      // Услуги с ценой; запрещённых слов нет
      const prices = await page.locator(".svcs .svc-price").allInnerTexts();
      expect(prices.length, `${card.name}: услуги`).toBeGreaterThan(0);
      for (const price of prices) expect(price, card.name).toMatch(/\d/);
      const text = (await page.locator("main").innerText()).toLowerCase();
      expect(text, card.name).not.toMatch(/забронир|по запросу/);
      // Заявка — со страницы витрины
      await expect(page.locator(`a[href^="${path}/request"]`).first()).toBeAttached();
      await expectNoSideScroll(page, card.name);

      // «Связаться»: номер — сразу, без заявки и входа
      if (index === 0 && (desktop || CONTACTS_ON_PHONE.has(code))) {
        await page.getByRole("button", { name: ru.contactBtn }).locator("visible=true").first().click();
        const dialog = page.getByRole("dialog");
        const tel = dialog.locator('a[href^="tel:"]');
        await expect(tel).toBeVisible();
        const phone = ((await tel.getAttribute("href")) ?? "").replace("tel:", "");
        await expect(dialog).toContainText(formatPhone(phone));
        const venue = DEMO_VENUES.find((v) => v.name === card.name);
        if (venue) expect(phone).toBe(venue.phone);
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
      }
      summary.push(`${card.name} — фото ${photos}, услуг ${prices.length}`);
    }
    console.log(`[${info.project.name}] ${code}: ${cards.length} витр.\n  ${summary.join("\n  ")}`);
  });
}

test("узбекский: раздел и витрина на uz", async ({ page }) => {
  await open(page, "/catalog?category=food&lang=uz", ".cards .card");
  await expect(page.locator("html")).toHaveAttribute("lang", "uz");
  await expect(page.locator(".cat-lead")).toHaveText(catDesc("food", "uz"));
  await page.locator(".cards .card a.card-link").first().click();
  await page.locator(".venue-head h1").waitFor();
  await expect(
    page.getByRole("button", { name: uz.contactBtn }).locator("visible=true").first(),
  ).toBeVisible();
});

test("занятый день: на дату из календаря витрина в выдаче — «занято»", async ({ page, request }, info) => {
  test.skip(!DEMO || !info.project.name.endsWith("desktop"), "по API демо-витрины, один раз");
  const hall = DEMO_VENUES.find((v) => v.category === "hall");
  expect(hall).toBeDefined();
  const res = await request.get(`/api/catalog/listings/${hall?.slug}`);
  expect(res.status()).toBe(200);
  const detail = (await res.json()) as { busyDates: string[] };
  const day = detail.busyDates[0];
  expect(day, "у демо-зала есть занятые дни").toBeDefined();
  await open(page, `/catalog?category=hall&date=${day}`, ".cards .card");
  await expect(page.locator(".cards .card.busy").filter({ hasText: hall?.name ?? "" })).toHaveCount(1);
});
