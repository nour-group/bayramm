import type { Page } from "@playwright/test";
import { t } from "../../apps/admin/src/texts";
import { expectHitAreas, expectNoAxeViolations } from "../support/a11y";
import { APPS } from "../support/account";
import { pick } from "../support/admin-ui";
import { expect, test } from "../support/offline";
import {
  CAR_REQUEST_ID,
  CLIENT_ID,
  mockStaffApi,
  NOW,
  REQUEST_ID,
  REVISION_ID,
  VENDOR_ID,
} from "../support/staff-api";
import { CAR_LISTING_ID } from "../support/staff-catalog";
import { horizontalOverflow } from "../support/web";

/* Как устроена панель: главный экран роли, один порядок разделов, путь к странице объекта
   (компьютер), фильтры и страница списка — в адресе (ссылку можно переслать, «назад» из
   объекта возвращает тот же список), длинные списки — страницами или «Показать ещё», переходы
   между объектами без тупиков (заявка → клиент, вендор → его заявки и журнал, витрина → сайт и
   её заявки), объект журнала — поиском. Телефон и компьютер. */

const CONTROLS = [
  ".btn",
  ".chip",
  "input:not([type=hidden])",
  "textarea",
  ".ui-select",
  ".ui-check",
  ".ui-switch",
  ".ui-radio",
  ".ui-icon-btn",
].join(", ");

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 720;
const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const rows = (page: Page) => page.locator(".rcards .rcard, tbody tr");
const crumbs = (page: Page) => page.getByRole("navigation", { name: t.crumbs });

async function start(page: Page, options: Parameters<typeof mockStaffApi>[1] = { seeded: true }) {
  await page.clock.setFixedTime(NOW);
  return mockStaffApi(page, options);
}

test.describe("главный экран и разделы", () => {
  test("администратор: корень — «Заявки»; разделы — в порядке нижней панели телефона", async ({ page }) => {
    const api = await start(page);
    await page.goto("/");
    await expect(page).toHaveURL("/requests");
    await expect(heading(page)).toHaveText(t.requests);
    if (!isPhone(page)) {
      const nav = page.getByRole("banner").getByRole("navigation", { name: t.sections });
      await expect(nav.getByRole("link")).toHaveText([
        new RegExp(`^${t.requests}`),
        new RegExp(`^${t.moderation}`),
        new RegExp(`^${t.vendors}`),
        new RegExp(`^${t.metrics}`),
        new RegExp(`^${t.clients}`),
        new RegExp(`^${t.notifications}`),
        new RegExp(`^${t.audit}`),
        new RegExp(`^${t.team}`),
        new RegExp(`^${t.settings}`),
      ]);
    }
    expect(api.unexpected).toEqual([]);
  });

  test("модератор: заявок не видит — корень и вход ведут в «Модерацию»", async ({ page }) => {
    const api = await start(page, { seeded: true, role: "moderator" });
    await page.goto("/");
    await expect(page).toHaveURL("/moderation");
    await expect(heading(page)).toHaveText(t.moderation);
    expect(api.queries.filter((q) => q.startsWith("requests"))).toEqual([]);
    expect(api.unexpected).toEqual([]);
  });
});

test.describe("путь к странице и переходы", () => {
  test("компьютер — путь над заголовком: витрина → вендор, заявка → вендор → витрина; телефон — без него", async ({
    page,
  }) => {
    const api = await start(page);
    await page.goto(`/requests/${CAR_REQUEST_ID}`);
    await expect(heading(page)).toBeVisible();
    if (isPhone(page)) {
      await expect(crumbs(page)).toHaveCount(0);
      expect(api.unexpected).toEqual([]);
      return;
    }
    await expect(crumbs(page).getByRole("link")).toHaveText([t.requests, "Lola · V101", "Oq kortej"]);
    await crumbs(page).getByRole("link", { name: "Oq kortej" }).click();
    await expect(page).toHaveURL(`/listings/${CAR_LISTING_ID}`);
    await expect(crumbs(page).getByRole("link")).toHaveText([t.vendors, "Lola · V101"]);
    await crumbs(page).getByRole("link", { name: "Lola · V101" }).click();
    await expect(page).toHaveURL(`/vendors/${VENDOR_ID}`);
    await expect(crumbs(page).getByRole("link")).toHaveText([t.vendors]);
    await expectNoAxeViolations(page, "вендор: путь к странице");
    expect(api.unexpected).toEqual([]);
  });

  test("заявка → клиент по коду; вендор → его заявки (поиск по коду) и журнал", async ({ page }) => {
    const api = await start(page);
    await page.goto(`/requests/${REQUEST_ID}`);
    // Бюджет с двумя границами — «от … до …»; кто менял статус — по имени
    await expect(page.getByText(/^от 30\s000\s000 сум до 50\s000\s000 сум$/)).toBeVisible();
    await expect(page.getByRole("region", { name: t.history })).toContainText(
      `Бахтиёр Рашидов · ${t.historyBy.vendor_user}`,
    );
    await page.getByRole("link", { name: t.requestClientOpen("C-00000000") }).click();
    await expect(page).toHaveURL(`/clients/${CLIENT_ID}`);
    await expect(heading(page)).toHaveText("Азиза Каримова");

    await page.goto(`/vendors/${VENDOR_ID}`);
    await expect(page.getByRole("link", { name: t.vendorJournal })).toHaveAttribute(
      "href",
      `/audit?type=vendor&object=${VENDOR_ID}`,
    );
    await page.getByRole("link", { name: t.vendorRequests }).click();
    await expect(page).toHaveURL("/requests?q=V101");
    await expect(page.getByRole("searchbox", { name: t.search })).toHaveValue("V101");
    expect(api.queries.at(-1)).toContain("q=V101");
    expect(api.unexpected).toEqual([]);
  });

  test("опубликованная витрина — «Открыть на сайте» в новой вкладке; «Заявки витрины» — список с её фильтром", async ({
    page,
  }) => {
    const api = await start(page);
    await page.goto(`/listings/${CAR_LISTING_ID}`);
    await expect(heading(page)).toHaveText("Oq kortej");
    const site = page.getByRole("link", { name: new RegExp(`^${t.listingOnSite}`) });
    await expect(site).toHaveAttribute("href", `${APPS.web}/venue/oq-kortej`);
    await expect(site).toHaveAttribute("target", "_blank");
    await page.getByRole("link", { name: t.listingRequests }).click();
    await expect(page).toHaveURL(`/requests?listingId=${CAR_LISTING_ID}`);
    await expect(rows(page)).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: `${t.reset}: ${t.requestsOfListing("Oq kortej")}` }),
    ).toBeVisible();
    expect(api.queries.at(-1)).toContain(`listingId=${CAR_LISTING_ID}`);
    expect(api.unexpected).toEqual([]);
  });

  test("предложение изменений: ссылки на видео — открываются наружу", async ({ page }) => {
    await start(page);
    await page.goto(`/revisions/${REVISION_ID}`);
    await expect(heading(page)).toBeVisible();
    const links = page.locator("a[href^='https://'][target=_blank]");
    for (const link of await links.all()) await expect(link).toHaveAttribute("rel", /noopener/);
  });
});

test.describe("фильтры в адресе", () => {
  test("заявки: фильтр срока — в адресе; «назад» из заявки — тот же список", async ({ page }) => {
    const api = await start(page);
    await page.goto("/requests");
    if (isPhone(page)) {
      await page.getByRole("button", { name: t.filters, exact: true }).click();
      const sheet = page.getByRole("dialog", { name: t.filters });
      await sheet.getByRole("radio", { name: t.slaLate }).check();
      await sheet.getByRole("button", { name: t.done }).click();
    } else {
      await page.getByRole("radio", { name: new RegExp(`^${t.slaLate}`) }).check();
    }
    await expect(page).toHaveURL("/requests?sla=late");
    await rows(page).first().getByRole("link").first().click();
    await expect(page).toHaveURL(`/requests/${REQUEST_ID}`);
    await page.goBack();
    await expect(page).toHaveURL("/requests?sla=late");
    if (isPhone(page)) await expect(page.getByRole("button", { name: `${t.filters} (1)` })).toBeVisible();
    else await expect(page.getByRole("radio", { name: new RegExp(`^${t.slaLate}`) })).toBeChecked();
    expect(api.queries.at(-1)).toContain("sla=late");
    expect(api.unexpected).toEqual([]);
  });

  test("ссылка с фильтром — сразу отфильтрованный список; пусто из-за фильтров — «Сбросить фильтры»", async ({
    page,
  }) => {
    const api = await start(page);
    await page.goto("/requests?status=deal");
    await expect(page.getByText(t.requestsFilteredEmpty)).toBeVisible();
    expect(api.queries.at(-1)).toContain("status=deal");
    await page.getByRole("button", { name: t.resetFilters }).click();
    await expect(page).toHaveURL("/requests");
    await expect(rows(page)).toHaveCount(2);
    expect(api.unexpected).toEqual([]);
  });

  test("вендоры: статус витрины — в адресе; поиск — без кнопки, как перестали печатать", async ({ page }) => {
    const api = await start(page);
    await page.goto("/vendors?status=active");
    if (isPhone(page))
      await expect(page.getByRole("button", { name: `${t.reset}: ${t.status.active}` })).toBeVisible();
    else await expect(page.getByRole("radio", { name: t.status.active })).toBeChecked();
    await expect.poll(() => api.queries.at(-1)).toContain("listingStatus=active");
    await page.getByRole("searchbox", { name: t.search }).fill("Lola");
    await expect(page).toHaveURL("/vendors?status=active&q=Lola");
    await expect.poll(() => api.queries.at(-1)).toContain("q=Lola");
    expect(api.unexpected).toEqual([]);
  });

  test("метрики: плитка просрочки — заявки «Требуют действия»; категория — в адресе", async ({ page }) => {
    const api = await start(page);
    await page.goto("/metrics?category=car");
    await expect(page.getByText(t.metricsCategoryFilter("Кортеж"))).toBeVisible();
    await page.getByRole("link", { name: new RegExp(t.metricsQueues.overdue ?? "") }).click();
    await expect(page).toHaveURL("/requests?sla=late");
    expect(api.unexpected).toEqual([]);
  });
});

test.describe("длинные списки", () => {
  test("заявки: компьютер — страницами (номер — в адресе), телефон — «Показать ещё» дописывает", async ({
    page,
  }) => {
    const api = await start(page, { seeded: true, manyRequests: 60 });
    await page.goto("/requests");
    await expect(rows(page)).toHaveCount(50);
    if (isPhone(page)) {
      await expect(page.getByText(t.shownOf(50, 62))).toBeVisible();
      await page.getByRole("button", { name: t.showMore }).click();
      await expect(rows(page)).toHaveCount(62);
      await expect(page.getByRole("button", { name: t.showMore })).toHaveCount(0);
      await expect(page.getByText(t.total(62))).toBeVisible();
    } else {
      const pager = page.getByRole("navigation", { name: t.pagerLabel });
      await expect(pager).toContainText(t.pagerRange(1, 50, 62));
      await pager.getByRole("button", { name: t.pagerNext }).click();
      await expect(rows(page)).toHaveCount(12);
      await expect(page).toHaveURL("/requests?page=2");
      await expect(pager).toContainText(t.pagerRange(51, 62, 62));
      // Страница — в адресе: из заявки «назад» — на ту же страницу
      await rows(page).first().getByRole("link").first().click();
      await page.goBack();
      await expect(page).toHaveURL("/requests?page=2");
      await expect(rows(page)).toHaveCount(12);
    }
    const width = page.viewportSize()?.width ?? 0;
    expect((await horizontalOverflow(page)).scrollWidth).toBeLessThanOrEqual(width);
    await expectNoAxeViolations(page, "заявки: длинный список");
    await expectHitAreas(page, "заявки: длинный список", CONTROLS);
    expect(api.unexpected).toEqual([]);
  });
});

test.describe("журнал: объект — поиском", () => {
  test("вид объекта — вендор; поиск по названию; в адрес уходит id, на экране — название", async ({
    page,
  }) => {
    const api = await start(page);
    await page.goto("/audit");
    if (isPhone(page)) await page.getByRole("button", { name: t.filters, exact: true }).click();
    const scope = isPhone(page) ? page.getByRole("dialog", { name: t.filters }) : page.locator("main");
    await expect(scope.getByRole("button", { name: new RegExp(`^${t.auditObject}`) })).toBeDisabled();
    await pick(page, t.auditType, t.auditTypes.vendor ?? "", scope);
    await scope.getByRole("button", { name: new RegExp(`^${t.auditObject}`) }).click();
    const search = page.getByRole("combobox", { name: t.auditObject });
    await expect(search).toBeFocused();
    await search.fill("Lo");
    await page.getByRole("option", { name: "Lola · V101" }).click();
    await expect(scope.getByRole("button", { name: new RegExp(`^${t.auditObject}`) })).toContainText(
      "Lola · V101",
    );
    await scope.getByRole("button", { name: t.auditApply }).click();
    await expect(page).toHaveURL(`/audit?type=vendor&object=${VENDOR_ID}`);
    expect(api.queries.some((q) => q.startsWith("vendors?") && q.includes("q=Lo"))).toBe(true);
    expect(api.unexpected).toEqual([]);
  });

  test("ссылка «Журнал вендора» — объект в фильтре назван, а не id", async ({ page }) => {
    const api = await start(page);
    await page.goto(`/audit?type=vendor&object=${VENDOR_ID}`);
    if (isPhone(page)) await page.getByRole("button", { name: `${t.filters} (2)` }).click();
    const scope = isPhone(page) ? page.getByRole("dialog", { name: t.filters }) : page.locator("main");
    await expect(scope.getByRole("button", { name: new RegExp(`^${t.auditObject}`) })).toContainText("Lola");
    expect(api.unexpected).toEqual([]);
  });
});
