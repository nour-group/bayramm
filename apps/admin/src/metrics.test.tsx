// @vitest-environment jsdom
// Метрики запуска в панели: раздел (очереди, сводка по категориям, недели и вендоры с фильтром
// категории и сортировкой по доле ответов в срок), ответы вендора по витринам с категориями на
// его странице, пауза напоминаний в настройках. API — подменённый fetch
import type {
  CategoryMetricsList,
  ContactMetrics,
  MetricsOverview,
  StaffDictionaries,
  StaffMe,
  StaffSettings,
  VendorDetail,
  VendorMetrics,
  VendorMetricsList,
  VendorResponseStats,
  WeeklyMetrics,
} from "@bayramm/shared/api/staff";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { categoryName } from "./categories";
import { barClass, sortVendors } from "./pages/Metrics";
import { tokenStore } from "./session";
import { t } from "./texts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const TOKEN = "T".repeat(43);
const ME_ID = "00000000-0000-0000-0000-00000000a001";
const VENDOR_A = "aaaaaaaa-0000-0000-0000-000000000001";
const VENDOR_B = "aaaaaaaa-0000-0000-0000-000000000002";
const VENDOR_C = "aaaaaaaa-0000-0000-0000-000000000003";
const LISTING_ID = "bbbbbbbb-0000-0000-0000-000000000001";

const MODERATOR: StaffMe = {
  id: ME_ID,
  role: "moderator",
  displayName: "Test moderator",
  username: null,
  permissions: ["catalog.read", "listings.publish", "listings.moderate", "metrics.read"],
};
const ADMIN: StaffMe = {
  ...MODERATOR,
  role: "admin",
  displayName: "Test admin",
  permissions: ["catalog.read", "vendors.write", "settings.write", "metrics.read"],
};

const DICT: StaffDictionaries = {
  categories: [],
  districts: [],
  occasions: [],
  staff: [],
  settings: { minPhotos: 3, maxPhotos: 10, slaHours: 12 },
};

const WEEK: WeeklyMetrics = {
  weekStart: "2026-09-21",
  weekLabel: "2026-W39",
  partial: false,
  requests: 7,
  clients: 5,
  measurable: 6,
  answeredInTime: 3,
  answeredRate: 50,
  responded: 4,
  medianResponseMinutes: 330,
  p90ResponseMinutes: 696,
  agreed: 2,
  agreedRate: 28.6,
  slaBreaches: 2,
  deadNotifications: 1,
};

const OVERVIEW: MetricsOverview = {
  slaHours: 12,
  category: null,
  weeks: [
    {
      ...WEEK,
      weekStart: "2026-09-28",
      weekLabel: "2026-W40",
      partial: true,
      requests: 1,
      measurable: 0,
      answeredInTime: 0,
      answeredRate: null,
      medianResponseMinutes: null,
      p90ResponseMinutes: null,
    },
    WEEK,
  ],
  queues: { awaiting: 3, overdue: 1, deadTotal: 0, listingsReview: 2, revisionsPending: 1, photosPending: 0 },
};

const vendorRow = (id: string, code: string, rate: number | null, requests: number): VendorMetrics => ({
  vendor: { id, code, name: `Hall ${code}` },
  activeListings: 1,
  categories: ["hall"],
  requests,
  measurable: requests,
  answeredInTime: rate === null ? 0 : Math.round((rate / 100) * requests),
  answeredRate: rate,
  responded: requests,
  medianResponseMinutes: rate === null ? null : 60,
  slaBreaches: 0,
  agreed: 0,
  lastRequestAt: "2026-09-30T05:00:00.000Z",
});

const VENDORS: VendorMetricsList = {
  days: 30,
  category: null,
  items: [
    vendorRow(VENDOR_A, "V101", 80, 5),
    vendorRow(VENDOR_B, "V102", null, 0),
    vendorRow(VENDOR_C, "V103", 20, 9),
  ],
};

const CATEGORY_METRICS: CategoryMetricsList = {
  days: 30,
  items: [
    {
      ...vendorRow(VENDOR_A, "V101", 70, 10),
      categoryCode: "hall",
      activeListings: 4,
      activeVendors: 3,
      clients: 8,
      p90ResponseMinutes: 600,
      agreedRate: 20,
    },
    {
      ...vendorRow(VENDOR_C, "V103", null, 0),
      categoryCode: "car",
      activeListings: 1,
      activeVendors: 1,
      clients: 0,
      p90ResponseMinutes: null,
      agreedRate: null,
    },
  ],
};

const CONTACTS: ContactMetrics = {
  days: 30,
  category: null,
  items: [
    {
      listing: { id: LISTING_ID, name: "Oqsaroy Hall", status: "active", categoryCode: "hall" },
      vendor: { id: VENDOR_A, name: "Hall V101" },
      opens: 48,
      phone: 21,
      telegram: 9,
      opensPrev: 40,
    },
    {
      listing: {
        id: "bbbbbbbb-0000-0000-0000-000000000002",
        name: "Oq kortej",
        status: "review",
        categoryCode: "car",
      },
      vendor: { id: VENDOR_C, name: "Hall V103" },
      opens: 5,
      phone: 0,
      telegram: 2,
      opensPrev: 9,
    },
  ],
};

interface Call {
  method: string;
  url: string;
  body: unknown;
}

let container: HTMLDivElement;
let root: Root;
let calls: Call[];

type Handler = (body: unknown) => Response;
const json =
  (body: unknown, status = 200): Handler =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function mockApi(me: StaffMe, handlers: Record<string, Handler>) {
  window.sessionStorage.setItem("bayramm.admin.session", TOKEN);
  const all: Record<string, Handler> = {
    "GET /api/staff/me": json(me),
    "GET /api/staff/dictionaries": json(DICT),
    ...handlers,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const url = String(input);
      const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ method, url, body });
      const key = Object.keys(all).find(
        (k) => k === `${method} ${url}` || `${method} ${url}`.startsWith(`${k}?`),
      );
      return key ? (all[key] as Handler)(body) : new Response("{}", { status: 404 });
    }),
  );
}

const settle = () =>
  act(async () => {
    for (let i = 0; i < 12; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function mount(path: string) {
  window.history.replaceState(null, "", path);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<App />));
  await settle();
}

async function click(element: Element | null | undefined) {
  await act(async () => (element as HTMLElement | undefined)?.click());
  await settle();
}

const text = () => container.textContent ?? "";
/** Коды вендоров в таблице — по порядку строк */
const vendorOrder = () =>
  [...container.querySelectorAll("section[aria-labelledby='vendors-metrics-title'] tbody tr")].map(
    (tr) => /V\d+/.exec(tr.textContent ?? "")?.[0],
  );
const sortButton = (label: string) =>
  [...container.querySelectorAll("button.sort")].find((b) => b.textContent?.startsWith(label));

beforeEach(() => {
  calls = [];
  window.scrollTo = () => {};
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  tokenStore.clear();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});

// ════════════════════════════════════════════════════════════════════════════

describe("раздел «Метрики»", () => {
  it("модератор видит очереди, недели и вендоров; худшие по доле ответов — сверху, пустые — внизу", async () => {
    mockApi(MODERATOR, {
      "GET /api/staff/metrics": json(OVERVIEW),
      "GET /api/staff/metrics/vendors": json(VENDORS),
      "GET /api/staff/metrics/categories": json(CATEGORY_METRICS),
    });
    await mount("/metrics");
    const nav = [...container.querySelectorAll(".nav a")].map((a) => a.textContent);
    expect(nav).toContain(t.metrics);
    expect(container.querySelector("h1")?.textContent).toBe(t.metrics);

    // очереди: просрочка выделена, пустое недоставленное — нет
    const stats = [...container.querySelectorAll(".stat")];
    expect(stats).toHaveLength(6);
    expect(stats[1]?.className).toContain("stat-warn");
    expect(stats[2]?.className).not.toContain("stat-warn");

    // недели: текущая — «идёт», пустая доля — прочерк; прошлая — 50 % (3 из 6), медиана и 90%
    const weeks = [...container.querySelectorAll("section[aria-labelledby='weekly-title'] tbody tr")];
    expect(weeks[0]?.textContent).toContain(t.weekNow);
    expect(weeks[0]?.textContent).toContain(t.none);
    expect(weeks[1]?.textContent).toContain("50 %");
    expect(weeks[1]?.textContent).toContain(t.answeredOf(3, 6));
    expect(weeks[1]?.textContent).toContain(t.medianTime("5 ч 30 мин"));
    expect(weeks[1]?.textContent).toContain(t.p90Time("11 ч 36 мин"));
    expect(weeks[1]?.querySelector(".bar-fill")?.className).toContain("bar-w5");
    expect(text()).toContain(t.metricsWeeklyHint(12));

    expect(vendorOrder()).toEqual(["V103", "V101", "V102"]);
    // сортировка — в заголовке столбца
    const rateHeader = sortButton(t.colAnswered)?.closest("th");
    expect(rateHeader?.getAttribute("aria-sort")).toBe("ascending");
    await click(sortButton(t.colAnswered));
    expect(vendorOrder()).toEqual(["V101", "V103", "V102"]);
    expect(rateHeader?.getAttribute("aria-sort")).toBe("descending");
    await click(sortButton(t.colRequests));
    expect(vendorOrder()).toEqual(["V103", "V101", "V102"]);
    expect(rateHeader?.getAttribute("aria-sort")).toBe("none");

    expect(calls.filter((c) => c.url.startsWith("/api/staff/metrics")).every((c) => c.method === "GET")).toBe(
      true,
    );
  });

  it("сводка по категориям; фильтр категории — у недель и вендоров, очереди — все", async () => {
    mockApi(MODERATOR, {
      "GET /api/staff/metrics": json(OVERVIEW),
      "GET /api/staff/metrics/vendors": json(VENDORS),
      "GET /api/staff/metrics/categories": json(CATEGORY_METRICS),
    });
    await mount("/metrics");
    const rows = [
      ...container.querySelectorAll("section[aria-labelledby='categories-metrics-title'] tbody tr"),
    ];
    expect(rows.map((tr) => tr.querySelector("th")?.firstChild?.textContent)).toEqual([
      categoryName("hall"),
      categoryName("car"),
    ]);
    expect(rows[0]?.textContent).toContain(t.activeVendors(3));
    expect(rows[0]?.textContent).toContain("70 %");
    expect(rows[1]?.textContent).toContain(t.none);
    // У вендора — категории его витрин
    expect(
      container.querySelector("section[aria-labelledby='vendors-metrics-title']")?.textContent,
    ).toContain(categoryName("hall"));

    await click(container.querySelector("button[aria-haspopup=listbox]"));
    await click(
      [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent === categoryName("car")),
    );
    expect(calls.some((c) => c.url === "/api/staff/metrics?category=car")).toBe(true);
    expect(calls.some((c) => c.url === "/api/staff/metrics/vendors?category=car")).toBe(true);
    // Сводка по категориям от фильтра не зависит
    expect(calls.filter((c) => c.url.startsWith("/api/staff/metrics/categories"))).toHaveLength(1);
    expect(text()).toContain(t.metricsCategoryFilter(categoryName("car")));
  });

  it("«Контакты витрин»: за 30 дней, витрина — ссылкой; открыли, позвонить, Telegram — числами", async () => {
    mockApi(MODERATOR, {
      "GET /api/staff/metrics": json(OVERVIEW),
      "GET /api/staff/metrics/vendors": json(VENDORS),
      "GET /api/staff/metrics/categories": json(CATEGORY_METRICS),
      "GET /api/staff/metrics/contacts": json(CONTACTS),
    });
    await mount("/metrics");
    expect(calls.some((c) => c.url === "/api/staff/metrics/contacts?days=30")).toBe(true);
    const section = container.querySelector("section[aria-labelledby='contacts-metrics-title']");
    expect(section?.querySelector("h2")?.textContent).toBe(t.metricsContacts);
    const rows = [...(section?.querySelectorAll("tbody tr") ?? [])];
    expect(rows).toHaveLength(2);
    // Как пришло с сервера: чаще открывают — сверху
    expect(rows[0]?.querySelector("a.row-link")?.getAttribute("href")).toBe(`/listings/${LISTING_ID}`);
    const cells = [...(rows[0]?.querySelectorAll("td") ?? [])];
    // Число — первым узлом ячейки; изменение к предыдущим 30 дням — под ним
    expect(cells.map((td) => td.firstChild?.textContent)).toEqual(["48", "21", "9"]);
    // Рост — со знаком и «было»; диктору то же словами: смысл не держится на цвете
    expect(cells[0]?.querySelector("[aria-hidden='true']")?.textContent).toBe("+8 · было 40");
    expect(cells[0]?.querySelector(".visually-hidden")?.textContent).toBe(
      "На 8 больше, чем за предыдущие 30 дней: тогда было 40.",
    );
    const fall = rows[1]?.querySelector("td");
    expect(fall?.querySelector("[aria-hidden='true']")?.textContent).toBe("−4 · было 9");
    expect(fall?.querySelector(".visually-hidden")?.textContent).toBe(
      "На 4 меньше, чем за предыдущие 30 дней: тогда было 9.",
    );
    expect(rows[0]?.textContent).toContain(categoryName("hall"));
    expect(rows[0]?.textContent).toContain("Hall V101");
    expect(rows[1]?.textContent).toContain(t.status.review);
    expect([...(section?.querySelectorAll("th[scope=col]") ?? [])].map((th) => th.textContent)).toEqual([
      t.listings,
      t.colContactOpens,
      t.colContactPhone,
      t.colContactTelegram,
    ]);
  });

  it("изменение открытий: рост, спад и «без изменений» — знаком и словами", () => {
    expect(t.opensChange(12, 8)).toBe("+4 · было 8");
    expect(t.opensChange(3, 10)).toBe("−7 · было 10");
    expect(t.opensChange(0, 0)).toBe("без изменений · было 0");
    expect(t.opensChange(5, 0)).toBe("+5 · было 0");
    expect(t.opensChangeSpoken(7, 7, 30)).toBe("Столько же, сколько за предыдущие 30 дней: 7.");
  });

  it("«Контакты витрин»: фильтр категории уходит и в них; нет контактов — пустое состояние", async () => {
    mockApi(MODERATOR, {
      "GET /api/staff/metrics": json(OVERVIEW),
      "GET /api/staff/metrics/vendors": json(VENDORS),
      "GET /api/staff/metrics/categories": json(CATEGORY_METRICS),
      "GET /api/staff/metrics/contacts": (body) =>
        calls.at(-1)?.url.includes("category=car")
          ? json({ ...CONTACTS, category: "car", items: [] })(body)
          : json(CONTACTS)(body),
    });
    await mount("/metrics");
    // До выбора — подпись говорит, что фильтр сужает и контакты
    expect(text()).toContain(t.metricsFilterScope);
    await click(container.querySelector("button[aria-haspopup=listbox]"));
    await click(
      [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent === categoryName("car")),
    );
    expect(calls.some((c) => c.url === "/api/staff/metrics/contacts?days=30&category=car")).toBe(true);
    const section = container.querySelector("section[aria-labelledby='contacts-metrics-title']");
    expect(section?.querySelector(".empty")?.textContent).toBe(t.metricsContactsEmpty);
    expect(section?.querySelector("table")).toBeNull();
  });

  it("не ответили контакты — остальные блоки на месте, у блока своя ошибка с «Повторить»", async () => {
    mockApi(MODERATOR, {
      "GET /api/staff/metrics": json(OVERVIEW),
      "GET /api/staff/metrics/vendors": json(VENDORS),
      "GET /api/staff/metrics/categories": json(CATEGORY_METRICS),
      "GET /api/staff/metrics/contacts": json({ error: { code: "internal_error" } }, 500),
    });
    await mount("/metrics");
    expect(vendorOrder()).toEqual(["V103", "V101", "V102"]);
    const section = container.querySelector("section[aria-labelledby='contacts-metrics-title']");
    expect(section?.querySelector("[role=alert]")).not.toBeNull();
    expect([...(section?.querySelectorAll("button") ?? [])].some((b) => b.textContent === t.retry)).toBe(
      true,
    );
  });

  it("недели — «неделя N», а не ISO-метка", async () => {
    mockApi(MODERATOR, {
      "GET /api/staff/metrics": json(OVERVIEW),
      "GET /api/staff/metrics/vendors": json(VENDORS),
      "GET /api/staff/metrics/categories": json(CATEGORY_METRICS),
      "GET /api/staff/metrics/contacts": json(CONTACTS),
    });
    await mount("/metrics");
    const weeks = container.querySelector("section[aria-labelledby='weekly-title']")?.textContent ?? "";
    expect(weeks).toContain(t.weekNumber(39));
    expect(weeks).toContain(t.weekNumber(40));
    expect(weeks).not.toContain("W39");
  });

  it("без права metrics.read раздела нет в навигации", async () => {
    mockApi(
      { ...MODERATOR, permissions: ["catalog.read"] },
      {
        "GET /api/staff/vendors": json({ total: 0, items: [] }),
      },
    );
    await mount("/vendors");
    const nav = [...container.querySelectorAll(".nav a")].map((a) => a.textContent);
    expect(nav).not.toContain(t.metrics);
  });

  it("полоса — классом с шагом 10 %; меньше половины — тревога", () => {
    expect(barClass(null)).toBe("bar-fill bar-w0");
    expect(barClass(64)).toBe("bar-fill bar-w6");
    expect(barClass(100)).toBe("bar-fill bar-w10");
    expect(barClass(49.9)).toBe("bar-fill bar-w5 bar-low");
    expect(barClass(50)).toBe("bar-fill bar-w5");
  });

  it("сортировка: пустые значения всегда внизу, при равенстве — по коду", () => {
    const items = [
      vendorRow(VENDOR_B, "V110", null, 0),
      vendorRow(VENDOR_A, "V102", 50, 2),
      vendorRow(VENDOR_C, "V101", 50, 2),
    ];
    for (const dir of ["asc", "desc"] as const)
      expect(sortVendors(items, { key: "rate", dir }).map((v) => v.vendor.code)).toEqual([
        "V101",
        "V102",
        "V110",
      ]);
  });
});

describe("страница вендора: ответы на заявки", () => {
  const VENDOR: VendorDetail = {
    id: VENDOR_A,
    code: "V101",
    name: "Oqsaroy",
    legalForm: null,
    contractNo: null,
    manager: null,
    createdAt: "2026-09-29T06:00:00.000Z",
    updatedAt: "2026-09-29T06:00:00.000Z",
    contacts: {
      legalName: null,
      stir: null,
      legalAddress: null,
      contactPerson: null,
      contactRole: null,
      telegramUsername: null,
    },
    checklist: {
      contract: { done: false, at: null, by: null },
      stir: { done: false, at: null, by: null },
      contacts: { done: false, at: null, by: null },
      pdConsent: { done: false, at: null, by: null },
    },
    users: [],
    listings: [],
  };

  it("за 30 дней: заявки, доля в срок, медиана; витрины с категориями — если их несколько", async () => {
    const stats: VendorResponseStats = {
      days: 30,
      vendor: vendorRow(VENDOR_A, "V101", 60, 5),
      listings: [
        {
          ...vendorRow(VENDOR_A, "V101", 60, 3),
          listing: { id: LISTING_ID, name: "Zal 1", status: "active", categoryCode: "hall" },
        },
        {
          ...vendorRow(VENDOR_A, "V101", 50, 2),
          listing: {
            id: "bbbbbbbb-0000-0000-0000-000000000002",
            name: "Kortej",
            status: "suspended",
            categoryCode: "car",
          },
        },
      ],
    };
    mockApi(ADMIN, {
      [`GET /api/staff/vendors/${VENDOR_A}`]: json(VENDOR),
      [`GET /api/staff/metrics/vendors/${VENDOR_A}`]: json(stats),
    });
    await mount(`/vendors/${VENDOR_A}`);
    const panel = container.querySelector("section[aria-labelledby='response-title']");
    expect(panel?.textContent).toContain(t.vendorResponse);
    expect(panel?.textContent).toContain("60 %");
    expect(panel?.textContent).toContain("1 ч");
    expect(panel?.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(panel?.textContent).toContain("Kortej");
    expect([...(panel?.querySelectorAll("tbody .cat-chip") ?? [])].map((c) => c.textContent)).toEqual([
      categoryName("hall"),
      categoryName("car"),
    ]);
    expect(panel?.textContent).toContain(t.vendorCategories);
  });

  it("заявок не было — так и написано", async () => {
    mockApi(ADMIN, {
      [`GET /api/staff/vendors/${VENDOR_A}`]: json(VENDOR),
      [`GET /api/staff/metrics/vendors/${VENDOR_A}`]: json({
        days: 30,
        vendor: vendorRow(VENDOR_A, "V101", null, 0),
        listings: [],
      }),
    });
    await mount(`/vendors/${VENDOR_A}`);
    expect(text()).toContain(t.vendorResponseEmpty);
  });
});

describe("настройки: пауза между напоминаниями", () => {
  it("своя форма с подписью и подсказкой; значение уходит числом", async () => {
    const settings: StaffSettings = {
      items: [
        {
          key: "ops_reminder_pause_minutes",
          value: 30,
          updatedAt: "2026-09-01T06:00:00.000Z",
          updatedBy: null,
        },
      ],
    };
    mockApi(ADMIN, {
      "GET /api/staff/settings": json(settings),
      "PUT /api/staff/settings/ops_reminder_pause_minutes": json({
        items: [{ ...settings.items[0], value: 45 }],
      }),
    });
    await mount("/settings");
    const form = container.querySelector("form.setting");
    expect(form?.textContent).toContain(t.settingsLabels.ops_reminder_pause_minutes);
    expect(form?.textContent).toContain(t.settingsHints.ops_reminder_pause_minutes);
    const input = form?.querySelector("input") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(input, "45");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(form?.querySelector("button[type=submit]"));
    expect(calls.at(-1)).toMatchObject({
      method: "PUT",
      url: "/api/staff/settings/ops_reminder_pause_minutes",
      body: { value: 45 },
    });
  });
});
