// @vitest-environment jsdom
import type {
  VendorCalendar,
  VendorListing,
  VendorMe,
  VendorRequestDetail,
  VendorRequestItem,
  VendorRequestPage,
  VendorRevision,
} from "@bayramm/shared/api/vendor";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { tashkentToday } from "./format";

// React ждёт этот флаг, чтобы act() дожидался эффектов
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const REQUEST_ID = "eeeeeeee-0000-0000-0000-0000000000a1";
const LISTING_ID = "aaaaaaaa-0000-0000-0000-000000000101";
const HOUR = 3600 * 1000;

const me = (locale: "ru" | "uz" = "ru"): VendorMe => ({
  user: { id: "aaaaaaaa-0000-0000-0000-000000000011", locale, fullName: "Manager" },
  vendor: { id: "aaaaaaaa-0000-0000-0000-000000000001", code: "V101", name: "Test LLC" },
  listings: [{ id: LISTING_ID, name: "Test Hall", status: "active" }],
});

function item(patch: Partial<VendorRequestItem> = {}): VendorRequestItem {
  const created = Date.now() - HOUR;
  return {
    id: REQUEST_ID,
    publicNo: 1001,
    status: "new",
    declineReason: null,
    listing: { id: LISTING_ID, name: "Test Hall" },
    occasionCode: "toy",
    eventDate: "2026-11-14",
    guests: 200,
    budgetMinUzs: 40_000_000,
    budgetMaxUzs: 60_000_000,
    createdAt: new Date(created).toISOString(),
    sla: { dueAt: new Date(created + 12 * HOUR).toISOString(), firstResponseAt: null, breached: false },
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
  contact: { name: "Dilnoza", phone: "+998901234567", comment: "Вечер, живая музыка" },
  history: [
    { status: "new", at: new Date(Date.now() - HOUR).toISOString(), by: "system" },
    { status: "viewed", at: new Date().toISOString(), by: "vendor_user" },
  ],
  ...patch,
});

type Handler = (init: RequestInit, url: URL) => { status?: number; body?: unknown } | undefined;
let routes: Record<string, Handler>;
let calls: { method: string; path: string; body: unknown; auth: string | null }[];

function respond(status: number, body: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function fakeFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const url = new URL(String(input), "https://vendor.bayramm.uz");
  const method = init.method ?? "GET";
  const auth = new Headers(init.headers).get("Authorization");
  calls.push({
    method,
    path: url.pathname + url.search,
    body: init.body ? JSON.parse(String(init.body)) : undefined,
    auth,
  });
  const handler = routes[`${method} ${url.pathname}`];
  const result = handler?.(init, url);
  if (!result) return respond(404, { error: { code: "not_found", message: "Not found" } });
  return respond(result.status ?? 200, result.body);
}

function defaultRoutes(locale: "ru" | "uz" = "ru"): Record<string, Handler> {
  return {
    "GET /api/telegram/bot": () => ({ body: { username: "bayramm_test_bot", miniAppUrl: "https://x" } }),
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
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as { Telegram?: unknown }).Telegram;
  for (const script of document.head.querySelectorAll("script")) script.remove();
  vi.unstubAllGlobals();
});

describe("вход в кабинет", () => {
  it("вне Telegram — «войдите» (хаб) и ссылка на бота окружения, без попытки входа", async () => {
    await mount("/requests");
    expect(heading()).toBe("Войдите в кабинет");
    expect(byText("button", "Войти")).toBeDefined();
    const link = byText<HTMLAnchorElement>("a", "Открыть бота");
    expect(link?.getAttribute("href")).toBe("https://t.me/bayramm_test_bot?start=partner");
    expect(calls.some((c) => c.method === "POST" && c.path.startsWith("/api/auth"))).toBe(false);
    expect(container.querySelector("nav.tabbar")).toBeNull();
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

    const phone = container.querySelector<HTMLAnchorElement>('a[href="tel:+998901234567"]') ?? undefined;
    expect(phone?.textContent).toBe("+998 90 123 45 67");
    expect(phone?.getAttribute("aria-label")).toBe("Позвонить +998 90 123 45 67");
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
  });

  beforeEach(() => {
    insideTelegram();
    routes[`GET /api/vendor/listings/${LISTING_ID}/calendar`] = () => ({ body: calendar() });
    routes[`PUT /api/vendor/listings/${LISTING_ID}/calendar/${today}`] = () => ({
      body: { day: today, source: "vendor", requestId: null },
    });
  });

  it("месяц по Ташкенту; нажатие на сегодня — день занят (PUT), прошлое неактивно", async () => {
    await mount("/calendar");
    expect(heading()).toBe("Календарь");
    expect(calls.find((c) => c.path.includes("/calendar"))?.path).toBe(
      `/api/vendor/listings/${LISTING_ID}/calendar?month=${month}`,
    );
    const day = container.querySelector<HTMLButtonElement>(".cal-today");
    expect(day?.getAttribute("aria-pressed")).toBe("false");
    await click(day ?? undefined);
    expect(calls.some((c) => c.method === "PUT" && c.path.endsWith(`/calendar/${today}`))).toBe(true);
    expect(container.querySelector(".cal-today")?.getAttribute("aria-pressed")).toBe("true");
    if (Number(today.slice(8)) > 1) {
      expect(container.querySelector<HTMLButtonElement>(".cal-day")?.disabled).toBe(true);
    }
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

  it("не сохранилось — день возвращается как был", async () => {
    routes[`PUT /api/vendor/listings/${LISTING_ID}/calendar/${today}`] = () => ({
      status: 503,
      body: { error: { code: "service_unavailable", message: "x" } },
    });
    await mount("/calendar");
    await click(container.querySelector(".cal-today") ?? undefined);
    expect(container.querySelector(".cal-today")?.getAttribute("aria-pressed")).toBe("false");
    expect(container.textContent).toContain("Не удалось сохранить день");
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
  packages: [
    { kind: "weekday", name: { ru: "Будни", uz: "Ish kuni" }, priceUzs: 150_000, priceUnit: "per_guest" },
    { kind: "weekend", name: { ru: "Выходные", uz: "Dam olish" }, priceUzs: 180_000, priceUnit: "per_guest" },
  ],
  photos: [],
  phone: "+998000000999",
  blockers: [],
};

const REVISION_ID = "cccccccc-0000-0000-0000-0000000000f1";
const revision = (patch: Partial<VendorRevision> = {}): VendorRevision => ({
  id: REVISION_ID,
  status: "pending",
  submittedAt: new Date().toISOString(),
  decidedAt: null,
  decisionReason: null,
  payload: { price_from_uzs: 170_000 },
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

  it("предложение уходит только с изменённым полем и ждёт проверки; клиент видит прежнюю карточку", async () => {
    routes[`POST ${revisionsPath}`] = (init) => ({
      status: 201,
      body: revision({ payload: JSON.parse(String(init.body)) }),
    });
    await mount("/card");
    await click(byText("button", "Предложить изменения"));
    // Ничего не изменили — без запроса
    await click(byText("button", "Отправить на проверку"));
    expect(posted()).toEqual([]);
    expect(container.textContent).toContain("Вы ничего не изменили.");

    await type(field("Цена от, сум"), "170 000");
    await click(byText("button", "Отправить на проверку"));
    expect(posted().map((c) => c.body)).toEqual([{ price_from_uzs: 170_000 }]);
    expect(container.textContent).toContain("Предложение на проверке");
    expect(container.textContent).toContain("от 170\u202f000 сум за гостя");
    expect(container.textContent).toContain("Отправлено на проверку");
    // Карточка — прежняя: цена в фактах не изменилась
    expect(container.querySelector(".venue > .facts")?.textContent).toContain("от 150\u202f000 сум за гостя");
  });

  it("цена не числом — ошибка у поля без запроса; «по запросу» не бывает", async () => {
    await mount("/card");
    await click(byText("button", "Предложить изменения"));
    await type(field("Цена от, сум"), "по запросу");
    await click(byText("button", "Отправить на проверку"));
    expect(posted()).toEqual([]);
    expect(field("Цена от, сум")?.getAttribute("aria-invalid")).toBe("true");
    expect(container.textContent).toContain("Без цены карточку не опубликуют");
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
});

describe("площадка", () => {
  it("карточка как в базе: подсказка про предложения и менеджера, код вендора; полей ввода нет", async () => {
    insideTelegram();
    routes[`GET /api/vendor/listings/${LISTING_ID}/revisions`] = () => ({ body: { items: [] } });
    routes[`GET /api/vendor/listings/${LISTING_ID}`] = () => ({
      body: {
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
        packages: [
          {
            kind: "weekday",
            name: { ru: "Будни", uz: "Ish kuni" },
            priceUzs: 150_000,
            priceUnit: "per_guest",
          },
        ],
        photos: [],
        phone: "+998000000999",
        blockers: [],
      },
    });
    await mount("/card");
    expect(heading()).toBe("Площадка");
    expect(container.textContent).toContain("изменения проверит команда Bayramm");
    expect(container.textContent).toContain("Фото, адрес и вместимость меняет ваш менеджер");
    expect(container.textContent).toContain("V101");
    expect(container.textContent).toContain("от 150 000 сум за гостя");
    expect(container.textContent).toContain("50–300 гостей");
    expect(container.textContent).toContain("Чиланзар");
    expect(container.querySelector("input, textarea, select")).toBeNull();
  });
});
