// @vitest-environment jsdom
import { ImageError } from "@bayramm/media";
import { type CompressedPhoto, compressForUpload } from "@bayramm/media/browser";
import type {
  VendorAttention,
  VendorCalendar,
  VendorCalendarChange,
  VendorListing,
  VendorListingRef,
  VendorMe,
  VendorPhoto,
  VendorRequestDetail,
  VendorRequestItem,
  VendorRequestPage,
  VendorRevision,
  VendorRole,
} from "@bayramm/shared/api/vendor";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { attentionOf, attentionTotals, mergeListings } from "./attention";
import { tashkentToday } from "./format";
import { forgetAuthMethods } from "./hub";
import { vendorDict } from "./i18n";
import { decidedRevisions, revisionFields } from "./Proposal";

// Сжатие фото — канвас браузера, которого в jsdom нет: подменено в test-setup.ts

// React ждёт этот флаг, чтобы act() дожидался эффектов
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const REQUEST_ID = "eeeeeeee-0000-0000-0000-0000000000a1";
const LISTING_ID = "aaaaaaaa-0000-0000-0000-000000000101";
const HOUR = 3600 * 1000;

const NO_ATTENTION: VendorAttention = { services: 0, photos: 0, proposals: 0 };

const me = (
  locale: "ru" | "uz" = "ru",
  role: VendorRole = "owner",
  attention: VendorAttention = NO_ATTENTION,
): VendorMe => ({
  user: { id: "aaaaaaaa-0000-0000-0000-000000000011", locale, fullName: "Manager", role },
  vendor: { id: "aaaaaaaa-0000-0000-0000-000000000001", code: "V101", name: "Test LLC" },
  listings: [{ id: LISTING_ID, name: "Test Hall", status: "active", categoryCode: "hall", attention }],
});

function item(patch: Partial<VendorRequestItem> = {}): VendorRequestItem {
  const created = Date.now() - HOUR;
  return {
    id: REQUEST_ID,
    publicNo: 1001,
    status: "new",
    declineReason: null,
    listing: { id: LISTING_ID, name: "Test Hall", categoryCode: "hall" },
    occasionCode: "toy",
    eventDate: "2026-11-14",
    guests: 200,
    dayPart: null,
    details: {},
    budgetMinUzs: 40_000_000,
    budgetMaxUzs: 60_000_000,
    createdAt: new Date(created).toISOString(),
    sla: { dueAt: new Date(created + 12 * HOUR).toISOString(), firstResponseAt: null, breached: false },
    firstResponseBy: null,
    contactName: "Dilnoza",
    ...patch,
  };
}

const page = (items: VendorRequestItem[]): VendorRequestPage => ({
  items,
  nextCursor: null,
  counts: { new: items.length, active: 3, closed: 5 },
});

const detail = (patch: Partial<VendorRequestDetail> = {}): VendorRequestDetail => ({
  ...item({ status: "viewed" }),
  declineNote: null,
  contact: { name: "Dilnoza", phone: "+998001234567", comment: "Вечер, живая музыка" },
  history: [
    { status: "new", at: new Date(Date.now() - HOUR).toISOString(), by: "system" },
    { status: "viewed", at: new Date().toISOString(), by: "vendor_user" },
  ],
  ...patch,
});

type Handler = (init: RequestInit, url: URL) => { status?: number; body?: unknown } | undefined;
let routes: Record<string, Handler>;
let calls: { method: string; path: string; body: unknown; auth: string | null; headers: Headers }[];

function respond(status: number, body: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function fakeFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const url = new URL(String(input), "https://vendor.bayramm.uz");
  const method = init.method ?? "GET";
  const headers = new Headers(init.headers);
  calls.push({
    method,
    path: url.pathname + url.search,
    // Фото уходит файлом, остальное — JSON
    body: typeof init.body === "string" ? JSON.parse(init.body) : (init.body ?? undefined),
    auth: headers.get("Authorization"),
    headers,
  });
  const handler = routes[`${method} ${url.pathname}`];
  const result = handler?.(init, url);
  if (!result) return respond(404, { error: { code: "not_found", message: "Not found" } });
  return respond(result.status ?? 200, result.body);
}

function defaultRoutes(locale: "ru" | "uz" = "ru"): Record<string, Handler> {
  return {
    // Имя бота кабинет берёт отсюда же (GET /telegram/bot ему не нужен)
    "GET /api/auth/methods": () => ({
      body: { telegram: { bot: "bayramm_test_bot", loginDomain: null }, phone: false, apps: {} },
    }),
    "POST /api/auth/telegram": () => ({
      body: { token: "t".repeat(43), expiresAt: "2026-10-01T20:00:00Z" },
    }),
    "GET /api/vendor/me": () => ({ body: me(locale) }),
    "PATCH /api/vendor/me": (init) => ({ body: me(JSON.parse(String(init.body)).locale) }),
    "GET /api/vendor/requests": () => ({ body: page([item()]) }),
    [`GET /api/vendor/requests/${REQUEST_ID}`]: () => ({ body: detail() }),
    [`POST /api/vendor/requests/${REQUEST_ID}/call`]: () => ({ status: 204 }),
    [`PATCH /api/vendor/requests/${REQUEST_ID}`]: (init) => ({
      body: item({
        status: JSON.parse(String(init.body)).status,
        sla: { ...item().sla, firstResponseAt: new Date().toISOString() },
      }),
    }),
  };
}

interface FakeWebApp {
  initData: string;
  initDataUnsafe: object;
  ready: ReturnType<typeof vi.fn>;
  expand: ReturnType<typeof vi.fn>;
  openTelegramLink: ReturnType<typeof vi.fn>;
  BackButton: {
    show: ReturnType<typeof vi.fn>;
    hide: ReturnType<typeof vi.fn>;
    onClick: ReturnType<typeof vi.fn>;
    offClick: ReturnType<typeof vi.fn>;
  };
}

function insideTelegram(): FakeWebApp {
  const webApp: FakeWebApp = {
    initData: "query_id=1&user=%7B%7D&auth_date=1&hash=abc",
    initDataUnsafe: {},
    ready: vi.fn(),
    expand: vi.fn(),
    openTelegramLink: vi.fn(),
    BackButton: { show: vi.fn(), hide: vi.fn(), onClick: vi.fn(), offClick: vi.fn() },
  };
  Object.assign(window, { Telegram: { WebApp: webApp } });
  return webApp;
}

let container: HTMLDivElement;
let root: Root;

async function mount(path: string) {
  window.history.replaceState(null, "", path);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<App />));
  // Вход, профиль и данные экрана — несколько обещаний подряд
  for (let i = 0; i < 5; i++) await act(async () => {});
}

async function flush() {
  for (let i = 0; i < 5; i++) await act(async () => {});
}

const heading = () => container.querySelector("h1")?.textContent;
const byText = <T extends Element>(selector: string, text: string) =>
  [...container.querySelectorAll<T>(selector)].find((el) => el.textContent?.includes(text));
const click = async (el: Element | undefined) => {
  if (!el) throw new Error("элемент не найден");
  await act(async () => (el as HTMLElement).click());
  await flush();
};

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  // В jsdom scrollTo не реализован и пишет об этом в консоль
  window.scrollTo = () => {};
  routes = defaultRoutes();
  calls = [];
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  forgetAuthMethods();
});

/** Ширина окна: раскладку выбирает layout.ts (в jsdom нет matchMedia — по innerWidth) */
const resize = (width: number) =>
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });

afterEach(() => {
  resize(390);
  act(() => root.unmount());
  container.remove();
  delete (window as { Telegram?: unknown }).Telegram;
  for (const script of document.head.querySelectorAll("script")) script.remove();
  vi.unstubAllGlobals();
});

describe("вход в кабинет", () => {
  it("вне Telegram — что это за кабинет, как получить доступ, «Войти» (хаб) и бот; без попытки входа", async () => {
    await mount("/requests");
    expect(heading()).toBe("Кабинет партнёров Bayramm");
    const welcome = container.querySelector(".welcome")?.textContent ?? "";
    for (const point of ["Заявки клиентов", "12 часов на ответ", "Календарь занятости", "Витрина и услуги"])
      expect(welcome).toContain(point);
    expect(welcome).toContain("Кабинет открывает команда Bayramm");
    expect(welcome).toContain("Регистрации здесь нет");
    // Чисел о площадке и партнёрах нет — только обещание 12 часов
    expect(welcome.match(/\d+/g)).toEqual(["12", "12"]);
    expect(byText("button", "Войти")).toBeDefined();
    const link = byText<HTMLAnchorElement>("a", "Открыть бота");
    expect(link?.getAttribute("href")).toBe("https://t.me/bayramm_test_bot?start=partner");
    expect(calls.some((c) => c.method === "POST" && c.path.startsWith("/api/auth"))).toBe(false);
    // Имя бота — из того же ответа GET /auth/methods: один запрос на страницу, без /telegram/bot
    expect(calls.filter((c) => c.path === "/api/auth/methods")).toHaveLength(1);
    expect(calls.some((c) => c.path === "/api/telegram/bot")).toBe(false);
    expect(container.querySelector("nav")).toBeNull();
    expect(document.title).toBe("кабинет партнёра · Bayramm");
    // Вход на сайте по телефону здесь не включён (API не сказало иного) — о нём ни слова
    expect(container.textContent).not.toContain("по номеру");
    // Вне Telegram SDK с telegram.org не грузится
    expect(document.head.querySelector("script")).toBeNull();
  });

  it("вне Telegram, вход по телефону на сайте включён — его и называем", async () => {
    routes["GET /api/auth/methods"] = () => ({
      body: { telegram: { bot: "bayramm_test_bot", loginDomain: null }, phone: true, apps: {} },
    });
    await mount("/requests");
    await flush();
    expect(container.textContent).toContain("по номеру, который вы дали менеджеру");
  });

  it("открыт из Telegram, а SDK не загрузился — ошибка и «Повторить», а не «откройте из бота»", async () => {
    await mount("/requests#tgWebAppData=x&tgWebAppVersion=8.0");
    const script = document.head.querySelector<HTMLScriptElement>("script");
    expect(script?.src).toBe("https://telegram.org/js/telegram-web-app.js");
    await act(async () => script?.dispatchEvent(new Event("error")));
    await flush();
    expect(heading()).toBe("Не удалось войти");
    expect(byText("button", "Повторить")).toBeDefined();
  });

  it("в Telegram — вход по initData, SDK готов, заявки с токеном сессии", async () => {
    const webApp = insideTelegram();
    await mount("/");
    expect(webApp.ready).toHaveBeenCalled();
    expect(webApp.expand).toHaveBeenCalled();
    const login = calls.find((c) => c.path === "/api/auth/telegram");
    expect(login?.body).toEqual({ initData: webApp.initData, app: "vendor" });
    // Устаревший адрес входа кабинета больше не вызывается
    expect(calls.some((c) => c.path === "/api/auth/vendor/telegram")).toBe(false);
    expect(calls.find((c) => c.path === "/api/vendor/me")?.auth).toBe(`Bearer ${"t".repeat(43)}`);
    expect(window.location.pathname).toBe("/requests");
    expect(heading()).toBe("Заявки");
    expect(container.querySelector("nav.tabbar")).not.toBeNull();
  });

  it("Telegram не привязан — «сначала привяжите», ссылка в бота открывается внутри Telegram", async () => {
    const webApp = insideTelegram();
    routes["POST /api/auth/telegram"] = () => ({
      status: 403,
      body: { error: { code: "vendor_not_linked", message: "x" } },
    });
    await mount("/requests");
    expect(heading()).toBe("Сначала привяжите номер");
    // Внутри Telegram хаб не предлагаем: вход — по кнопке бота
    expect(byText("button", "Войти другим аккаунтом")).toBeUndefined();
    await click(byText("a", "Открыть бота"));
    expect(webApp.openTelegramLink).toHaveBeenCalledWith("https://t.me/bayramm_test_bot?start=partner");
    expect(calls.some((c) => c.path.startsWith("/api/vendor/"))).toBe(false);
  });

  it("доступ отключён — отдельный текст", async () => {
    insideTelegram();
    routes["POST /api/auth/telegram"] = () => ({
      status: 403,
      body: { error: { code: "vendor_disabled", message: "x" } },
    });
    await mount("/requests");
    expect(heading()).toBe("Доступ отключён");
  });

  it("API не ответило — ошибка и «Повторить»", async () => {
    insideTelegram();
    let fail = true;
    routes["POST /api/auth/telegram"] = () =>
      fail
        ? { status: 503, body: { error: { code: "service_unavailable", message: "x" } } }
        : defaultRoutes()["POST /api/auth/telegram"]?.({}, new URL("https://x"));
    await mount("/requests");
    expect(heading()).toBe("Не удалось войти");
    fail = false;
    await click(byText("button", "Повторить"));
    expect(heading()).toBe("Заявки");
  });

  it("нет связи — полоса «нет подключения»; вернулась — вход повторяется сам", async () => {
    insideTelegram();
    let fail = true;
    routes["POST /api/auth/telegram"] = () =>
      fail
        ? { status: 503, body: { error: { code: "service_unavailable", message: "x" } } }
        : defaultRoutes()["POST /api/auth/telegram"]?.({}, new URL("https://x"));
    await mount("/requests");
    expect(heading()).toBe("Не удалось войти");
    await act(async () => void window.dispatchEvent(new Event("offline")));
    expect(container.querySelector(".ui-net")?.textContent).toContain("Нет подключения к интернету");
    fail = false;
    await act(async () => void window.dispatchEvent(new Event("online")));
    await flush();
    expect(heading()).toBe("Заявки");
    expect(container.querySelector(".ui-net")?.textContent).toBe("Связь вернулась.");
  });

  it("язык после входа — из профиля вендора; переключение сохраняется в профиле", async () => {
    insideTelegram();
    routes = defaultRoutes("uz");
    await mount("/requests");
    expect(heading()).toBe("Soʻrovlar");
    expect(document.documentElement.lang).toBe("uz");
    await click(container.querySelector('button[lang="ru"]') ?? undefined);
    expect(heading()).toBe("Заявки");
    expect(calls.find((c) => c.method === "PATCH" && c.path === "/api/vendor/me")?.body).toEqual({
      locale: "ru",
    });
  });
});

describe("заявки", () => {
  beforeEach(() => {
    insideTelegram();
  });

  it("список: вкладки со счётчиками, имя, гости, бюджет, счётчик 12 часов; без телефона", async () => {
    await mount("/requests");
    const tabs = [...container.querySelectorAll(".pills .pill")].map((b) => b.textContent);
    expect(tabs).toEqual(["Новые1", "В работе3", "Закрытые5"]);
    const card = container.querySelector(".rq");
    expect(card?.getAttribute("href")).toBe(`/requests/${REQUEST_ID}`);
    expect(card?.textContent).toContain("Dilnoza");
    expect(card?.textContent).toContain("Свадьба · 14 ноября, сб");
    expect(card?.textContent).toContain("200 гостей");
    expect(card?.textContent).toContain("40–60 млн сум");
    expect(card?.textContent).toMatch(/Осталось 1[01] ч/);
    expect(container.textContent).not.toContain("+998");
    expect(container.textContent).toContain("Мы обещаем клиенту ответ за 12 часов");
  });

  it("витрина одна — список и карточка заявки её не называют: ни категории, ни имени", async () => {
    await mount("/requests");
    expect(container.querySelector(".rq")).not.toBeNull();
    expect(container.querySelector(".rq-vitrina, .rq .chip-cat")).toBeNull();
    await click(container.querySelector(".rq") ?? undefined);
    expect(heading()).toBe("Заявка № 1001");
    expect(container.querySelector(".fact-vitrina, .request .chip-cat")).toBeNull();
    expect(container.querySelector(".facts")?.textContent).not.toContain("Test Hall");
  });

  it("история: открытие заявки — «Просмотрена», а не «Ждёт ответа» (так назван статус)", async () => {
    await mount(`/requests/${REQUEST_ID}`);
    expect([...container.querySelectorAll(".history-status")].map((el) => el.textContent)).toEqual([
      "Новая",
      "Просмотрена",
    ]);
    // Статус рядом с заголовком — прежний
    expect(container.querySelector(".detail-top .chip")?.textContent).toBe("Ждёт ответа");
  });

  it("просроченная — пометка «Просрочено» и сколько сверх срока", async () => {
    const created = Date.now() - 14 * HOUR;
    routes["GET /api/vendor/requests"] = () => ({
      body: page([
        item({
          createdAt: new Date(created).toISOString(),
          sla: { dueAt: new Date(created + 12 * HOUR).toISOString(), firstResponseAt: null, breached: true },
        }),
      ]),
    });
    await mount("/requests");
    expect(container.querySelector(".rq-late .chip-late")?.textContent).toBe("Просрочено");
    expect(container.textContent).toMatch(/Просрочено на 2 ч/);
  });

  it("вкладка — запрос с tab; пусто — пустое состояние", async () => {
    routes["GET /api/vendor/requests"] = (_, url) => ({
      body:
        url.searchParams.get("tab") === "closed"
          ? { ...page([]), counts: { new: 0, active: 0, closed: 0 } }
          : page([item()]),
    });
    await mount("/requests");
    await click(byText("button", "Закрытые"));
    expect(calls.at(-1)?.path).toBe("/api/vendor/requests?tab=closed");
    expect(container.textContent).toContain("Закрытых заявок пока нет");
  });

  it("карточка: кнопка «Назад» Telegram, телефон сразу, звонок — в журнал", async () => {
    const webApp = { WebApp: insideTelegram() };
    await mount("/requests");
    await click(container.querySelector(".rq") ?? undefined);
    expect(window.location.pathname).toBe(`/requests/${REQUEST_ID}`);
    expect(heading()).toBe("Заявка № 1001");
    expect(webApp.WebApp.BackButton.show).toHaveBeenCalled();

    const phone = container.querySelector<HTMLAnchorElement>('a[href="tel:+998001234567"]') ?? undefined;
    expect(phone?.textContent).toBe("+998 00 123 45 67");
    expect(phone?.getAttribute("aria-label")).toBe("Позвонить +998 00 123 45 67");
    // Кнопка «Назад» — у Telegram, своя ссылка не дублирует её
    expect(byText("a", "Назад")).toBeUndefined();
    expect(container.textContent).toContain("Вечер, живая музыка");
    await click(phone);
    expect(
      calls.some((c) => c.method === "POST" && c.path === `/api/vendor/requests/${REQUEST_ID}/call`),
    ).toBe(true);

    // «Назад» Telegram возвращает к списку
    const onBack = webApp.WebApp.BackButton.onClick.mock.calls.at(-1)?.[0] as () => void;
    await act(async () => onBack());
    await flush();
    expect(window.location.pathname).toBe("/requests");
    expect(webApp.WebApp.BackButton.hide).toHaveBeenCalled();
  });

  it("«Я связался» → статус «Вы связались», дальше «Договорились» / «Не подошло»", async () => {
    await mount(`/requests/${REQUEST_ID}`);
    const reads = () =>
      calls.filter((c) => c.method === "GET" && c.path === `/api/vendor/requests/${REQUEST_ID}`);
    expect(reads()).toHaveLength(1);
    await click(byText("button", "Я связался с клиентом"));
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ status: "contacted" });
    expect(container.querySelector(".detail-top .chip")?.textContent).toBe("Вы связались");
    expect(byText("button", "Договорились")).toBeDefined();
    expect(byText("button", "Не подошло")).toBeDefined();
    // Без повторного чтения карточки: телефон клиента не читается лишний раз
    expect(reads()).toHaveLength(1);
  });

  it("отказ: причина обязательна, «занято» предупреждает о календаре", async () => {
    await mount(`/requests/${REQUEST_ID}`);
    await click(byText("button", "Отказать"));
    const submit = container.querySelector<HTMLButtonElement>('form.decline button[type="submit"]');
    expect(submit?.disabled).toBe(true);
    await click(byText("label", "Занято на эту дату")?.querySelector("input") ?? undefined);
    expect(container.textContent).toContain("Дата станет занятой в календаре.");
    expect(submit?.disabled).toBe(false);
    await click(submit ?? undefined);
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
      status: "declined",
      declineReason: "busy",
    });
  });

  it("фокус не теряется: форма отказа — на первую причину, «Отмена» и ответ — на новые действия", async () => {
    await mount(`/requests/${REQUEST_ID}`);
    await click(byText("button", "Отказать"));
    expect((document.activeElement as HTMLInputElement | null)?.name).toBe("decline-reason");
    await click(byText("form.decline button", "Отмена"));
    expect(document.activeElement?.textContent).toBe("Я связался с клиентом");
    await click(byText("button", "Я связался с клиентом"));
    expect(document.activeElement?.textContent).toBe("Договорились");
  });

  it("переход устарел (409) — сообщение и свежая карточка", async () => {
    routes[`PATCH /api/vendor/requests/${REQUEST_ID}`] = () => ({
      status: 409,
      body: { error: { code: "illegal_transition", message: "x" } },
    });
    await mount(`/requests/${REQUEST_ID}`);
    routes[`GET /api/vendor/requests/${REQUEST_ID}`] = () => ({
      body: detail({ status: "withdrawn", contact: null, contactName: null }),
    });
    await click(byText("button", "Я связался с клиентом"));
    expect(container.textContent).toContain("Клиент отозвал согласие — контакты скрыты");
    expect(container.querySelector(".detail-top .chip")?.textContent).toBe("Клиент отозвал");
  });

  it("чужая или несуществующая заявка — «не найдена»", async () => {
    routes[`GET /api/vendor/requests/${REQUEST_ID}`] = () => ({
      status: 404,
      body: { error: { code: "not_found", message: "Not found" } },
    });
    await mount(`/requests/${REQUEST_ID}`);
    expect(heading()).toBe("Заявка не найдена");
  });

  it("сессия кончилась посреди работы — «откройте заново»", async () => {
    await mount("/requests");
    routes[`GET /api/vendor/requests/${REQUEST_ID}`] = () => ({
      status: 401,
      body: { error: { code: "unauthorized", message: "x" } },
    });
    await click(container.querySelector(".rq") ?? undefined);
    expect(heading()).toBe("Сессия закончилась");
  });
});

describe("календарь", () => {
  const today = tashkentToday();
  const month = today.slice(0, 7);
  const calendar = (): VendorCalendar => ({
    listingId: LISTING_ID,
    month,
    today,
    maxDay: "2099-12-31",
    busy: [],
    requestDays: [],
    version: 7,
    mode: "day",
    parallelCapacity: 1,
    parts: [],
    bookings: [],
  });
  const calendarPath = `/api/vendor/listings/${LISTING_ID}/calendar`;
  const writes = () =>
    calls
      .filter((c) => (c.method === "PUT" || c.method === "DELETE") && c.path.startsWith(`${calendarPath}/`))
      .map((c) => `${c.method} ${c.path.slice(-10)} ${c.headers.get("If-Match")}`);
  const days = () => [...container.querySelectorAll<HTMLButtonElement>(".cal-day")];

  /**
   * Календарь «как в базе»: версия растёт на каждой правке; правка не от текущей версии —
   * 409 calendar_conflict, как у API. Сегодня — первое число: весь месяц можно отмечать
   */
  function serverCalendar() {
    const server = { version: 7, busy: new Map<string, VendorCalendar["busy"][number]>() };
    routes[`GET ${calendarPath}`] = () => ({
      body: { ...calendar(), today: `${month}-01`, busy: [...server.busy.values()], version: server.version },
    });
    for (const day of [`${month}-01`, `${month}-02`, `${month}-03`]) {
      const write =
        (busy: boolean): Handler =>
        (init) => {
          if (Number(new Headers(init.headers).get("If-Match")) !== server.version) {
            return { status: 409, body: { error: { code: "calendar_conflict", message: "x" } } };
          }
          server.version += 1;
          if (busy) server.busy.set(day, { day, source: "vendor", requestId: null });
          else server.busy.delete(day);
          const change: VendorCalendarChange = {
            day,
            part: null,
            busy: server.busy.get(day) ?? null,
            version: server.version,
          };
          return { body: change };
        };
      routes[`PUT ${calendarPath}/${day}`] = write(true);
      routes[`DELETE ${calendarPath}/${day}`] = write(false);
    }
    return server;
  }

  beforeEach(() => {
    insideTelegram();
    routes[`GET ${calendarPath}`] = () => ({ body: calendar() });
    routes[`PUT ${calendarPath}/${today}`] = () => ({
      body: { day: today, busy: { day: today, source: "vendor", requestId: null }, version: 8 },
    });
  });

  it("месяц по Ташкенту; нажатие на сегодня — день занят (PUT от версии календаря), прошлое неактивно", async () => {
    await mount("/calendar");
    expect(heading()).toBe("Календарь");
    expect(calls.find((c) => c.path.includes("/calendar"))?.path).toBe(`${calendarPath}?month=${month}`);
    const day = container.querySelector<HTMLButtonElement>(".cal-today");
    expect(day?.getAttribute("aria-pressed")).toBe("false");
    await click(day ?? undefined);
    expect(writes()).toEqual([`PUT ${today} 7`]);
    expect(container.querySelector(".cal-today")?.getAttribute("aria-pressed")).toBe("true");
    if (Number(today.slice(8)) > 1) {
      expect(container.querySelector<HTMLButtonElement>(".cal-day")?.disabled).toBe(true);
    }
  });

  it("правки подряд уходят по очереди: каждая — от версии из прошлого ответа", async () => {
    const server = serverCalendar();
    await mount("/calendar");
    // Два нажатия, не дожидаясь ответа на первое
    await act(async () => {
      days()[0]?.click();
      days()[1]?.click();
    });
    await flush();
    expect(writes()).toEqual([`PUT ${month}-01 7`, `PUT ${month}-02 8`]);
    expect(server.version).toBe(9);
    expect(days()[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(days()[1]?.getAttribute("aria-pressed")).toBe("true");
    // Освободить — тоже от последней версии
    await click(days()[0]);
    expect(writes().at(-1)).toBe(`DELETE ${month}-01 9`);
    expect(days()[0]?.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("календарь успели изменить (409) — месяц перечитан, сообщение; отметить заново можно", async () => {
    const server = serverCalendar();
    await mount("/calendar");
    // Пока календарь был открыт, менеджер закрыл третье число
    const third = `${month}-03`;
    server.busy.set(third, { day: third, source: "staff", requestId: null });
    server.version = 12;
    const reads = () => calls.filter((c) => c.method === "GET" && c.path.startsWith(`${calendarPath}?`));
    expect(reads()).toHaveLength(1);

    await click(days()[0]);
    await flush();
    expect(writes()).toEqual([`PUT ${month}-01 7`]);
    expect(reads()).toHaveLength(2);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Календарь изменили — обновили. Проверьте и отметьте ещё раз.",
    );
    // На экране — как в базе: своя отметка не прошла, чужая видна
    expect(days()[0]?.getAttribute("aria-pressed")).toBe("false");
    expect(days()[2]?.getAttribute("aria-pressed")).toBe("true");

    await click(days()[0]);
    expect(writes().at(-1)).toBe(`PUT ${month}-01 12`);
    expect(days()[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("день, закрытый менеджером, не освобождается — подсказка", async () => {
    routes[`GET /api/vendor/listings/${LISTING_ID}/calendar`] = () => ({
      body: { ...calendar(), busy: [{ day: today, source: "staff", requestId: null }] },
    });
    await mount("/calendar");
    await click(container.querySelector(".cal-today") ?? undefined);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(container.textContent).toContain("Этот день закрыл менеджер");
  });

  it("не сохранилось — день возвращается как был, причина — словами по коду ответа", async () => {
    routes[`PUT /api/vendor/listings/${LISTING_ID}/calendar/${today}`] = () => ({
      status: 503,
      body: { error: { code: "service_unavailable", message: "x" } },
    });
    await mount("/calendar");
    await click(container.querySelector(".cal-today") ?? undefined);
    expect(container.querySelector(".cal-today")?.getAttribute("aria-pressed")).toBe("false");
    expect(container.textContent).toContain("Сервер временно недоступен. Попробуйте через минуту.");
  });

  it("прошедший день (сервер — date_out_of_range): не «не удалось», а что случилось", async () => {
    routes[`PUT /api/vendor/listings/${LISTING_ID}/calendar/${today}`] = () => ({
      status: 422,
      body: { error: { code: "date_out_of_range", message: "x" } },
    });
    await mount("/calendar");
    await click(container.querySelector(".cal-today") ?? undefined);
    expect(container.textContent).toContain("Прошедший день не изменить");
  });
});

const LISTING: VendorListing = {
  id: LISTING_ID,
  slug: "test-hall",
  name: "Test Hall",
  status: "active",
  statusReason: null,
  categoryCode: "hall",
  districtCode: "chilonzor",
  address: { ru: "ул. Тестовая, 1", uz: "Test koʻchasi, 1" },
  description: { ru: "Большой зал", uz: "Katta zal" },
  priceFromUzs: 150_000,
  priceUnit: "per_guest",
  capMin: 50,
  capMax: 300,
  photos: [],
  phone: "+998000000999",
  blockers: [],
  photoLimits: { min: 3, max: 10 },
  attributes: {},
  missingAttributes: [],
  videoLinks: [],
  parallelCapacity: 1,
  services: [],
};

const REVISION_ID = "cccccccc-0000-0000-0000-0000000000f1";
const revision = (patch: Partial<VendorRevision> = {}): VendorRevision => ({
  id: REVISION_ID,
  status: "pending",
  submittedAt: new Date().toISOString(),
  decidedAt: null,
  decisionReason: null,
  payload: { description_ru: "Большой зал на 300 гостей" },
  byTeam: false,
  ...patch,
});

describe("изменения карточки", () => {
  const revisionsPath = `/api/vendor/listings/${LISTING_ID}/revisions`;
  const posted = () => calls.filter((c) => c.method === "POST" && c.path === revisionsPath);
  const field = (label: string) => {
    const id = byText<HTMLLabelElement>("label", label)?.htmlFor;
    return (id ? container.querySelector<HTMLInputElement>(`[id="${id}"]`) : null) ?? undefined;
  };
  const type = async (input: HTMLInputElement | HTMLTextAreaElement | undefined, value: string) => {
    if (!input) throw new Error("поле не найдено");
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
    await act(async () => {
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  beforeEach(() => {
    insideTelegram();
    routes[`GET /api/vendor/listings/${LISTING_ID}`] = () => ({ body: LISTING });
    routes[`GET ${revisionsPath}`] = () => ({ body: { items: [] } });
  });

  it("предложение уходит только с изменёнными полями и ждёт проверки; клиент видит прежнюю карточку", async () => {
    routes[`POST ${revisionsPath}`] = (init) => ({
      status: 201,
      body: revision({ payload: JSON.parse(String(init.body)) }),
    });
    await mount("/card");
    await click(byText("button", "Предложить изменения"));
    // Цены здесь нет: она — из услуг
    expect(field("Цена от, сум")).toBeUndefined();
    // Ничего не изменили — без запроса
    await click(byText("button", "Отправить на проверку"));
    expect(posted()).toEqual([]);
    expect(container.textContent).toContain("Вы ничего не изменили.");

    await type(field("Название"), "New Hall");
    // Поле витрины категории (зал): в правке — только изменённый ключ
    await type(field("Мест на парковке"), "120");
    await click(byText("button", "Отправить на проверку"));
    expect(posted().map((c) => c.body)).toEqual([{ name: "New Hall", attributes: { parking_spaces: 120 } }]);
    expect(container.textContent).toContain("Предложение на проверке");
    const pending = container.querySelector(".proposal-pending")?.textContent ?? "";
    expect(pending).toContain("New Hall");
    expect(pending).toContain("Мест на парковке");
    expect(pending).toContain("120");
    expect(container.textContent).toContain("Отправлено на проверку");
    // Карточка — прежняя: название не изменилось
    expect(container.querySelector(".venue-name")?.textContent).toBe("Test Hall");
  });

  it("фокус не теряется: форма — на первое поле, «Отмена» — на «Предложить», отправка — на заголовок", async () => {
    routes[`POST ${revisionsPath}`] = (init) => ({
      status: 201,
      body: revision({ payload: JSON.parse(String(init.body)) }),
    });
    await mount("/card");
    await click(byText("button", "Предложить изменения"));
    expect(document.activeElement).toBe(field("Название"));
    await click(byText(".proposal-form button", "Отмена"));
    expect(document.activeElement?.textContent).toBe("Предложить изменения");
    await click(byText("button", "Предложить изменения"));
    await type(field("Название"), "New Hall");
    await click(byText("button", "Отправить на проверку"));
    expect(document.activeElement?.id).toBe("proposal-title");
  });

  it("поле витрины вне границ категории — ошибка у поля без запроса", async () => {
    await mount("/card");
    await click(byText("button", "Предложить изменения"));
    // Залов — от 1 до 20 (конфигурация категории)
    await type(field("Сколько залов"), "50");
    await click(byText("button", "Отправить на проверку"));
    expect(posted()).toEqual([]);
    expect(field("Сколько залов")?.getAttribute("aria-invalid")).toBe("true");
    expect(container.textContent).toContain("Проверьте выделенные поля.");
  });

  it("неверные поля от сервера подсвечиваются", async () => {
    routes[`POST ${revisionsPath}`] = () => ({
      status: 422,
      body: { error: { code: "invalid_input", message: "x", details: ["name"] } },
    });
    await mount("/card");
    await click(byText("button", "Предложить изменения"));
    await type(field("Название"), "X");
    await click(byText("button", "Отправить на проверку"));
    expect(field("Название")?.getAttribute("aria-invalid")).toBe("true");
    expect(container.textContent).toContain("Проверьте выделенные поля.");
  });

  it("открытое предложение: видно, что предложено; отозвать — через подтверждение", async () => {
    routes[`GET ${revisionsPath}`] = () => ({ body: { items: [revision()] } });
    routes[`POST ${revisionsPath}/${REVISION_ID}/withdraw`] = () => ({
      body: revision({ status: "withdrawn" }),
    });
    await mount("/card");
    expect(byText("button", "Предложить изменения")).toBeUndefined();
    await click(byText("button", "Отозвать предложение"));
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain("Отозвать предложение?");
    await click(
      [...(dialog?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Отозвать предложение"),
    );
    expect(
      calls.some((c) => c.method === "POST" && c.path === `${revisionsPath}/${REVISION_ID}/withdraw`),
    ).toBe(true);
    expect(byText("button", "Предложить изменения")).toBeDefined();
  });

  it("отказ команды — причина видна; можно предложить заново", async () => {
    routes[`GET ${revisionsPath}`] = () => ({
      body: {
        items: [
          revision({
            status: "declined",
            decidedAt: new Date().toISOString(),
            decisionReason: "Цена ниже, чем в договоре",
          }),
        ],
      },
    });
    await mount("/card");
    expect(container.textContent).toContain(
      "Прошлое предложение отклонено. Причина: Цена ниже, чем в договоре",
    );
    expect(byText("button", "Предложить изменения")).toBeDefined();
  });

  it("предложение команды Bayramm: видно, что предложено и что ждёт модератора; отозвать нельзя", async () => {
    routes[`GET ${revisionsPath}`] = () => ({ body: { items: [revision({ byTeam: true })] } });
    await mount("/card");
    expect(container.querySelector(".proposal-pending")?.textContent).toContain(
      "Команда Bayramm предложила изменения",
    );
    expect(container.querySelector(".proposal-pending")?.textContent).toContain("Большой зал на 300 гостей");
    expect(byText("button", "Отозвать предложение")).toBeUndefined();
    expect(byText("button", "Предложить изменения")).toBeUndefined();
  });

  it("сотрудник площадки видит открытое предложение, но не отзывает его", async () => {
    routes["GET /api/vendor/me"] = () => ({ body: me("ru", "member") });
    routes[`GET ${revisionsPath}`] = () => ({ body: { items: [revision()] } });
    await mount("/card");
    expect(container.textContent).toContain("Предложение на проверке");
    expect(byText("button", "Отозвать предложение")).toBeUndefined();
  });

  it("сотрудник площадки: формы нет, кто меняет витрину — сказано один раз, вверху экрана", async () => {
    routes["GET /api/vendor/me"] = () => ({ body: me("ru", "member") });
    await mount("/card");
    expect(byText("button", "Предложить изменения")).toBeUndefined();
    const text = container.textContent ?? "";
    expect(text).toContain("Менять её и услуги может только владелец кабинета.");
    expect(text.match(/владелец кабинета/g)).toHaveLength(1);
    // Ни предложения, ни решения по прошлому — блока изменений нет
    expect(container.querySelector(".proposal")).toBeNull();
  });
});

describe("площадка", () => {
  const listingPath = `/api/vendor/listings/${LISTING_ID}`;
  const photosPath = `${listingPath}/photos`;
  const photo = (n: number, moderation: VendorPhoto["moderation"] = "approved"): VendorPhoto => ({
    id: `dddddddd-0000-0000-0000-${String(n).padStart(12, "0")}`,
    width: 1600,
    height: 1200,
    moderation,
    declineReason: moderation === "declined" ? "На фото виден человек" : null,
    isCover: n === 1,
    src: `https://media.example/640/p${n}.webp`,
    srcSet: `https://media.example/320/p${n}.webp 320w`,
  });
  let photos: VendorPhoto[];
  const reads = () => calls.filter((c) => c.method === "GET" && c.path === listingPath);
  const uploads = () => calls.filter((c) => c.method === "POST" && c.path === photosPath);
  const alert = () => container.querySelector('[role="alert"]')?.textContent ?? "";
  const images = () => container.querySelectorAll(".photos img").length;
  const checkbox = () =>
    byText("label", "Подтверждаю: на выбранных фото нет лиц")?.querySelector("input") ?? undefined;
  const fileInput = () => container.querySelector<HTMLInputElement>('input[type="file"]') ?? undefined;
  const file = (name: string, type = "image/jpeg") => new File([new Uint8Array([1, 2, 3])], name, { type });
  const compressed = () =>
    ({ blob: new Blob([new Uint8Array([9, 9, 9])], { type: "image/webp" }) }) as CompressedPhoto;
  const choose = async (files: File[]) => {
    const input = fileInput();
    if (!input) throw new Error("поле выбора файлов не найдено");
    Object.defineProperty(input, "files", { configurable: true, value: files });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    await flush();
    await flush();
  };

  beforeEach(() => {
    insideTelegram();
    photos = [photo(1), photo(2), photo(3, "pending")];
    routes[`GET ${listingPath}/revisions`] = () => ({ body: { items: [] } });
    routes[`GET ${listingPath}`] = () => ({ body: { ...LISTING, photos } });
    routes[`POST ${photosPath}`] = () => {
      const next = photo(photos.length + 1, "pending");
      photos = [...photos, next];
      return { status: 201, body: next };
    };
    for (const { id } of photos) {
      routes[`DELETE ${photosPath}/${id}`] = () => {
        photos = photos.filter((p) => p.id !== id);
        return { status: 204 };
      };
    }
    vi.mocked(compressForUpload).mockReset();
    vi.mocked(compressForUpload).mockResolvedValue(compressed());
  });

  it("витрина как в базе: подсказка про проверку и менеджера, код вендора; текстовых полей нет", async () => {
    await mount("/card");
    expect(heading()).toBe("Витрина");
    expect(container.textContent).toContain(
      "Так витрину видят клиенты. Всё, что вы меняете, сначала проверяет команда Bayramm.",
    );
    // Цена «от» — из услуг, сказано один раз, рядом — переход к услугам; списка услуг второй раз нет
    expect(container.textContent).toContain("Самая низкая цена среди одобренных услуг.");
    expect(container.textContent?.match(/«Услуги»|из услуг/g) ?? []).toEqual([]);
    expect(byText<HTMLAnchorElement>(".venue a", "К услугам")?.getAttribute("href")).toBe("/services");
    expect(container.querySelector(".venue .packages")).toBeNull();
    expect(container.querySelector(".venue .chip-cat")?.textContent).toBe("Тойхона");
    expect(container.textContent).toContain("Эти данные меняет менеджер Bayramm — назовите ему код V101.");
    expect(container.textContent).toContain("от 150 000 сум за гостя");
    expect(container.textContent).toContain("50–300 гостей");
    expect(container.textContent).toContain("Чиланзар");
    expect(container.textContent).not.toMatch(/★|рейтинг|отзыв/i);
    // Карточка не правится на месте: только галочка «лиц нет» и выбор фото
    expect(
      container.querySelector('input:not([type="checkbox"]):not([type="file"]), textarea, select'),
    ).toBeNull();
  });

  it("изменения витрины — выше фото и сведений; «проверит команда» сказано один раз", async () => {
    await mount("/card");
    const proposal = container.querySelector(".proposal");
    const grid = container.querySelector(".venue-grid");
    expect(proposal).not.toBeNull();
    // Предложение на проверке, отказ с причиной и «Предложить» — не двумя экранами ниже фото
    expect(
      proposal && grid && proposal.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(container.querySelector(".proposal .note")?.textContent).toBe(
      "Предложить можно: название, описание, данные витрины и ссылки на видео.",
    );
    expect(container.textContent?.match(/проверяет команда|его проверит/g) ?? []).toHaveLength(1);
  });

  it("фото: предупреждение про лица на виду, без галочки файлы не выбрать; загрузка — после сжатия, с подтверждением", async () => {
    await mount("/card");
    expect(container.textContent).toContain("На фото не должно быть людей и лиц");
    expect(container.textContent).toContain("Для публикации — не меньше 3 фото, всего до 10.");
    expect(container.querySelector(".photos .photo-chip")?.textContent).toBe("на проверке");
    // Галочка не отмечена заранее; без неё выбор файлов недоступен
    expect(checkbox()?.checked).toBe(false);
    expect(fileInput()?.disabled).toBe(true);
    await click(checkbox());
    expect(checkbox()?.checked).toBe(true);
    expect(fileInput()?.disabled).toBe(false);

    const picked = [file("a.jpg"), file("b.heic", "image/heic")];
    await choose(picked);
    // Каждый файл — через сжатие (без метаданных), на сервер — по одному
    expect(vi.mocked(compressForUpload).mock.calls.map(([f]) => f)).toEqual(picked);
    expect(uploads()).toHaveLength(2);
    for (const upload of uploads()) {
      expect(upload.headers.get("X-No-Faces")).toBe("1");
      expect(upload.headers.get("content-type")).toBe("image/webp");
      expect(upload.body).toBeInstanceOf(Blob);
    }
    // Карточка перечитана: новые фото — на проверке
    expect(reads()).toHaveLength(2);
    expect(images()).toBe(5);
    expect(container.querySelectorAll(".photos .photo-chip")).toHaveLength(3);
    // Подтверждение — про выбранные фото: для следующих — снова
    expect(checkbox()?.checked).toBe(false);
    expect(fileInput()?.disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("не загрузилось — по каждому файлу понятная причина", async () => {
    vi.mocked(compressForUpload)
      .mockRejectedValueOnce(new ImageError("decode_failed"))
      .mockResolvedValueOnce(compressed())
      .mockResolvedValueOnce(compressed());
    let answer = 0;
    routes[`POST ${photosPath}`] = () =>
      answer++ === 0
        ? {
            status: 422,
            body: { error: { code: "invalid_image", message: "x", details: ["dimensions_too_small"] } },
          }
        : { status: 409, body: { error: { code: "duplicate_photo", message: "x" } } };
    await mount("/card");
    await click(checkbox());
    await choose([file("a.heic", "image/heic"), file("b.jpg"), file("c.jpg")]);
    expect(uploads()).toHaveLength(2);
    expect(alert()).toContain("a.heic: браузер не смог открыть файл");
    expect(alert()).toContain("b.jpg: слишком маленькое фото");
    expect(alert()).toContain("c.jpg: это фото уже есть на витрине");
  });

  it("больше максимума не загрузить: лишние файлы не уходят, при полной карточке выбора нет", async () => {
    photos = Array.from({ length: 8 }, (_, i) => photo(i + 1));
    await mount("/card");
    await click(checkbox());
    await choose([file("a.jpg"), file("b.jpg"), file("c.jpg")]);
    expect(uploads()).toHaveLength(2);
    expect(alert()).toContain("Ещё 1 фото не загружено: на витрине не больше 10.");
    // Теперь их 10 — вместо выбора файлов подсказка
    expect(fileInput()).toBeUndefined();
    expect(container.textContent).toContain("Загружено максимум — 10 фото");
  });

  it("удаление — через подтверждение; опубликованная площадка не останется без минимума фото", async () => {
    const [first, , third] = photos;
    routes[`DELETE ${photosPath}/${first?.id}`] = () => ({
      status: 422,
      body: { error: { code: "publish_blocked", message: "x", details: ["photos"] } },
    });
    await mount("/card");
    const dialog = () => document.querySelector('[role="alertdialog"]');
    const dialogButton = (text: string) =>
      [...(dialog()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === text);

    await click(container.querySelector('button[aria-label="Удалить фото 1"]') ?? undefined);
    expect(dialog()?.textContent).toContain("Удалить фото?");
    await click(dialogButton("Удалить"));
    expect(dialog()?.textContent).toContain("Опубликованной витрине нужно не меньше 3 одобренных фото");
    expect(images()).toBe(3);
    await click(dialogButton("Отмена"));
    expect(dialog()).toBeNull();

    await click(container.querySelector('button[aria-label="Удалить фото 3"]') ?? undefined);
    await click(dialogButton("Удалить"));
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual([
      `${photosPath}/${first?.id}`,
      `${photosPath}/${third?.id}`,
    ]);
    expect(dialog()).toBeNull();
    expect(images()).toBe(2);
    // Кнопки удалённого фото нет — фокус на заголовке раздела
    expect(document.activeElement?.id).toBe("photos-title");
  });

  it("сотрудник площадки фото только смотрит: ни загрузки, ни удаления", async () => {
    routes["GET /api/vendor/me"] = () => ({ body: me("ru", "member") });
    await mount("/card");
    expect(images()).toBe(3);
    expect(container.textContent).toContain("Менять её и услуги может только владелец кабинета");
    expect(container.textContent).not.toContain("На фото не должно быть людей");
    expect(container.querySelector("input, textarea, select")).toBeNull();
    expect(container.querySelector(".photo-delete")).toBeNull();
    expect(byText("button", "Предложить изменения")).toBeUndefined();
  });
});

describe("раскладка", () => {
  beforeEach(() => {
    insideTelegram();
  });

  it("телефон: нижняя панель из пяти разделов; у «Заявок» — число новых, словами для диктора", async () => {
    await mount("/requests");
    const tabs = [...container.querySelectorAll("nav.tabbar a")];
    expect(tabs.map((a) => a.getAttribute("href"))).toEqual([
      "/requests",
      "/calendar",
      "/card",
      "/services",
      "/account",
    ]);
    expect(tabs[0]?.getAttribute("aria-current")).toBe("page");
    expect(tabs[0]?.querySelector(".nav-count")?.textContent).toBe("1");
    expect(tabs[0]?.querySelector(".sr-only")?.textContent).toBe("новых: 1");
    expect(container.querySelector(".side, .rail")).toBeNull();
  });

  it("планшет: колонка разделов слева, экраны по одному", async () => {
    resize(800);
    await mount(`/requests/${REQUEST_ID}`);
    expect(container.querySelector("nav.rail")).not.toBeNull();
    expect(container.querySelector("nav.tabbar")).toBeNull();
    expect(heading()).toBe("Заявка № 1001");
    expect(container.querySelector(".rq-list")).toBeNull();
  });

  it("компьютер: боковая панель; заявки — список и карточка рядом, без самооткрытия", async () => {
    resize(1280);
    await mount("/requests");
    expect(container.querySelector("aside.side nav.side-nav")).not.toBeNull();
    expect(container.querySelector("nav.tabbar, nav.rail")).toBeNull();
    expect(container.querySelector(".side-vendor")?.textContent).toContain("V101");
    // Заявку сами не открываем: открытие делает её просмотренной
    expect(container.textContent).toContain("Выберите заявку");
    expect(calls.some((c) => c.path === `/api/vendor/requests/${REQUEST_ID}`)).toBe(false);

    const lists = () => calls.filter((c) => c.method === "GET" && c.path.startsWith("/api/vendor/requests?"));
    expect(lists()).toHaveLength(1);
    await click(container.querySelector(".rq") ?? undefined);
    expect(window.location.pathname).toBe(`/requests/${REQUEST_ID}`);
    // Список остаётся, открытая заявка в нём отмечена; заголовок карточки — h2 под h1
    expect(heading()).toBe("Заявки");
    expect(container.querySelector("h2#request-title")?.textContent).toBe("Заявка № 1001");
    expect(container.querySelector(".rq")?.getAttribute("aria-current")).toBe("page");
    expect(byText("a", "Назад")).toBeUndefined();
    // Фокус — на заголовок открытой заявки (для диктора)
    expect(document.activeElement?.id).toBe("request-title");
    // Открытие сделало заявку просмотренной — список перечитан тихо
    expect(lists()).toHaveLength(2);

    await click(byText("button", "Я связался с клиентом"));
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ status: "contacted" });
    expect(lists()).toHaveLength(3);
    // id заголовков не повторяются
    const ids = [...container.querySelectorAll("[id]")].map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("компьютер: заявка по ссылке с другой вкладки — список переходит на её вкладку", async () => {
    resize(1280);
    await mount(`/requests/${REQUEST_ID}`);
    // Открытая заявка — «Ждёт ответа», то есть во вкладке «В работе»
    expect(calls.some((c) => c.path === "/api/vendor/requests?tab=active")).toBe(true);
    expect(container.querySelector(".pill[aria-pressed='true']")?.textContent).toContain("В работе");
  });
});

describe("фокус после перехода", () => {
  it("экран, который ещё грузится, получает фокус на заголовок, когда тот появится", async () => {
    insideTelegram();
    await mount("/requests");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Карточка заявки отвечает не сразу: экран пока без заголовка
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith(REQUEST_ID)) await gate;
      return fakeFetch(input, init);
    });
    await click(container.querySelector(".rq") ?? undefined);
    expect(container.querySelector("h1")).toBeNull();
    release();
    await flush();
    expect(heading()).toBe("Заявка № 1001");
    expect(document.activeElement?.tagName).toBe("H1");
  });
});

describe("календарь: подписи дней", () => {
  it("диктор слышит всё, что видно: кем занят день, есть ли заявка, сегодня ли", async () => {
    insideTelegram();
    const today = tashkentToday();
    const month = today.slice(0, 7);
    const other = `${month}-${today.slice(8) === "28" ? "27" : "28"}`;
    routes[`GET /api/vendor/listings/${LISTING_ID}/calendar`] = () => ({
      body: {
        listingId: LISTING_ID,
        month,
        today,
        maxDay: "2099-12-31",
        busy: [
          { day: today, source: "staff", requestId: null },
          { day: other, source: "request_decline", requestId: REQUEST_ID },
        ],
        requestDays: [other],
        version: 1,
        mode: "day",
        parallelCapacity: 1,
        parts: [],
        bookings: [],
      } satisfies VendorCalendar,
    });
    await mount("/calendar");
    const label = (day: string) =>
      container.querySelector(`.cal-day[aria-label^="${Number(day.slice(8))} "]`)?.getAttribute("aria-label");
    expect(label(today)).toMatch(/, закрыл менеджер, сегодня$/);
    expect(label(other)).toMatch(/, занято отказом, есть заявка$/);
    expect(container.querySelector(".cal-today")?.getAttribute("aria-current")).toBe("date");
    expect(container.querySelector(".cal-aside")?.textContent).toContain("Обозначения");
  });
});

describe("аккаунт", () => {
  beforeEach(() => {
    routes["GET /api/me"] = () => ({ body: { roles: { client: null, vendors: [], staff: null } } });
    routes["GET /api/auth/methods"] = () => ({
      body: {
        telegram: { bot: "bayramm_test_bot", loginDomain: null },
        phone: false,
        apps: {
          web: "https://bayramm.example",
          vendor: "https://vendor.example",
          admin: "https://admin.example",
        },
      },
    });
  });

  it("кабинет, код для менеджера и роль; язык — в профиле; в Telegram выхода нет", async () => {
    insideTelegram();
    await mount("/account");
    expect(heading()).toBe("Аккаунт");
    const text = container.textContent ?? "";
    expect(text).toContain("Test LLC");
    expect(text).toContain("Ваш код для менеджера: V101");
    expect(text).toContain("Вы — владелец кабинета");
    expect(byText("button", "Выйти")).toBeUndefined();
    await click(byText("label", "Oʻzbekcha")?.querySelector("input") ?? undefined);
    expect(calls.find((c) => c.method === "PATCH" && c.path === "/api/vendor/me")?.body).toEqual({
      locale: "uz",
    });
    expect(heading()).toBe("Hisob");
  });

  it("сотрудник площадки — так и сказано: карточку меняет владелец", async () => {
    insideTelegram();
    routes["GET /api/vendor/me"] = () => ({ body: me("ru", "member") });
    await mount("/account");
    expect(container.textContent).toContain("Вы — сотрудник площадки");
  });
});

describe("сессия кончилась в браузере", () => {
  it("«войдите снова» через сайт, а не «откройте из бота»", async () => {
    window.sessionStorage.setItem("bayramm.vendor.session", "s".repeat(43));
    routes["GET /api/vendor/me"] = () => ({
      status: 401,
      body: { error: { code: "unauthorized", message: "x" } },
    });
    await mount("/requests");
    expect(heading()).toBe("Сессия закончилась");
    expect(container.textContent).toContain("Войдите снова — через сайт Bayramm.");
    expect(byText("button", "Войти")).toBeDefined();
  });
});

describe("что ждёт партнёра", () => {
  const listingPath = `/api/vendor/listings/${LISTING_ID}`;
  const REJECTED: VendorAttention = { services: 2, photos: 1, proposals: 1 };
  const tab = (href: string) => container.querySelector(`nav.tabbar a[href="${href}"]`);
  const mePath = "/api/vendor/me";
  const meReads = () => calls.filter((c) => c.method === "GET" && c.path === mePath);
  const decided = (n: number, patch: Partial<VendorRevision> = {}): VendorRevision =>
    revision({
      id: `cccccccc-0000-0000-0000-${String(n).padStart(12, "0")}`,
      status: "declined",
      submittedAt: new Date(Date.now() - n * 86_400_000).toISOString(),
      decidedAt: new Date(Date.now() - n * 86_400_000 + 3_600_000).toISOString(),
      decisionReason: `Причина ${n}`,
      payload: { name: "New Hall" },
      ...patch,
    });
  const photoOf = (
    n: number,
    moderation: VendorPhoto["moderation"],
    declineReason: string | null = null,
  ) => ({
    id: `dddddddd-0000-0000-0000-${String(n).padStart(12, "0")}`,
    width: 1600,
    height: 1200,
    moderation,
    declineReason,
    isCover: n === 1,
    src: `https://media.example/640/p${n}.webp`,
    srcSet: `https://media.example/320/p${n}.webp 320w`,
  });

  beforeEach(() => {
    insideTelegram();
    routes[`GET ${listingPath}`] = () => ({ body: LISTING });
    routes[`GET ${listingPath}/revisions`] = () => ({ body: { items: [] } });
  });

  it("значки у «Витрины» и «Услуг»: число отказов и слова для диктора; у остальных разделов их нет", async () => {
    routes[`GET ${mePath}`] = () => ({ body: me("ru", "owner", REJECTED) });
    await mount("/requests");
    // «Витрина» — фото и предложение (1 + 1), «Услуги» — отклонённые услуги
    expect(tab("/card")?.querySelector(".nav-count")?.textContent).toBe("2");
    expect(tab("/card")?.querySelector(".sr-only")?.textContent).toBe("требует внимания: 2");
    expect(tab("/services")?.querySelector(".nav-count")?.textContent).toBe("2");
    expect(tab("/services")?.querySelector(".sr-only")?.textContent).toBe("требует внимания: 2");
    // Число — текстом, а не только цветом; значок «Заявок» прежний — новые заявки
    expect(tab("/card")?.querySelector(".nav-count")?.getAttribute("aria-hidden")).toBe("true");
    expect(tab("/requests")?.querySelector(".sr-only")?.textContent).toBe("новых: 1");
    expect(tab("/calendar")?.querySelector(".nav-count")).toBeNull();
    expect(tab("/account")?.querySelector(".nav-count")).toBeNull();
  });

  it("отказов нет — значков у «Витрины» и «Услуг» нет", async () => {
    await mount("/requests");
    expect(container.querySelectorAll("nav.tabbar .nav-count")).toHaveLength(1);
    expect(tab("/card")?.querySelector(".nav-count")).toBeNull();
    expect(tab("/services")?.querySelector(".nav-count")).toBeNull();
  });

  it("узбекский: «eʼtibor talab qiladi»", async () => {
    routes[`GET ${mePath}`] = () => ({ body: me("uz", "owner", { services: 3, photos: 0, proposals: 0 }) });
    await mount("/requests");
    expect(tab("/services")?.querySelector(".sr-only")?.textContent).toBe("eʼtibor talab qiladi: 3");
    expect(tab("/card")?.querySelector(".nav-count")).toBeNull();
  });

  it("партнёр удалил отклонённое фото — значок пересчитан по свежему GET /vendor/me", async () => {
    let photos = [
      photoOf(1, "approved"),
      photoOf(2, "approved"),
      photoOf(3, "declined", "На фото виден человек"),
    ];
    routes[`GET ${listingPath}`] = () => ({ body: { ...LISTING, photos } });
    routes[`GET ${mePath}`] = () => ({
      body: me("ru", "owner", {
        services: 0,
        photos: photos.filter((p) => p.moderation === "declined").length,
        proposals: 0,
      }),
    });
    routes[`DELETE ${listingPath}/photos/${photoOf(3, "declined").id}`] = () => {
      photos = photos.filter((p) => p.moderation !== "declined");
      return { status: 204 };
    };
    await mount("/card");
    expect(tab("/card")?.querySelector(".nav-count")?.textContent).toBe("1");
    const before = meReads().length;

    await click(container.querySelector('button[aria-label="Удалить фото 3"]') ?? undefined);
    const confirm = [
      ...(document.querySelector('[role="alertdialog"]')?.querySelectorAll("button") ?? []),
    ].find((b) => b.textContent === "Удалить");
    await click(confirm);
    expect(meReads().length).toBeGreaterThan(before);
    expect(tab("/card")?.querySelector(".nav-count")).toBeNull();
  });

  it("вошёл в раздел — значки перечитаны: команда могла решить, пока партнёр был в другом месте", async () => {
    let attention: VendorAttention = NO_ATTENTION;
    routes[`GET ${mePath}`] = () => ({ body: me("ru", "owner", attention) });
    await mount("/requests");
    expect(tab("/services")?.querySelector(".nav-count")).toBeNull();
    expect(meReads()).toHaveLength(1);

    attention = { services: 1, photos: 0, proposals: 0 };
    await click(tab("/services") ?? undefined);
    expect(meReads()).toHaveLength(2);
    expect(tab("/services")?.querySelector(".nav-count")?.textContent).toBe("1");
    // Календарь значков не показывает и ничего не перечитывает
    await click(tab("/calendar") ?? undefined);
    expect(meReads()).toHaveLength(2);
  });

  it("отклонённое фото: причина модератора под снимком и что делать; без причины — просто «отклонено»", async () => {
    routes[`GET ${listingPath}`] = () => ({
      body: {
        ...LISTING,
        photos: [
          photoOf(1, "approved"),
          photoOf(2, "declined", "На фото виден человек"),
          photoOf(3, "declined", null),
          photoOf(4, "pending"),
        ],
      },
    });
    await mount("/card");
    const tiles = [...container.querySelectorAll(".photos li")];
    expect(tiles[0]?.querySelector(".photo-decline")).toBeNull();
    expect(tiles[1]?.querySelector(".photo-decline")?.textContent).toBe(
      "Отклонено: На фото виден человекУдалите это фото и загрузите новое.",
    );
    expect(tiles[2]?.querySelector(".photo-decline")?.textContent).toBe(
      "Отклонено командой Bayramm.Удалите это фото и загрузите новое.",
    );
    expect(tiles[3]?.querySelector(".photo-decline")).toBeNull();
  });

  it("отклонённое фото глазами сотрудника площадки: причина есть, призыва удалить нет", async () => {
    routes[`GET ${mePath}`] = () => ({ body: me("ru", "member") });
    routes[`GET ${listingPath}`] = () => ({
      body: { ...LISTING, photos: [photoOf(1, "approved"), photoOf(2, "declined", "Нет лиц — но размыто")] },
    });
    await mount("/card");
    expect(container.querySelector(".photo-decline")?.textContent).toBe("Отклонено: Нет лиц — но размыто");
    expect(container.querySelector(".photo-decline-next")).toBeNull();
  });

  it("история предложений: свёрнута; открыл — последние пять решений с датой, причиной и полями", async () => {
    const items = [
      decided(1, { payload: { name: "New Hall", description_uz: "Yangi", attributes: { stage: true } } }),
      decided(2, { status: "approved", decisionReason: null, payload: { video_links: [] } }),
      decided(3, { byTeam: true }),
      decided(4),
      decided(5),
      decided(6),
      decided(7),
      revision({ id: "cccccccc-0000-0000-0000-0000000000aa", status: "withdrawn" }),
    ];
    routes[`GET ${listingPath}/revisions`] = () => ({ body: { items } });
    await mount("/card");
    const toggle = byText<HTMLButtonElement>("button", "История предложений");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(toggle?.querySelector(".count")?.textContent).toBe("5");
    expect(container.querySelector(".revlog")).toBeNull();

    await click(toggle);
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    const rows = [...container.querySelectorAll(".revlog li")];
    expect(rows).toHaveLength(5);
    expect(rows[0]?.textContent).toContain("Отклонено");
    expect(rows[0]?.textContent).toContain("Что менялось: Название, Описание на узбекском, Данные витрины");
    expect(rows[0]?.textContent).toContain("Причина: Причина 1");
    expect(rows[1]?.textContent).toContain("Одобрено");
    expect(rows[1]?.textContent).toContain("Что менялось: Видео");
    expect(rows[1]?.textContent).not.toContain("Причина");
    expect(rows[2]?.textContent).toContain("Предложила команда Bayramm");
    // Шестое решённое и отозванное — не в истории
    expect(container.querySelector(".revlog")?.textContent).not.toContain("Причина 6");

    await click(toggle);
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".revlog")).toBeNull();
  });

  it("решений ещё не было — истории нет; открытое предложение и отозванное в неё не попадают", async () => {
    routes[`GET ${listingPath}/revisions`] = () => ({
      body: {
        items: [revision(), revision({ id: "cccccccc-0000-0000-0000-0000000000ab", status: "withdrawn" })],
      },
    });
    await mount("/card");
    expect(container.querySelector(".proposal-pending")).not.toBeNull();
    expect(byText("button", "История предложений")).toBeUndefined();
  });

  it("первым ответил менеджер Bayramm — так и сказано в списке и в карточке заявки", async () => {
    const answered = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const byStaff = {
      status: "contacted" as const,
      firstResponseBy: "staff" as const,
      sla: { ...item().sla, firstResponseAt: answered },
    };
    routes["GET /api/vendor/requests"] = () => ({ body: page([item(byStaff)]) });
    routes[`GET /api/vendor/requests/${REQUEST_ID}`] = () => ({ body: detail(byStaff) });
    await mount("/requests");
    expect(container.querySelector(".rq .rq-staff")?.textContent).toBe("Первым ответил менеджер Bayramm");

    await click(container.querySelector(".rq") ?? undefined);
    expect(container.querySelector(".staff-reply")?.textContent).toMatch(
      /^Первым ответил менеджер Bayramm · \d\d:\d\d$/,
    );
    // История переходов — прежняя
    expect(container.querySelectorAll(".history li").length).toBeGreaterThan(0);
  });

  it("ответил сам партнёр или ответа ещё нет — строки про менеджера нет", async () => {
    routes["GET /api/vendor/requests"] = () => ({
      body: page([item({ status: "contacted", firstResponseBy: "vendor_user" }), item({ id: "x" })]),
    });
    routes[`GET /api/vendor/requests/${REQUEST_ID}`] = () => ({
      body: detail({ status: "contacted", firstResponseBy: "vendor_user" }),
    });
    await mount("/requests");
    expect(container.querySelector(".rq-staff")).toBeNull();
    await click(container.querySelector(".rq") ?? undefined);
    expect(container.querySelector(".staff-reply")).toBeNull();
  });
});

describe("значки и история: чистые функции", () => {
  const ref = (id: string, attention: VendorAttention): VendorListingRef => ({
    id,
    name: id,
    status: "active",
    categoryCode: "hall",
    attention,
  });

  it("значок раздела — сумма по всем витринам: «Витрина» — фото и предложение, «Услуги» — услуги", () => {
    const listings = [
      ref("a", { services: 2, photos: 1, proposals: 1 }),
      ref("b", { services: 1, photos: 0, proposals: 0 }),
    ];
    expect(attentionTotals(listings)).toEqual({ card: 2, services: 3 });
    expect(attentionTotals([])).toEqual({ card: 0, services: 0 });
    expect(attentionOf({ services: 4, photos: 2, proposals: 1 }, "card")).toBe(3);
  });

  it("mergeListings: ничего не изменилось — тот же массив (экраны не перечитываются зря)", () => {
    const current = [ref("a", NO_ATTENTION)];
    expect(mergeListings(current, [ref("a", NO_ATTENTION)])).toBe(current);
    const fresh = [ref("a", { services: 1, photos: 0, proposals: 0 })];
    expect(mergeListings(current, fresh)).toBe(fresh);
    expect(mergeListings(current, [])).toEqual([]);
  });

  it("revisionFields: подписи полей в порядке показа; неизвестных ключей нет — пусто", () => {
    const t = vendorDict.ru;
    expect(revisionFields({ video_links: [], name: "X", description_ru: "Y" }, t)).toEqual([
      "Название",
      "Описание на русском",
      "Видео",
    ]);
    expect(revisionFields({}, t)).toEqual([]);
  });

  it("decidedRevisions: только одобренные и отклонённые, не больше пяти, порядок сохранён", () => {
    const rev = (n: number, status: VendorRevision["status"]) => revision({ id: String(n), status });
    const items = [
      rev(1, "pending"),
      rev(2, "declined"),
      rev(3, "withdrawn"),
      rev(4, "approved"),
      ...[5, 6, 7, 8, 9].map((n) => rev(n, "declined")),
    ];
    expect(decidedRevisions(items).map((r) => r.id)).toEqual(["2", "4", "5", "6", "7"]);
  });
});
