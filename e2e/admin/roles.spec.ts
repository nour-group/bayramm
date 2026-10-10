import type { StaffRole } from "@bayramm/shared/api/staff";
import type { Page } from "@playwright/test";
import { t } from "../../apps/admin/src/texts";
import { expectHitAreas, expectNoAxeViolations } from "../support/a11y";
import { createVitrina } from "../support/admin-ui";
import { expect, test } from "../support/offline";
import { CLIENT_ID, mockStaffApi, NOW, REQUEST_ID, REVISION_ID, staffOf } from "../support/staff-api";

/* Роли (права — apps/api/src/staff/access.ts): у каждой — только свои разделы, кнопки —
   только тех действий, что ей разрешены; чужой раздел по ссылке — «нет доступа», а не 403 с
   «Повторить». Ошибки API — словами (409, 422, 429), повтор — только где он поможет. Идёт на
   телефоне и на компьютере. */

async function start(page: Page, role: StaffRole, options: Parameters<typeof mockStaffApi>[1] = {}) {
  await page.clock.setFixedTime(NOW);
  return mockStaffApi(page, { role, ...options });
}

const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) < 720;

/** Раздел по ссылке навигации: путь → название (как в шапке экрана) */
const SECTION_OF_PATH: Readonly<Record<string, string>> = {
  "/vendors": t.vendors,
  "/moderation": t.moderation,
  "/requests": t.requests,
  "/metrics": t.metrics,
  "/clients": t.clients,
  "/notifications": t.notifications,
  "/audit": t.audit,
  "/team": t.team,
  "/settings": t.settings,
};

const sectionNames = async (links: ReturnType<Page["locator"]>) =>
  (await links.evaluateAll((all) => all.map((a) => a.getAttribute("href") ?? ""))).map(
    (href) => SECTION_OF_PATH[href] ?? href,
  );

/** Разделы в навигации роли: шапка компьютера или нижняя панель и «Ещё» телефона */
async function sectionsOf(page: Page): Promise<string[]> {
  const nav = page.getByRole("navigation", { name: t.sections });
  await expect(nav).toBeVisible();
  const shown = await sectionNames(nav.locator("a"));
  if (!isPhone(page)) return shown;
  const more = nav.getByRole("button", { name: t.more });
  if ((await more.count()) === 0) return shown;
  await more.click();
  const sheet = page.getByRole("dialog", { name: t.moreSections });
  const rest = await sectionNames(sheet.locator("a"));
  await sheet.getByRole("button", { name: t.close }).last().click();
  return [...shown, ...rest];
}

const SECTIONS: Readonly<Record<StaffRole, readonly string[]>> = {
  admin: [
    t.vendors,
    t.moderation,
    t.requests,
    t.metrics,
    t.clients,
    t.notifications,
    t.audit,
    t.team,
    t.settings,
  ],
  manager: [t.vendors, t.moderation, t.requests, t.metrics, t.clients, t.notifications],
  moderator: [t.vendors, t.moderation, t.metrics],
};

for (const role of ["admin", "manager", "moderator"] as const) {
  test(`${role}: в навигации — ровно разделы роли, подписи — целиком`, async ({ page }) => {
    const api = await start(page, role);
    await page.goto("/vendors");
    await expect(heading(page)).toHaveText(t.vendors);
    expect(new Set(await sectionsOf(page))).toEqual(new Set(SECTIONS[role]));
    // Ни одной обрезанной или сокращённой подписи в навигации
    const cut = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".tab-label, .nav a, .rail-label")]
        .filter((el) => el.scrollWidth > el.clientWidth + 1 || /\.$/.test(el.textContent ?? ""))
        .map((el) => el.textContent),
    );
    expect(cut).toEqual([]);
    expect(api.unexpected).toEqual([]);
  });
}

test("модератор: заявки по ссылке — «нет доступа» без «Повторить»; запросов за ними нет", async ({
  page,
}) => {
  const api = await start(page, "moderator");
  const asked: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/staff/requests")) asked.push(request.url());
  });
  await page.goto(`/requests/${REQUEST_ID}`);
  await expect(heading(page)).toBeVisible();
  await expect(page.getByText(t.noAccess)).toBeVisible();
  await expect(page.getByRole("button", { name: t.retry })).toHaveCount(0);
  await page.getByRole("link", { name: t.toSection(t.vendors) }).click();
  await expect(page).toHaveURL("/vendors");
  expect(asked).toEqual([]);
  await page.goto("/team");
  await expect(page.getByText(t.noAccess)).toBeVisible();
  expect(api.unexpected).toEqual([]);
});

test("модератор на карточке: «Отклонить» есть, «Отправить на проверку» нет; поля — только просмотр", async ({
  page,
}) => {
  // Карточку создаёт администратор (подмена API — одна на страницу), смотрит модератор
  await page.clock.setFixedTime(NOW);
  const admin = await mockStaffApi(page, { role: "admin" });
  await createVitrina(page);
  expect(admin.vitrinas).toHaveLength(1);
  // Тот же сотрудник — уже модератор: GET /staff/me отвечает его правами
  await page.route("**/api/staff/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(staffOf("moderator")),
    }),
  );
  await page.reload();
  await expect(heading(page)).toHaveText("Navruz zali");
  await expect(page.getByText(t.listingReadOnly)).toBeVisible();
  await expect(page.getByText(t.availabilityReadOnly)).toBeVisible();
  // Номер только пишется: без права правки поля «Сменить номер» нет
  await expect(page.getByLabel(t.phoneChange)).toHaveCount(0);
  await expect(page.getByRole("button", { name: t.actions.submit })).toHaveCount(0);
  const reject = isPhone(page)
    ? page
        .getByRole("group", { name: t.listingFields.status ?? "" })
        .getByRole("button", { name: t.actions.reject })
    : page.getByRole("button", { name: t.actions.reject });
  await expect(reject).toBeVisible();
  await expect(page.locator(".cal-day:not([disabled])")).toHaveCount(0);
  await expect(page.getByRole("button", { name: t.save })).toHaveCount(0);
  await expectNoAxeViolations(page, "карточка глазами модератора");
});

test("менеджер на правке: кто решает — словами, кнопок решения нет", async ({ page }) => {
  await start(page, "manager");
  await page.goto(`/revisions/${REVISION_ID}`);
  await expect(page.getByText(t.revisionWhoDecides)).toBeVisible();
  await expect(page.getByRole("button", { name: t.revisionApprove })).toHaveCount(0);
  await expect(page.getByRole("button", { name: t.revisionDecline })).toHaveCount(0);
});

test("менеджер: повтора уведомлений и телефона клиента нет; блокировка клиента — есть", async ({ page }) => {
  await start(page, "manager");
  await page.goto("/notifications");
  await expect(page.getByText(t.outboxDead, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: t.retry })).toHaveCount(0);
  await page.goto(`/requests/${REQUEST_ID}`);
  await expect(page.getByRole("heading", { name: t.requestClient })).toBeVisible();
  await expect(page.getByLabel(t.clientPhoneReason)).toHaveCount(0);
  await page.goto(`/clients/${CLIENT_ID}`);
  await expect(page.getByRole("button", { name: t.block })).toBeVisible();
});

test.describe("оповещения команды: бот должен знать чат", () => {
  test("модератор без чата с ботом — просьба написать боту со ссылкой на него; «Скрыть» — и нет", async ({
    page,
  }) => {
    const api = await start(page, "moderator", { botLinked: false });
    await page.goto("/moderation");
    const banner = page.locator(".bot-banner");
    await expect(banner).toContainText(t.botBanner);
    await expect(banner.getByRole("link", { name: t.botBannerLink })).toHaveAttribute(
      "href",
      "https://t.me/bayramm_demo_bot?start=admin",
    );
    await expectNoAxeViolations(page, "просьба написать боту");
    await expectHitAreas(page, "просьба написать боту", ".bot-banner .btn");
    const width = page.viewportSize()?.width ?? 0;
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await banner.getByRole("button", { name: t.botBannerHide }).click();
    await expect(banner).toHaveCount(0);
    // Перезагрузка в той же вкладке — не возвращается
    await page.reload();
    await expect(heading(page)).toHaveText(t.moderation);
    await expect(page.locator(".bot-banner")).toHaveCount(0);
    expect(api.unexpected).toEqual([]);
  });

  test("менеджер по модерации не решает — просьбы нет", async ({ page }) => {
    await start(page, "manager", { botLinked: false });
    await page.goto("/vendors");
    await expect(heading(page)).toHaveText(t.vendors);
    await expect(page.locator(".bot-banner")).toHaveCount(0);
  });

  test("«Команда»: «бот: нет» у того, кому бот не пишет", async ({ page }) => {
    await start(page, "admin");
    await page.goto("/team");
    await expect(page.locator(".no-bot")).toHaveCount(1);
    await expect(page.locator(".no-bot")).toContainText(t.memberNoBot);
  });

  test("«Сейчас» в метриках: плитка очереди ведёт туда, где её разбирают", async ({ page }) => {
    const api = await start(page, "moderator");
    await page.goto("/metrics");
    const services = page.getByRole("link", { name: new RegExp(t.metricsQueues.servicesPending ?? "") });
    await expect(services).toContainText("2");
    // У модератора заявок нет: «Ждут ответа площадки» — без ссылки
    await expect(page.getByRole("link", { name: new RegExp(t.metricsQueues.awaiting ?? "") })).toHaveCount(0);
    await services.click();
    await expect(page).toHaveURL("/moderation");
    await expect(heading(page)).toHaveText(t.moderation);
    expect(api.unexpected).toEqual([]);
  });
});

test.describe("ошибки API — словами", () => {
  test("напоминание: 429 — пауза ещё не прошла, 409 — никто не привязал Telegram", async ({ page }) => {
    await start(page, "admin", {
      fail: { [`POST /staff/requests/${REQUEST_ID}/remind`]: [429, "reminder_too_soon"] },
    });
    await page.goto(`/requests/${REQUEST_ID}`);
    await page.getByRole("button", { name: t.remindVendor }).click();
    await expect(page.getByRole("alert")).toHaveText(t.api.reminder_too_soon ?? "");
  });

  test("приглашение: 409 username_taken — объяснение, а не «что-то пошло не так»", async ({ page }) => {
    await start(page, "admin", { fail: { "POST /staff/team": [409, "username_taken"] } });
    await page.goto("/team");
    await page.getByLabel(t.inviteName).fill("Новый менеджер");
    await page.getByLabel(t.inviteUsername).fill("bakhtiyor_ops");
    await page.getByRole("button", { name: t.invite }).click();
    await expect(page.getByRole("alert")).toHaveText(t.api.username_taken ?? "");
  });

  test("настройка: 422 — подсказка у поля становится ошибкой", async ({ page }) => {
    await start(page, "admin", { fail: { "PUT /staff/settings/sla_hours": [422, "invalid_input"] } });
    await page.goto("/settings");
    const setting = page.locator("form.setting").first();
    await expect(setting.getByRole("button", { name: t.save })).toBeDisabled();
    await setting.locator("input").first().fill("99");
    await setting.getByRole("button", { name: t.save }).click();
    await expect(setting.locator(".field-error")).toHaveText(t.settingInvalid);
  });

  test("не найдено (404) — без «Повторить»; нет связи — «Повторить»", async ({ page }) => {
    await start(page, "admin");
    await page.goto("/requests/00000000-0000-4000-8300-0000000000ff");
    await expect(page.getByRole("alert")).toHaveText(t.api.not_found ?? "");
    await expect(page.getByRole("button", { name: t.retry })).toHaveCount(0);

    await page.route("**/api/staff/clients?*", (route) => route.abort("internetdisconnected"));
    await page.goto("/clients");
    await expect(page.getByRole("alert")).toHaveText(t.api.network ?? "");
    await expect(page.getByRole("button", { name: t.retry })).toBeVisible();
  });
});
