// @vitest-environment jsdom
import { type CompressedPhoto, compressForUpload } from "@bayramm/media/browser";
import type {
  ListingService,
  VendorCalendar,
  VendorListing,
  VendorListingRef,
  VendorMe,
  VendorPhoto,
  VendorRequestDetail,
  VendorRequestItem,
  VendorRole,
} from "@bayramm/shared/api/vendor";
import { categoryConfig, defaultDaySessions } from "@bayramm/shared/categories";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { tashkentToday } from "./format";
import { vendorDict } from "./i18n";
import { vendorTodos } from "./Venue";

/* Кабинет с несколькими витринами в разных категориях: выбор витрины, входящие по витрине,
   поля заявки категории, услуги, поля витрины и видео в правке, фото с согласием людей,
   календарь частей дня и срок заказа вместо календаря. Сжатие фото подменено в test-setup.ts. */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const HALL = "aaaaaaaa-0000-0000-0000-000000000101";
const CAR = "aaaaaaaa-0000-0000-0000-000000000102";
const PHOTO = "aaaaaaaa-0000-0000-0000-000000000103";
const CAKE = "aaaaaaaa-0000-0000-0000-000000000104";
const REQUEST = "eeeeeeee-0000-0000-0000-0000000000c1";
const SVC = "bbbbbbbb-0000-0000-0000-000000000001";
const OPT = "bbbbbbbb-0000-0000-0000-0000000000f1";
const HOUR = 3600 * 1000;

const NONE = { services: 0, photos: 0, proposals: 0 };

const REFS: VendorListingRef[] = [
  { id: HALL, name: "Lola zali", status: "active", categoryCode: "hall", attention: NONE },
  { id: CAR, name: "Kortej Premium", status: "active", categoryCode: "car", attention: NONE },
  { id: PHOTO, name: "Kadr Studio", status: "draft", categoryCode: "photo", attention: NONE },
  { id: CAKE, name: "Shirin Tort", status: "active", categoryCode: "cake", attention: NONE },
];

const me = (role: VendorRole = "owner"): VendorMe => ({
  user: { id: "aaaaaaaa-0000-0000-0000-000000000011", locale: "ru", fullName: "Manager", role },
  vendor: { id: "aaaaaaaa-0000-0000-0000-000000000001", code: "V101", name: "Test LLC" },
  listings: REFS,
});

const service = (patch: Partial<ListingService> = {}): ListingService => ({
  id: SVC,
  type: "bride_car",
  status: "active",
  name: { ru: "Машина для молодожёнов", uz: "Kelin-kuyov mashinasi" },
  customName: false,
  priceUzs: 300_000,
  priceUnit: "per_hour",
  minQty: 3,
  leadDays: null,
  includes: null,
  options: [
    {
      id: OPT,
      code: "flower_decor",
      name: { ru: "Украшение живыми цветами", uz: "Tirik gullar bilan bezash" },
      priceUzs: 500_000,
      priceUnit: "per_event",
    },
  ],
  sort: 0,
  proposal: null,
  decision: null,
  submittedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...patch,
});

/** Время работы по умолчанию категории: несколько мероприятий, все части, окна категории */
const sessionsOf = (code: string, parallelCapacity = 1) => {
  const category = categoryConfig(code);
  if (!category) throw new Error(code);
  return { ...defaultDaySessions(category), parallelCapacity };
};

const listing = (ref: VendorListingRef, patch: Partial<VendorListing> = {}): VendorListing => ({
  id: ref.id,
  version: 3,
  slug: ref.name.toLowerCase().replace(/\s+/g, "-"),
  name: ref.name,
  status: ref.status,
  statusReason: null,
  categoryCode: ref.categoryCode,
  districtCode: null,
  address: { ru: "Ташкент", uz: "Toshkent" },
  description: { ru: "Описание", uz: "Tavsif" },
  priceFromUzs: 300_000,
  priceUnit: "per_hour",
  capMin: null,
  capMax: null,
  photos: [],
  phone: "+998000000999",
  telegram: null,
  contactChange: null,
  blockers: [],
  reviewBlockers: [],
  photoLimits: { min: 3, max: 10 },
  attributes: {},
  missingAttributes: [],
  videoLinks: [],
  parallelCapacity: 1,
  daySessions: sessionsOf(ref.categoryCode, patch.parallelCapacity ?? 1),
  calendarVersion: 4,
  services: [],
  ...patch,
});

const LISTINGS: Record<string, VendorListing> = {
  [HALL]: listing(REFS[0] as VendorListingRef, { priceUnit: "per_guest", priceFromUzs: 150_000 }),
  [CAR]: listing(REFS[1] as VendorListingRef, {
    attributes: { fleet: [{ model: "Chevrolet Malibu", class: "sedan" }], service_area: "tashkent" },
    parallelCapacity: 2,
    services: [service()],
  }),
  [PHOTO]: listing(REFS[2] as VendorListingRef, {
    priceFromUzs: null,
    blockers: ["price", "attributes", "photos"],
    reviewBlockers: ["price", "attributes", "photos"],
    missingAttributes: ["team", "delivery_days"],
  }),
  [CAKE]: listing(REFS[3] as VendorListingRef, {
    attributes: { cake_kinds: ["wedding"], lead_days: 3 },
    services: [
      service({
        id: "bbbbbbbb-0000-0000-0000-000000000031",
        type: "wedding_cake",
        name: { ru: "Свадебный торт", uz: "Toʻy torti" },
        priceUnit: "per_kg",
        leadDays: 5,
        options: [],
      }),
    ],
  }),
};

function item(patch: Partial<VendorRequestItem> = {}): VendorRequestItem {
  const created = Date.now() - HOUR;
  return {
    id: REQUEST,
    publicNo: 1060,
    status: "new",
    declineReason: null,
    listing: { id: CAR, name: "Kortej Premium", categoryCode: "car" },
    occasionCode: "toy",
    eventDate: "2026-11-14",
    guests: null,
    dayParts: ["evening"],
    details: {
      start_time: "18:00",
      hours: 5,
      cars_count: 3,
      car_class: "premium",
      services: [
        {
          id: SVC,
          type: "bride_car",
          name: { ru: "Машина для молодожёнов", uz: "Kelin-kuyov mashinasi" },
          priceUzs: 300_000,
          priceUnit: "per_hour",
          qty: 5,
          options: [
            {
              id: OPT,
              name: { ru: "Украшение живыми цветами", uz: "Tirik gullar bilan bezash" },
              priceUzs: 500_000,
              priceUnit: "per_event",
            },
          ],
        },
      ],
    },
    budgetMinUzs: null,
    budgetMaxUzs: 3_000_000,
    createdAt: new Date(created).toISOString(),
    sla: { dueAt: new Date(created + 12 * HOUR).toISOString(), firstResponseAt: null, breached: false },
    firstResponseBy: null,
    contactName: "Dilnoza",
    ...patch,
  };
}

const detail = (): VendorRequestDetail => ({
  ...item({ status: "viewed" }),
  declineNote: null,
  contact: { name: "Dilnoza", phone: "+998001234567", comment: null },
  history: [],
});

const today = tashkentToday();
const month = today.slice(0, 7);
const day = (n: number) => `${month}-${String(n).padStart(2, "0")}`;

const calendar = (listingId: string, patch: Partial<VendorCalendar> = {}): VendorCalendar => ({
  listingId,
  month,
  today,
  maxDay: "2030-12-31",
  busy: [],
  requestDays: [],
  requests: [],
  version: 4,
  mode: "parts",
  parallelCapacity: patch.parallelCapacity ?? 1,
  sessions: sessionsOf(listingId === CAR ? "car" : "hall", patch.parallelCapacity ?? 1),
  parts: [],
  bookings: [],
  ...patch,
});

type Handler = (init: RequestInit, url: URL) => { status?: number; body?: unknown } | undefined;
let routes: Record<string, Handler>;
let calls: { method: string; path: string; body: unknown; headers: Headers }[];

function respond(status: number, body: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function fakeFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const url = new URL(String(input), "https://vendor.bayramm.uz");
  const method = init.method ?? "GET";
  calls.push({
    method,
    path: url.pathname + url.search,
    body: typeof init.body === "string" ? JSON.parse(init.body) : (init.body ?? undefined),
    headers: new Headers(init.headers),
  });
  const result = routes[`${method} ${url.pathname}`]?.(init, url);
  if (!result) return respond(404, { error: { code: "not_found", message: "Not found" } });
  return respond(result.status ?? 200, result.body);
}

function defaultRoutes(role: VendorRole = "owner"): Record<string, Handler> {
  const out: Record<string, Handler> = {
    "POST /api/auth/telegram": () => ({ body: { token: "t".repeat(43), expiresAt: "2026-10-01T20:00:00Z" } }),
    "GET /api/vendor/me": () => ({ body: me(role) }),
    "GET /api/vendor/requests": (_init, url) => {
      const only = url.searchParams.get("listingId");
      const items = only === null || only === CAR ? [item()] : [];
      return {
        body: {
          items,
          nextCursor: null,
          counts: { waiting: items.length, active: 0, closed: 0 },
          overdue: 0,
        },
      };
    },
    [`GET /api/vendor/requests/${REQUEST}`]: () => ({ body: detail() }),
  };
  for (const [id, card] of Object.entries(LISTINGS)) {
    out[`GET /api/vendor/listings/${id}`] = () => ({ body: card });
    out[`GET /api/vendor/listings/${id}/revisions`] = () => ({ body: { items: [] } });
  }
  out[`GET /api/vendor/listings/${HALL}/calendar`] = () => ({ body: calendar(HALL) });
  return out;
}

function insideTelegram() {
  Object.assign(window, {
    Telegram: {
      WebApp: {
        initData: "query_id=1&user=%7B%7D&auth_date=1&hash=abc",
        initDataUnsafe: {},
        ready: vi.fn(),
        expand: vi.fn(),
        BackButton: { show: vi.fn(), hide: vi.fn(), onClick: vi.fn(), offClick: vi.fn() },
      },
    },
  });
}

let container: HTMLDivElement;
let root: Root;

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => {});
}

async function mount(path: string) {
  window.history.replaceState(null, "", path);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<App />));
  await flush();
}

const heading = () => container.querySelector("h1")?.textContent;
const byText = <T extends Element>(selector: string, text: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll<T>(selector)].find((el) => el.textContent?.includes(text));
const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error("элемент не найден");
  await act(async () => (el as HTMLElement).click());
  await flush();
};
const field = (label: string) => {
  const id = byText<HTMLLabelElement>("label", label)?.htmlFor;
  return (id ? document.querySelector<HTMLInputElement>(`[id="${id}"]`) : null) ?? undefined;
};
const type = async (input: HTMLInputElement | HTMLTextAreaElement | undefined, value: string) => {
  if (!input) throw new Error("поле не найдено");
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
/** Выбрать вариант в своём списке (Select): кнопка поля → вариант в шторке или панели */
const pick = async (trigger: Element | null | undefined, option: string) => {
  await click(trigger);
  await click(byText('[role="option"]', option));
};
/** Действие из шторки «⋯» запускается, когда шторка закрылась (макрозадача): ждём её */
const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  await flush();
};
const menuAction = async (card: Element | undefined, label: string) => {
  await click(card?.querySelector(".svc-more"));
  await click(byText('[role="dialog"] .menu-item', label));
  await settle();
};
const resize = (width: number) =>
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.scrollTo = () => {};
  routes = defaultRoutes();
  calls = [];
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  insideTelegram();
});

afterEach(() => {
  resize(390);
  act(() => root.unmount());
  container.remove();
  delete (window as { Telegram?: unknown }).Telegram;
  vi.unstubAllGlobals();
});

describe("витрины", () => {
  it("компьютер: витрины в боковой панели; выбранная — общая для площадки и услуг", async () => {
    resize(1280);
    await mount("/card");
    const side = container.querySelector(".side-vitrinas");
    const buttons = [...(side?.querySelectorAll("button") ?? [])];
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Lola zaliТойхона",
      "Kortej PremiumКортеж",
      "Kadr StudioФото и видео",
      "Shirin TortТорты и сладости",
    ]);
    expect(buttons[0]?.getAttribute("aria-pressed")).toBe("true");
    // Выбор уже в боковой панели — на экране пилюль нет
    expect(container.querySelector(".vitrina-pills")).toBeNull();

    await click(buttons[1]);
    expect(container.querySelector(".venue-name")?.textContent).toBe("Kortej Premium");
    expect(container.querySelector(".venue .chip-cat")?.textContent).toBe("Кортеж");
    await click(byText("nav.side-nav a", "Услуги"));
    expect(heading()).toBe("Услуги");
    expect(container.querySelector(".vitrina-line")?.textContent).toContain("Kortej Premium");
    expect(byText(".svc-name", "Машина для молодожёнов")).toBeDefined();
  });

  it("телефон, до четырёх витрин: пилюли с переносом — все видны, выбор в одно нажатие, подписи на экране нет", async () => {
    routes[`GET /api/vendor/listings/${CAR}/calendar`] = () => ({ body: calendar(CAR, { mode: "parts" }) });
    await mount("/calendar");
    expect(container.querySelector(".side")).toBeNull();
    expect(container.querySelector(".vitrina-select")).toBeNull();
    const group = container.querySelector(".vitrina-pills");
    // Имя группы — только для диктора: «Выберите витрину» над пилюлями на экране нет
    expect(group?.getAttribute("aria-label")).toBe("Выберите витрину");
    expect(container.querySelector("label.field-label")).toBeNull();
    const pills = [...(group?.querySelectorAll("button") ?? [])];
    expect(pills.map((p) => p.textContent)).toEqual([
      "Lola zaliТойхона",
      "Kortej PremiumКортеж",
      "Kadr StudioФото и видео",
      "Shirin TortТорты и сладости",
    ]);
    expect(pills[0]?.getAttribute("aria-pressed")).toBe("true");
    await click(pills[1]);
    expect(sent("GET", `/api/vendor/listings/${CAR}/calendar?month=${month}`)).toHaveLength(1);
    expect(pills[1]?.getAttribute("aria-pressed")).toBe("true");
  });

  it("телефон, больше четырёх витрин: список выбора — тоже без подписи на экране", async () => {
    const extra: VendorListingRef = {
      id: "aaaaaaaa-0000-0000-0000-000000000105",
      name: "Gul Dekor",
      status: "active",
      categoryCode: "hall",
      attention: NONE,
    };
    routes["GET /api/vendor/me"] = () => ({ body: { ...me(), listings: [...REFS, extra] } });
    routes[`GET /api/vendor/listings/${CAR}/calendar`] = () => ({ body: calendar(CAR, { mode: "parts" }) });
    await mount("/calendar");
    expect(container.querySelector(".vitrina-pills")).toBeNull();
    const trigger = container.querySelector(".vitrina-select button");
    expect(container.querySelector(".vitrina-select label")).toBeNull();
    expect(trigger?.textContent).toContain("Lola zali · Тойхона");
    await click(trigger);
    expect([...document.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual([
      "Lola zali · Тойхона",
      "Kortej Premium · Кортеж",
      "Kadr Studio · Фото и видео",
      "Shirin Tort · Торты и сладости",
      "Gul Dekor · Тойхона",
    ]);
    await click(byText('[role="option"]', "Kortej Premium"));
    expect(sent("GET", `/api/vendor/listings/${CAR}/calendar?month=${month}`)).toHaveLength(1);
    expect(container.querySelector(".vitrina-select button")?.textContent).toContain("Kortej Premium");
  });

  it("телефон, две витрины: две пилюли в ряд, обе видны", async () => {
    routes["GET /api/vendor/me"] = () => ({ body: { ...me("owner"), listings: REFS.slice(0, 2) } });
    await mount("/card");
    const pills = [...container.querySelectorAll(".vitrina-pills button")];
    expect(pills.map((p) => p.textContent)).toEqual(["Lola zaliТойхона", "Kortej PremiumКортеж"]);
    expect(container.querySelector(".vitrina-select")).toBeNull();
    // Выбор называет витрину — заголовка с её именем второй раз нет
    expect(container.querySelector(".venue-name")).toBeNull();
    await click(pills[1]);
    expect(pills[1]?.getAttribute("aria-pressed")).toBe("true");
    // Категорию называет пилюля — чипа категории в карточке нет, только статус
    expect(container.querySelector(".venue .chip-cat")).toBeNull();
    expect(container.querySelector(".venue .venue-chips")?.textContent).toBe("Опубликована");
  });
});

describe("входящие по витринам", () => {
  it("все витрины или одна (listingId); значок у раздела — по всем витринам", async () => {
    await mount("/requests");
    // Витрин четыре — пилюли («Все витрины» первой), подписи на экране нет
    const group = () => container.querySelector(".vitrina-pills");
    const pill = (name: string) => byText<HTMLButtonElement>(".vitrina-pills button", name, container);
    expect(group()?.getAttribute("aria-label")).toBe("Витрина");
    expect(container.querySelector(".vitrina-select")).toBeNull();
    expect(pill("Все витрины")?.getAttribute("aria-pressed")).toBe("true");
    expect(calls.find((c) => c.path.startsWith("/api/vendor/requests?"))?.path).toBe(
      "/api/vendor/requests?tab=waiting",
    );
    expect(container.querySelector(".nav-count")?.textContent).toBe("1");

    // Витрина без заявок: список пуст, а значок у раздела — по-прежнему по всем витринам
    await click(pill("Lola zali"));
    expect(calls.at(-1)?.path).toBe(`/api/vendor/requests?tab=waiting&listingId=${HALL}`);
    expect(container.querySelectorAll(".rq-list .rq")).toHaveLength(0);
    expect(container.querySelector(".nav-count")?.textContent).toBe("1");
    await click(pill("Kortej Premium"));
    expect(calls.at(-1)?.path).toBe(`/api/vendor/requests?tab=waiting&listingId=${CAR}`);
    expect(container.querySelectorAll(".rq-list .rq")).toHaveLength(1);

    // Выбранная во входящих витрина — выбранная и в других разделах
    await click(byText("nav.tabbar a", "Витрина"));
    expect(
      byText<HTMLButtonElement>(".vitrina-pills button", "Kortej Premium", container)?.getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");
    expect(container.querySelector(".venue .chip-cat")).toBeNull();
  });

  it("компьютер: выбор витрины на входящих — в боковой панели, с «Все витрины»; над списком второго нет", async () => {
    resize(1280);
    await mount("/requests");
    expect(container.querySelector("main .vitrina-select, main .vitrina-pills")).toBeNull();
    const side = container.querySelector(".side-vitrinas");
    expect(side?.querySelector(".side-title")?.textContent).toBe("Витрина");
    const buttons = () => [...(side?.querySelectorAll("button") ?? [])];
    expect(buttons()[0]?.textContent).toBe("Все витрины");
    expect(buttons()[0]?.getAttribute("aria-pressed")).toBe("true");
    await click(byText(".side-vitrinas button", "Kortej Premium"));
    expect(calls.at(-1)?.path).toBe(`/api/vendor/requests?tab=waiting&listingId=${CAR}`);
    expect(byText(".side-vitrinas button", "Kortej Premium")?.getAttribute("aria-pressed")).toBe("true");
    // На других разделах «Все витрины» нет: там всегда одна витрина
    await click(byText("nav.side-nav a", "Календарь"));
    expect(byText(".side-vitrinas button", "Все витрины")).toBeUndefined();
    expect(container.querySelector(".side-vitrinas .side-title")?.textContent).toBe("Витрины");
  });

  it("витрина ещё не на сайте: во входящих — почему и кнопка к её чек-листу готовности", async () => {
    await mount("/requests");
    const notice = container.querySelector(".not-live");
    expect(notice?.textContent).toContain("«Kadr Studio» ещё не на сайте — заявок по ней не будет.");
    // Опубликованные витрины не упомянуты
    expect(notice?.textContent).not.toContain("Lola zali");
    await click(byText(".not-live button", "Что осталось"));
    expect(heading()).toBe("Витрина");
    expect(
      byText<HTMLButtonElement>(".vitrina-pills button", "Kadr Studio", container)?.getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");
    expect(container.querySelector(".readiness h2")?.textContent).toBe("Что осталось до публикации");
  });

  it("в списке — «Категория · Витрина» одной строкой, часть дня и одно поле заявки", async () => {
    await mount("/requests");
    const card = container.querySelector(".rq-list .rq");
    expect(card?.querySelector(".rq-vitrina")?.textContent).toBe("Кортеж · Kortej Premium");
    expect(card?.querySelector(".chip-cat")).toBeNull();
    // Части дня — рядом с поводом: «Вечер · Свадьба»
    expect(card?.querySelector(".rq-meta")?.textContent).toBe("14 ноября, сб · Вечер · Свадьба");
    // Не весь «Начало · Часы · Машины · Класс · Услуги»: остальное — в карточке заявки
    expect(card?.querySelector(".rq-details")?.textContent).toBe("Начало: 18:00");
    expect(container.textContent).not.toContain("Клиент дал согласие");
  });

  it("карточка заявки: части дня, поля категории, услуги с количеством и дополнениями", async () => {
    await mount(`/requests/${REQUEST}`);
    expect(container.querySelector(".req-when")?.textContent).toBe("14 ноября, сб · Вечер");
    // Витрин несколько — заявка называет свою чипом рядом с заголовком
    expect(container.querySelector(".detail-vitrina .chip-cat")?.textContent).toBe("Кортеж · Kortej Premium");
    const rows = [...container.querySelectorAll(".request-details .detail-rows > div")].map(
      (r) => r.textContent,
    );
    expect(rows).toEqual(["Начало18:00", "Сколько часов5", "Сколько машин3", "Класс машиныПремиум"]);
    const chosen = container.querySelector(".chosen-list")?.textContent ?? "";
    expect(chosen).toContain("Машина для молодожёнов × 5");
    expect(chosen).toContain("300\u202f000 сум за час");
    expect(chosen).toContain("+ Украшение живыми цветами");
    expect(chosen).toContain("500\u202f000 сум за мероприятие");
  });
});

describe("услуги", () => {
  const servicesPath = `/api/vendor/listings/${CAR}/services`;
  // Услуги кортежа, как в базе: ответы на правки меняют их, карточка перечитывается с ними
  let carServices: ListingService[];
  const saved = (next: ListingService) => {
    carServices = carServices.some((s) => s.id === next.id)
      ? carServices.map((s) => (s.id === next.id ? next : s))
      : [...carServices, next];
    return next;
  };

  beforeEach(() => {
    resize(1280);
    carServices = [service()];
    routes[`GET /api/vendor/listings/${CAR}`] = () => ({ body: { ...LISTINGS[CAR], services: carServices } });
  });

  async function openCarServices() {
    await mount("/services");
    await click(byText(".side-vitrinas button", "Kortej Premium"));
  }

  it("список: состояние, цена, минимум, дополнения; предложение — что сейчас и что предложено; причина отказа", async () => {
    carServices = [
      service({
        proposal: { changes: { priceUzs: 350_000 }, submittedAt: new Date().toISOString() },
      }),
      service({
        id: "bbbbbbbb-0000-0000-0000-000000000002",
        type: "limousine",
        name: { ru: "Лимузин", uz: "Limuzin" },
        status: "rejected",
        options: [],
        minQty: null,
        decision: { outcome: "declined", reason: "Нет фото лимузина", at: new Date().toISOString() },
      }),
    ];
    await openCarServices();
    const cards = [...container.querySelectorAll(".svc")];
    expect(cards[0]?.querySelector(".chip-done")?.textContent).toBe("На витрине");
    expect(cards[0]?.querySelector(".svc-facts")?.textContent).toBe("300\u202f000 сум за час · минимум 3");
    expect(cards[0]?.querySelector(".svc-options")?.textContent).toContain("+ Украшение живыми цветами");
    expect(cards[0]?.querySelector(".svc-proposal")?.textContent).toContain("Изменения на проверке");
    expect(cards[0]?.querySelector(".changes")?.textContent).toBe(
      "ЦенаСейчас: 300\u202f000 сумПредложено: 350\u202f000 сум",
    );
    // «Отозвать изменения» — в шторке «⋯», на карточке её нет
    expect(byText("button", "Отозвать изменения", cards[0])).toBeUndefined();
    expect(cards[0]?.querySelector(".svc-more")?.getAttribute("aria-label")).toBe(
      "Действия: Машина для молодожёнов",
    );
    expect(cards[1]?.querySelector(".chip-bad")?.textContent).toBe("Отклонена");
    expect(cards[1]?.textContent).toContain("Отклонена. Причина: Нет фото лимузина");
    expect(byText("button", "Отправить на проверку", cards[1])).toBeDefined();
  });

  it("новая услуга: из каталога категории, проверка до запроса, дополнение из шаблона; черновик", async () => {
    routes[`POST ${servicesPath}`] = (init) => {
      const body = JSON.parse(String(init.body));
      return {
        status: 201,
        body: saved(
          service({
            id: "bbbbbbbb-0000-0000-0000-000000000009",
            type: body.type,
            name: { ru: "Лимузин", uz: "Limuzin" },
            status: body.submit === false ? "draft" : "review",
            priceUzs: body.priceUzs,
            minQty: null,
            options: [],
          }),
        ),
      };
    };
    await openCarServices();
    await click(byText("button", "Добавить услугу"));
    expect(document.activeElement?.textContent).toBe("Новая услуга");
    // Тип не выбран — без запроса
    await click(byText(".svc-editor button", "Отправить на проверку"));
    expect(sent("POST", servicesPath)).toEqual([]);
    expect(container.textContent).toContain("Выберите услугу из каталога.");

    await pick(field("Услуга из каталога"), "Лимузин");
    // Цена обязательна: пусто — ошибка у поля, без запроса
    await click(byText(".svc-editor button", "Отправить на проверку"));
    expect(sent("POST", servicesPath)).toEqual([]);
    expect(field("Цена")?.getAttribute("aria-invalid")).toBe("true");

    // Разряды — по мере набора, «сум» — у поля; в запрос уходит число
    await type(field("Цена"), "1200000");
    expect(field("Цена")?.value).toBe("1\u202f200\u202f000");
    expect(container.querySelector(".money-post")?.textContent).toBe("сум");
    // У лимузина одна единица цены — выбирать нечего
    expect(container.querySelector(".svc-unit-fixed")?.textContent).toBe("за час");
    await click(container.querySelector('button[aria-label="Добавить: Остановки для фотосессии"]'));
    const row = container.querySelector(".svc-option-list .package-row");
    await type(row?.querySelector<HTMLInputElement>('input[inputmode="numeric"]') ?? undefined, "200000");
    // Одна главная кнопка; черновик — в «⋯» формы
    expect(
      [...(container.querySelector(".svc-editor-actions")?.querySelectorAll("button") ?? [])].map(
        (b) => b.textContent || b.getAttribute("aria-label"),
      ),
    ).toEqual(["Отправить на проверку", "Другие действия с услугой"]);
    await click(container.querySelector(".svc-editor-more"));
    await click(byText('[role="dialog"] .menu-item', "Сохранить черновик"));
    expect(sent("POST", servicesPath).map((c) => c.body)).toEqual([
      {
        type: "limousine",
        priceUzs: 1_200_000,
        priceUnit: "per_hour",
        options: [
          {
            code: "photo_stops",
            name: { ru: "Остановки для фотосессии", uz: expect.any(String) },
            priceUzs: 200_000,
            priceUnit: "per_event",
          },
        ],
        submit: false,
      },
    ]);
    // Форма закрыта, услуга — в списке черновиком, фокус — на ней
    expect(container.querySelector(".svc-editor")).toBeNull();
    expect(byText(".svc", "Лимузин")?.querySelector(".chip")?.textContent).toBe("Черновик");
    expect(document.activeElement?.textContent).toBe("Лимузин");
    expect(container.textContent).toContain("Сохранено.");
  });

  it("«другая услуга» — название на двух языках обязательно", async () => {
    await openCarServices();
    await click(byText("button", "Добавить услугу"));
    await pick(field("Услуга из каталога"), "Другая услуга");
    await type(field("Название на русском"), "Фото у машины");
    await type(field("Цена"), "100000");
    await click(byText(".svc-editor button", "Отправить на проверку"));
    expect(sent("POST", servicesPath)).toEqual([]);
    expect(container.textContent).toContain("Название — на двух языках, от 2 букв.");
    expect(field("Название на узбекском")?.getAttribute("aria-invalid")).toBe("true");
  });

  it("несохранённое: вписали в форму услуги — уход по разделу и смена витрины спрашивают", async () => {
    await openCarServices();
    await click(container.querySelector(".svc-open"));
    // Ничего не меняли — уйти можно без вопроса
    const dialog = () => document.querySelector('[role="alertdialog"]');
    await type(field("Цена"), "350000");
    await click(byText("nav.side-nav a", "Заявки"));
    expect(dialog()?.textContent).toContain("Уйти без сохранения?");
    // «Остаться» — форма и вписанное на месте
    await click(byText('[role="alertdialog"] button', "Остаться"));
    expect(heading()).toBe("Услуги");
    expect(field("Цена")?.value).toBe("350\u202f000");
    // Другая витрина — тоже уход из формы: сначала вопрос
    await click(byText(".side-vitrinas button", "Lola zali"));
    expect(dialog()?.textContent).toContain("Уйти без сохранения?");
    await click(byText('[role="alertdialog"] button', "Остаться"));
    expect(field("Цена")?.value).toBe("350\u202f000");
    // «Уйти» — раздел, без вопроса в следующий раз
    await click(byText("nav.side-nav a", "Заявки"));
    await click(byText('[role="alertdialog"] button', "Уйти"));
    expect(heading()).toBe("Заявки");
    await click(byText("nav.side-nav a", "Календарь"));
    expect(dialog()).toBeNull();
    expect(heading()).toBe("Календарь");
  });

  it("правка услуги на витрине опубликованной карточки — предложением; ошибки сервера — у полей", async () => {
    const patch = `PATCH ${servicesPath}/${SVC}`;
    routes[patch] = () => ({
      status: 422,
      body: { error: { code: "invalid_input", message: "x", details: ["options.0.priceUzs"] } },
    });
    await openCarServices();
    await click(container.querySelector(".svc-open"));
    expect(container.textContent).toContain("Услуга уже на витрине: изменения уйдут на проверку");
    // Ничего не изменили — без запроса
    await click(byText(".svc-editor button", "Предложить изменения"));
    expect(sent("PATCH", `${servicesPath}/${SVC}`)).toEqual([]);
    expect(container.textContent).toContain("Вы ничего не изменили.");

    await type(field("Цена"), "350000");
    await click(byText(".svc-editor button", "Предложить изменения"));
    expect(sent("PATCH", `${servicesPath}/${SVC}`)[0]?.body).toMatchObject({
      priceUzs: 350_000,
      priceUnit: "per_hour",
      minQty: 3,
      leadDays: null,
      includes: null,
    });
    expect(container.querySelector(".svc-option-list .package-row-bad")).not.toBeNull();

    routes[patch] = () => ({
      body: saved(
        service({ proposal: { changes: { priceUzs: 350_000 }, submittedAt: new Date().toISOString() } }),
      ),
    });
    await click(byText(".svc-editor button", "Предложить изменения"));
    expect(container.querySelector(".svc-editor")).toBeNull();
    expect(container.querySelector(".svc .changes")?.textContent).toContain("Предложено: 350\u202f000 сум");
  });

  it("снять с витрины и удалить — через подтверждение", async () => {
    routes[`POST ${servicesPath}/${SVC}/withdraw`] = () => ({ body: saved(service({ status: "paused" })) });
    routes[`DELETE ${servicesPath}/${SVC}`] = () => {
      carServices = [];
      return { status: 204 };
    };
    await openCarServices();
    const dialog = () => document.querySelector('[role="alertdialog"]');
    const confirm = (text: string) =>
      [...(dialog()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === text);

    // На карточке — только «⋯»; активную не удалить — только снять
    expect(byText(".svc > button, .svc .actions button", "Снять с витрины")).toBeUndefined();
    await click(container.querySelector(".svc-more"));
    expect(document.querySelector('[role="dialog"] .menu')?.textContent).toBe("Снять с витрины");
    await click(byText('[role="dialog"] .menu-item', "Снять с витрины"));
    await settle();
    expect(dialog()?.textContent).toContain("Снять услугу с витрины?");
    await click(confirm("Снять с витрины"));
    expect(sent("POST", `${servicesPath}/${SVC}/withdraw`)).toHaveLength(1);
    expect(container.querySelector(".svc .chip")?.textContent).toBe("Снята с витрины");

    // Снятую можно удалить: «Удалить» — в той же шторке
    await menuAction(container.querySelector(".svc") ?? undefined, "Удалить");
    expect(dialog()?.textContent).toContain("Удалить услугу?");
    await click(confirm("Удалить"));
    expect(sent("DELETE", `${servicesPath}/${SVC}`)).toHaveLength(1);
    expect(container.querySelector(".svc")).toBeNull();
    expect(container.textContent).toContain("Услуг пока нет");
  });

  it("сотрудник площадки услуги только смотрит", async () => {
    routes = defaultRoutes("member");
    await openCarServices();
    expect(container.textContent).toContain("Услуги меняет владелец кабинета");
    expect(byText(".svc-name", "Машина для молодожёнов")).toBeDefined();
    expect(byText("button", "Добавить услугу")).toBeUndefined();
    // Ни нажатия на карточку, ни «⋯», ни кнопок
    expect(container.querySelector(".svc-open, .svc-more, .svc-actions")).toBeNull();
  });
});

describe("карточка по категории", () => {
  beforeEach(() => {
    resize(1280);
  });

  it("кортеж: автопарк — записи списка; в предложении — только изменённые поля витрины", async () => {
    const card = `/api/vendor/listings/${CAR}`;
    routes[`PATCH ${card}`] = () => ({
      body: { listing: LISTINGS[CAR], sentForModeration: ["attributes"] },
    });
    await mount("/card");
    await click(byText(".side-vitrinas button", "Kortej Premium"));
    expect(container.querySelector(".venue-side")?.textContent).toContain("Chevrolet Malibu · Седан");
    await click(document.querySelector('button[aria-label="Изменить: Данные витрины"]'));
    await click(byText("button", "Добавить машину"));
    const rows = document.querySelectorAll(".attr-list .package-row");
    expect(rows).toHaveLength(2);
    // Новая машина без класса — ошибка у поля записи, без запроса
    await type(rows[1]?.querySelector<HTMLInputElement>("input.field") ?? undefined, "Lincoln");
    await click(byText("button", "Отправить изменения"));
    expect(sent("PATCH", card)).toEqual([]);
    expect(rows[1]?.classList.contains("package-row-bad")).toBe(true);

    const classTrigger = rows[1]?.querySelector('button[aria-haspopup="listbox"]');
    await pick(classTrigger, "Лимузин");
    await click(byText("button", "Отправить изменения"));
    expect(sent("PATCH", card).map((c) => c.body)).toEqual([
      {
        version: 3,
        attributes: {
          fleet: [
            { model: "Chevrolet Malibu", class: "sedan" },
            { model: "Lincoln", class: "limousine" },
          ],
        },
      },
    ]);
    // Предложение ушло: окно закрыто
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("фото и видео: чего не хватает; ссылки на видео; фото людей — с их согласием (X-Photo-Consent)", async () => {
    vi.mocked(compressForUpload).mockReset();
    vi.mocked(compressForUpload).mockResolvedValue({
      blob: new Blob([new Uint8Array([9])], { type: "image/webp" }),
    } as CompressedPhoto);
    const photos = `/api/vendor/listings/${PHOTO}/photos`;
    routes[`POST ${photos}`] = () => ({
      status: 201,
      body: {
        id: "dddddddd-0000-0000-0000-000000000001",
        width: 1600,
        height: 1200,
        moderation: "pending",
        isCover: false,
        src: "https://media.example/640/p.webp",
        srcSet: "",
      },
    });
    const card = `/api/vendor/listings/${PHOTO}`;
    routes[`PATCH ${card}`] = () => ({
      status: 422,
      body: { error: { code: "invalid_input", message: "x", details: ["videoLinks.0"] } },
    });
    await mount("/card");
    await click(byText(".side-vitrinas button", "Kadr Studio"));
    // Чек-лист готовности: почему не на сайте и что сделать — каждый пункт со своей кнопкой
    const ready = container.querySelector(".readiness");
    expect(ready?.querySelector("h2")?.textContent).toBe("Что осталось до публикации");
    expect(ready?.querySelector(".lead")?.textContent).toBe(
      "Витрина ещё не на сайте. Сделайте пункты ниже — команда Bayramm проверит витрину и опубликует её.",
    );
    const todos = [...(ready?.querySelectorAll(".todo-item") ?? [])];
    expect(todos.map((li) => [...li.querySelectorAll(".todo-line")].map((line) => line.textContent))).toEqual(
      [
        ["Добавьте услугу с ценой"],
        ["Загрузите фото: есть 0 из 3"],
        // По строке на поле, подписью как в форме: не склеиваются
        ["Заполните поле «Команда»", "Заполните поле «Готовый материал через, дней»"],
      ],
    );
    // «Не готово» — значком, а не пустым квадратом
    expect(todos.every((li) => li.querySelector(".todo-mark svg") !== null)).toBe(true);
    expect(todos.map((li) => li.querySelector("button")?.firstChild?.textContent)).toEqual([
      "К услугам",
      "К фото",
      "Заполнить",
    ]);
    // «Данные витрины» — кнопкой чек-листа: открыто окно этой карточки; витрины нет на сайте —
    // «Сохранить», а не «Отправить изменения»
    await click(todos[2]?.querySelector("button"));
    const attributesDialog = document.querySelector('[role="dialog"]');
    expect(attributesDialog?.querySelector("h2")?.textContent).toBe("Данные витрины");
    expect(byText("button", "Сохранить", attributesDialog ?? document)).toBeDefined();
    expect(byText("button", "Отправить изменения", attributesDialog ?? document)).toBeUndefined();
    await click(byText("button", "Отмена", attributesDialog ?? document));
    // «Фото» — к блоку фото на этом же экране
    await click(todos[1]?.querySelector("button"));
    expect(document.activeElement?.id).toBe("photos-title");

    // Портфолио: «Что на фото» — «Лиц нет» или «Люди согласны»; ничего не выбрано заранее
    expect(container.textContent).toContain("Что на фото");
    expect(container.querySelector('.panel input[type="checkbox"][name]')).toBeNull();
    const radios = [...container.querySelectorAll<HTMLInputElement>('.upload-kind input[type="radio"]')];
    const consent = radios[1];
    const input = () => container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(radios.map((r) => r.checked)).toEqual([false, false]);
    expect(input()?.disabled).toBe(true);
    await click(consent);
    expect(input()?.disabled).toBe(false);
    const file = new File([new Uint8Array([1])], "a.jpg", { type: "image/jpeg" });
    Object.defineProperty(input(), "files", { configurable: true, value: [file] });
    await act(async () => input()?.dispatchEvent(new Event("change", { bubbles: true })));
    await flush();
    const upload = sent("POST", photos)[0];
    expect(upload?.headers.get("X-Photo-Consent")).toBe("1");
    expect(upload?.headers.get("X-No-Faces")).toBeNull();

    await click(document.querySelector('button[aria-label="Изменить: Видео"]'));
    // Ссылка не на YouTube или Instagram — ошибка до запроса
    await type(field("Ссылка на видео 1"), "https://vimeo.com/123");
    await click(byText("button", "Сохранить", document.querySelector('[role="dialog"]') ?? document));
    expect(sent("PATCH", card)).toEqual([]);
    expect(field("Ссылка на видео 1")?.getAttribute("aria-invalid")).toBe("true");
    await type(field("Ссылка на видео 1"), "https://youtu.be/dQw4w9WgXcQ");
    await click(byText("button", "Добавить ссылку"));
    await type(field("Ссылка на видео 2"), "https://www.instagram.com/reel/Cabc123/");
    await click(byText("button", "Сохранить", document.querySelector('[role="dialog"]') ?? document));
    expect(sent("PATCH", card)[0]?.body).toEqual({
      version: 3,
      videoLinks: ["https://youtu.be/dQw4w9WgXcQ", "https://www.instagram.com/reel/Cabc123/"],
    });
    // Ответ сервера про первую ссылку — подсвечена она
    expect(field("Ссылка на видео 1")?.getAttribute("aria-invalid")).toBe("true");
    expect(field("Ссылка на видео 2")?.getAttribute("aria-invalid")).toBeNull();
  });
});

describe("чек-лист готовности", () => {
  it("пункты с одним местом — один пункт: двух «Заполнить» в одно окно подряд нет", () => {
    const edits: string[] = [];
    const go = { services: () => {}, photos: () => {}, edit: (group: string) => edits.push(group) };
    const card = {
      ...(LISTINGS[HALL] as VendorListing),
      description: { ru: "", uz: "" },
      capMax: null,
      districtCode: null,
      blockers: ["price", "packages", "descriptions", "capacity", "district", "contract"],
    };
    const todos = vendorTodos(card, categoryConfig("hall"), vendorDict.ru, "ru", go);
    expect(todos.map((todo) => todo.action?.label)).toEqual(["К услугам", "Заполнить", "Заполнить"]);
    // Вместимость и район — одно окно «Место», один пункт
    expect(todos[2]?.lines).toEqual([
      "Укажите вместимость: от скольки и до скольки гостей",
      "Выберите район",
    ]);
    expect(todos[1]?.lines).toEqual(["Напишите описание на русском и узбекском"]);
    todos[1]?.action?.run();
    todos[2]?.action?.run();
    expect(edits).toEqual(["basics", "place"]);
    // Договор — дело команды: пункта партнёра для него нет
    expect(todos.flatMap((todo) => todo.lines).join(" ")).not.toMatch(/договор/i);
  });

  it("то, что уже предложено и ждёт проверки, в чек-листе второй раз не просится", () => {
    const go = { services: () => {}, photos: () => {}, edit: () => {} };
    const card = {
      ...(LISTINGS[CAR] as VendorListing),
      description: { ru: "Кортеж", uz: "" },
      blockers: ["descriptions", "attributes", "contract"],
      missingAttributes: ["service_area"],
    };
    const lines = (pending: Parameters<typeof vendorTodos>[5]) =>
      vendorTodos(card, categoryConfig("car"), vendorDict.ru, "ru", go, pending).flatMap(
        (todo) => todo.lines,
      );
    expect(lines({})).toEqual(["Напишите описание на русском и узбекском", "Заполните поле «Где работает»"]);
    // Узбекское описание предложено — описание не просится; поле витрины ещё нет
    expect(lines({ description_uz: "Kortej" })).toEqual(["Заполните поле «Где работает»"]);
    // И поле витрины предложено
    expect(lines({ description_uz: "Kortej", attributes: { service_area: "tashkent" } })).toEqual([]);
  });

  it("черновик: услуги и фото на проверке — не пункты партнёра; отклонённые фото не в счёт", () => {
    const go = { services: () => {}, photos: () => {}, edit: () => {} };
    const pending = (n: number, moderation: VendorPhoto["moderation"] = "pending"): VendorPhoto => ({
      id: `dddddddd-0000-0000-0000-00000000000${n}`,
      width: 1600,
      height: 1200,
      moderation,
      declineReason: null,
      isCover: false,
      src: "",
      srcSet: "",
    });
    const draft = {
      ...(LISTINGS[PHOTO] as VendorListing),
      // Для публикации не хватает одобренных услуг и фото — это решает команда
      blockers: ["price", "photos", "contract"],
      reviewBlockers: [],
      missingAttributes: [],
      photos: [pending(1), pending(2), pending(3)],
    };
    expect(vendorTodos(draft, categoryConfig("photo"), vendorDict.ru, "ru", go)).toEqual([]);
    const declined = { ...draft, photos: [pending(1), pending(2), pending(3, "declined")] };
    expect(
      vendorTodos(declined, categoryConfig("photo"), vendorDict.ru, "ru", go).map((todo) => todo.lines),
    ).toEqual([["Загрузите фото: есть 2 из 3"]]);
  });

  describe("«Отправить на проверку»", () => {
    const listingPath = `/api/vendor/listings/${PHOTO}`;
    const ready = (status: VendorListing["status"]): VendorListing => ({
      ...(LISTINGS[PHOTO] as VendorListing),
      status,
      priceFromUzs: 500_000,
      blockers: ["price", "photos", "contract"],
      reviewBlockers: [],
      attributes: { team: ["photographer"], delivery_days: 14 },
      missingAttributes: [],
      photos: [1, 2, 3].map((n) => ({
        id: `dddddddd-0000-0000-0000-00000000000${n}`,
        width: 1600,
        height: 1200,
        moderation: "pending" as const,
        declineReason: null,
        isCover: n === 1,
        src: "https://media.example/640/p.webp",
        srcSet: "",
      })),
    });

    beforeEach(() => resize(1280));

    it("своё сделано — кнопка; отправили — «на проверке у команды», фокус на сказанном", async () => {
      let current = ready("draft");
      routes[`GET ${listingPath}`] = () => ({ body: current });
      routes[`POST ${listingPath}/submit`] = () => {
        current = ready("review");
        return { body: current };
      };
      await mount("/card");
      await click(byText(".side-vitrinas button", "Kadr Studio"));
      const readiness = container.querySelector(".readiness");
      expect(readiness?.textContent).toContain(
        "С вашей стороны всё готово — отправьте её на проверку команде Bayramm.",
      );
      // Договор — дело команды, он ещё впереди: строкой
      expect(readiness?.textContent).toContain("Сделает команда Bayramm: договор");
      await click(byText(".readiness button", "Отправить на проверку"));
      expect(sent("POST", `${listingPath}/submit`)).toHaveLength(1);
      const after = container.querySelector(".readiness");
      expect(after?.textContent).toContain("Витрина на проверке у команды Bayramm");
      expect(byText(".readiness button", "Отправить на проверку", container)).toBeUndefined();
      const said = container.querySelector('.readiness [role="status"]');
      expect(said?.textContent).toBe("Отправили: витрина на проверке у команды Bayramm.");
      expect(document.activeElement).toBe(said);
      // Значки и статусы витрин в разделах — заново
      expect(sent("GET", "/api/vendor/me").length).toBeGreaterThan(1);
    });

    it("не всё готово (витрину успели изменить) — чего не хватает, и чек-лист заново", async () => {
      routes[`GET ${listingPath}`] = () => ({ body: ready("draft") });
      routes[`POST ${listingPath}/submit`] = () => ({
        status: 422,
        body: { error: { code: "publish_blocked", message: "x", details: ["phone", "price"] } },
      });
      await mount("/card");
      await click(byText(".side-vitrinas button", "Kadr Studio"));
      await click(byText(".readiness button", "Отправить на проверку"));
      expect(container.querySelector('.readiness [role="alert"]')?.textContent).toBe(
        "Для проверки ещё не хватает: телефон для заявок, услуга с ценой.",
      );
      expect(sent("GET", listingPath).length).toBeGreaterThan(1);
    });

    it("команда ещё не заполнила своё — кнопки нет, сказано чего ждать; сотрудник площадки не отправляет", async () => {
      routes[`GET ${listingPath}`] = () => ({ body: { ...ready("draft"), reviewBlockers: ["phone"] } });
      await mount("/card");
      await click(byText(".side-vitrinas button", "Kadr Studio"));
      expect(container.querySelector(".readiness")?.textContent).toContain(
        "Отправить на проверку можно, когда команда Bayramm заполнит: телефон для заявок.",
      );
      expect(byText(".readiness button", "Отправить на проверку", container)).toBeUndefined();
      act(() => root.unmount());
      container.remove();

      routes = defaultRoutes("member");
      routes[`GET ${listingPath}`] = () => ({ body: ready("draft") });
      await mount("/card");
      await click(byText(".side-vitrinas button", "Kadr Studio"));
      expect(container.querySelector(".readiness")?.textContent).toContain(
        "На проверку витрину отправляет владелец кабинета.",
      );
      expect(byText(".readiness button", "Отправить на проверку", container)).toBeUndefined();
    });

    it("отклонённая: исправили — отправить снова", async () => {
      routes[`GET ${listingPath}`] = () => ({
        body: { ...ready("rejected"), statusReason: "Нет фото с мероприятий" },
      });
      await mount("/card");
      await click(byText(".side-vitrinas button", "Kadr Studio"));
      const readiness = container.querySelector(".readiness");
      expect(readiness?.textContent).toContain("Если всё исправили — отправьте её на проверку снова.");
      expect(readiness?.textContent).toContain("Нет фото с мероприятий");
      expect(byText(".readiness button", "Отправить на проверку", container)).toBeDefined();
    });
  });
});

describe("календарь по модели занятости", () => {
  const base = `/api/vendor/listings/${CAR}/calendar`;
  const target = day(28) >= today ? 28 : Number(today.slice(8));

  beforeEach(() => {
    resize(1280);
    routes[`GET ${base}`] = () => ({
      body: calendar(CAR, {
        mode: "parts",
        parallelCapacity: 2,
        parts: [{ day: day(target), part: "morning", source: "vendor", requestId: null }],
        bookings: [{ day: day(target), part: "evening", count: 2 }],
      }),
    });
  });

  it("части дня: у каждого дня — отметки частей; день открывает утро, день и вечер; часть — с ?part=", async () => {
    routes[`PUT ${base}/${day(target)}`] = (_init, url) => ({
      body: {
        day: day(target),
        part: url.searchParams.get("part"),
        busy: { day: day(target), part: "day", source: "vendor", requestId: null },
        version: 5,
      },
    });
    await mount("/calendar");
    await click(byText(".side-vitrinas button", "Kortej Premium"));
    // Одна строка над месяцем — как закрыть день или часть; пока день не открыт, частей нет
    expect(container.querySelector(".page-calendar > .lead")?.textContent).toBe(
      "Нажмите на день, чтобы закрыть его целиком или по частям. Много дней сразу — «Несколько дней».",
    );
    expect(container.querySelector(".day-panel")).toBeNull();
    // Отметки частей — у каждого дня месяца
    expect(container.querySelectorAll(".cal-day .cal-parts")).toHaveLength(
      container.querySelectorAll(".cal-day").length,
    );
    const cell = container.querySelector<HTMLButtonElement>(`.cal-day[aria-label^="${target} "]`);
    expect(cell?.getAttribute("aria-label")).toContain(
      "Утро — занято, День — свободно, Вечер — Занято 2 из 2 мест",
    );
    await click(cell);
    expect(cell?.getAttribute("aria-pressed")).toBe("true");
    const parts = [...container.querySelectorAll(".day-part")].map((p) => p.textContent);
    expect(parts[0]).toContain("Утро 05:00–11:00");
    expect(parts[2]).toContain("Занято 2 из 2 мест");
    expect(container.querySelector(".day-whole")?.textContent).toContain("частично занят");
    // Часть дня — строка с переключателем «занято»: утро отметил вендор — включён и меняется;
    // вечер заняли договорённости — включён, но не переключить
    const part = (name: string) =>
      byText<HTMLLabelElement>(".day-part label", name)?.querySelector<HTMLInputElement>('[role="switch"]');
    expect(part("Утро")?.checked).toBe(true);
    expect(part("Утро")?.disabled).toBe(false);
    expect(part("Вечер")?.checked).toBe(true);
    expect(part("Вечер")?.disabled).toBe(true);
    expect(part("День")?.checked).toBe(false);

    await click(part("День"));
    const put = sent("PUT", `${base}/${day(target)}?part=day`)[0];
    expect(put?.headers.get("If-Match")).toBe("4");
    expect(part("День")?.checked).toBe(true);
  });

  it("телефон: открытый день — шторка; закрыть — она закрывается", async () => {
    resize(390);
    routes["GET /api/vendor/me"] = () => ({ body: { ...me("owner"), listings: [REFS[1]] } });
    await mount("/calendar");
    await click(container.querySelector(`.cal-day[aria-label^="${target} "]`));
    const sheet = document.querySelector('[role="dialog"]');
    expect(sheet?.querySelector(".day-part")).not.toBeNull();
    expect(container.querySelector(".cal-aside .day-panel")).toBeNull();
    // Закрыть — «×» в шапке шторки (второй кнопки внизу нет)
    await click(document.querySelector('[role="dialog"] .ui-dialog-head button[aria-label="Закрыть"]'));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("время работы — строкой у календаря; владельцу — ссылка туда, где оно меняется", async () => {
    await mount("/calendar");
    await click(byText(".side-vitrinas button", "Kortej Premium"));
    expect(container.querySelector(".sessions-line")?.textContent).toBe(
      "Время работы: утро 05:00–11:00, день 11:00–17:00, вечер 17:00–24:00 · заказов одновременно: 2Изменить",
    );
    await click(byText(".sessions-line a", "Изменить"));
    expect(heading()).toBe("Витрина");
    expect(container.querySelector("#sessions-title")?.textContent).toBe("Время работы");
  });

  it("обозначения — открыты, пока их не свернули (помнит вкладка); только то, что есть в месяце", async () => {
    routes[`GET ${base}`] = () => ({
      body: calendar(CAR, {
        mode: "parts",
        busy: [
          { day: day(target), source: "staff", requestId: null },
          { day: day(Math.max(1, target - 1)), source: "request_decline", requestId: REQUEST },
        ],
        requestDays: [day(target)],
      }),
    });
    await mount("/calendar");
    await click(byText(".side-vitrinas button", "Kortej Premium"));
    const toggle = () => byText<HTMLButtonElement>(".cal-aside .disclosure", "Обозначения", container);
    expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
    const items = [...container.querySelectorAll(".cal-legend li")].map((li) => li.textContent);
    // «занято» и «занята часть дня» в этом месяце нет; отметки частей — те, что под числами
    expect(items).toEqual([
      "занято (вы отказали: дата занята)",
      "закрыл менеджер",
      "отметка части дня: свободна",
      "отметка части дня: занята",
      "есть заявка",
      "сегодня",
    ]);
    await click(toggle());
    expect(container.querySelector(".cal-legend")).toBeNull();
    expect(window.sessionStorage.getItem("bayramm.vendor.calendar.legend")).toBe("closed");
  });

  it("торты: календаря нет — срок заказа витрины и сроки услуг, ссылки туда, где они меняются", async () => {
    await mount("/calendar");
    await click(byText(".side-vitrinas button", "Shirin Tort"));
    expect(container.querySelector(".lead-days")?.textContent).toBe(
      "Календаря у этой витрины нет: клиенты заказывают не позже чем за 3 дн.",
    );
    // Одно предложение и одна ссылка: списка сроков услуг и пояснений нет
    expect(container.querySelector(".lead-panel .packages")).toBeNull();
    expect(container.querySelector(".lead-panel")?.textContent).toBe(
      "Календаря у этой витрины нет: клиенты заказывают не позже чем за 3 дн.Изменить срок",
    );
    expect(calls.some((c) => c.path.startsWith(`/api/vendor/listings/${CAKE}/calendar`))).toBe(false);
    await click(byText(".lead-panel a", "Изменить срок"));
    expect(heading()).toBe("Витрина");
  });

  it("торты: сотруднику площадки срок только показан — ссылки на витрину нет", async () => {
    routes = defaultRoutes("member");
    await mount("/calendar");
    await click(byText(".side-vitrinas button", "Shirin Tort"));
    expect(container.querySelector(".lead-days")).not.toBeNull();
    expect(container.querySelector(".lead-panel a")).toBeNull();
  });
});

describe("«требует внимания» у витрин", () => {
  // Кортеж: две отклонённые услуги; студия: отклонённое фото и предложение; зал и торты — чисто
  const withAttention = () =>
    REFS.map((ref) =>
      ref.id === CAR
        ? { ...ref, attention: { services: 2, photos: 0, proposals: 0 } }
        : ref.id === PHOTO
          ? { ...ref, attention: { services: 0, photos: 1, proposals: 1 } }
          : ref,
    );
  const marks = () =>
    [...container.querySelectorAll(".side-vitrina")].map(
      (b) => b.querySelector(".vitrina-attn")?.textContent ?? "",
    );

  beforeEach(() => {
    routes["GET /api/vendor/me"] = () => ({ body: { ...me("owner"), listings: withAttention() } });
  });

  it("компьютер: значок раздела — по всем витринам, у витрин — где именно; на «Услугах» одни, на «Витрине» другие", async () => {
    resize(1280);
    await mount("/services");
    const link = (href: string) => container.querySelector(`.side-nav a[href="${href}"]`);
    expect(link("/services")?.querySelector(".nav-count")?.textContent).toBe("2");
    expect(link("/card")?.querySelector(".nav-count")?.textContent).toBe("2");
    expect(link("/calendar")?.querySelector(".nav-count")).toBeNull();
    expect(marks()).toEqual(["", "требует внимания: 2", "", ""]);

    await click(byText("nav.side-nav a", "Витрина"));
    expect(heading()).toBe("Витрина");
    expect(marks()).toEqual(["", "", "требует внимания: 2", ""]);

    // Календарь и заявки витрин не помечают: там значка нет
    await click(byText("nav.side-nav a", "Календарь"));
    expect(marks()).toEqual(["", "", "", ""]);
  });

  it("телефон, больше четырёх витрин: в списке выбора — слова «требует внимания» только у тех, где они есть", async () => {
    const extra: VendorListingRef = {
      id: "aaaaaaaa-0000-0000-0000-000000000105",
      name: "Gul Dekor",
      status: "active",
      categoryCode: "hall",
      attention: NONE,
    };
    routes["GET /api/vendor/me"] = () => ({
      body: { ...me("owner"), listings: [...withAttention(), extra] },
    });
    await mount("/services");
    await click(container.querySelector(".vitrina-select button"));
    expect([...document.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual([
      expect.stringMatching(/^Lola zali · [^·]+$/),
      expect.stringMatching(/^Kortej Premium · [^·]+ · требует внимания: 2$/),
      expect.stringMatching(/^Kadr Studio · [^·]+$/),
      expect.stringMatching(/^Shirin Tort · [^·]+$/),
      expect.stringMatching(/^Gul Dekor · [^·]+$/),
    ]);
  });

  it("телефон, две витрины: под названием пилюли — строка со словами, а не только цвет", async () => {
    routes["GET /api/vendor/me"] = () => ({
      body: { ...me("owner"), listings: withAttention().filter((l) => l.id !== PHOTO && l.id !== CAKE) },
    });
    await mount("/services");
    const pills = [...container.querySelectorAll(".vitrina-pills button")];
    expect(pills.map((p) => p.querySelector(".vitrina-attn")?.textContent ?? "")).toEqual([
      "",
      "требует внимания: 2",
    ]);
  });

  it("сотрудник площадки: у него нули — значков нет нигде", async () => {
    resize(1280);
    routes["GET /api/vendor/me"] = () => ({
      body: { ...me("member"), listings: REFS },
    });
    await mount("/services");
    // Значок «Заявок» — заявки, которые ждут (счётчики приходят и вне входящих); «Витрины» и «Услуг» — нет
    const counted = [...container.querySelectorAll(".side-nav a")]
      .filter((link) => link.querySelector(".nav-count"))
      .map((link) => link.getAttribute("href"));
    expect(counted.every((href) => href === "/requests")).toBe(true);
    expect(container.querySelector(".vitrina-attn")).toBeNull();
  });
});

describe("время работы витрины", () => {
  const path = `/api/vendor/listings/${CAR}/day-sessions`;

  beforeEach(() => resize(1280));

  const openCard = async () => {
    await mount("/card");
    await click(byText(".side-vitrinas button", "Kortej Premium"));
    await click(byText<HTMLButtonElement>(".sessions button", "Изменить"));
  };

  it("владелец: одно мероприятие или несколько, части, окна с шагом 30 минут — сразу, от версии календаря", async () => {
    routes[`PUT ${path}`] = () => ({ body: { sessions: LISTINGS[CAR]?.daySessions, version: 5 } });
    await mount("/card");
    await click(byText(".side-vitrinas button", "Kortej Premium"));
    const card = container.querySelector(".sessions");
    expect(card?.textContent).toContain("Несколько мероприятий в день");
    expect(card?.textContent).toContain("Утро 05:00–11:00");
    await click(byText<HTMLButtonElement>(".sessions button", "Изменить"));
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.querySelector(".ui-radios")).not.toBeNull();
    // День не работает: галочку сняли — окна дня нет
    await click(byText<HTMLLabelElement>('[role="dialog"] .sessions-row label', "День"));
    expect(dialog?.querySelectorAll(".sessions-times")).toHaveLength(2);
    // Вечер — с 18:00: время из своего списка
    await pick(byText<HTMLButtonElement>('[role="dialog"] .sessions-row button', "17:00"), "18:00");
    await click(byText<HTMLButtonElement>('[role="dialog"] button', "Сохранить"));
    const put = sent("PUT", path)[0];
    expect(put?.headers.get("If-Match")).toBe("4");
    expect(put?.body).toEqual({
      mode: "parts",
      parts: ["morning", "evening"],
      windows: { evening: { from: "18:00", to: "24:00" } },
      parallelCapacity: 2,
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("часть с будущими заявками — словами, сколько их; пересечение окон — у части, до запроса", async () => {
    routes[`PUT ${path}`] = () => ({
      status: 409,
      body: {
        error: { code: "part_in_use", message: "x", details: ["day"] },
        inUse: [{ part: "day", count: 2 }],
      },
    });
    await openCard();
    await click(byText<HTMLLabelElement>('[role="dialog"] .sessions-row label', "День"));
    await click(byText<HTMLButtonElement>('[role="dialog"] button', "Сохранить"));
    expect(document.querySelector('[role="dialog"] .form-error')?.textContent).toBe(
      "Убрать «день» нельзя: на эту часть 2 будущие заявки. Сначала ответьте на них.",
    );
    // Утро до 13:00 — пересекает день: ошибка у дня, запрос не уходит
    await click(byText<HTMLLabelElement>('[role="dialog"] .sessions-row label', "День"));
    await pick(byText<HTMLButtonElement>('[role="dialog"] .sessions-row button', "11:00"), "13:00");
    const before = sent("PUT", path).length;
    await click(byText<HTMLButtonElement>('[role="dialog"] button', "Сохранить"));
    expect(sent("PUT", path)).toHaveLength(before);
    expect(document.querySelector('[role="dialog"] .sessions-row.is-invalid')?.textContent).toContain("День");
  });

  it("сотрудник площадки — только смотрит", async () => {
    routes = defaultRoutes("member");
    await mount("/card");
    await click(byText(".side-vitrinas button", "Kortej Premium"));
    expect(container.querySelector(".sessions")?.textContent).toContain("Несколько мероприятий в день");
    expect(byText(".sessions button", "Изменить", container)).toBeUndefined();
  });
});
