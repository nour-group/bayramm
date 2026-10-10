// @vitest-environment jsdom
// Панель на телефоне: нижняя панель разделов роли и «Ещё», счётчики из очередей, шапка с
// «назад» (своей или Telegram), списки карточками, фильтры в шторке, действия — в панели
// внизу. Ширина — подменённый matchMedia (как у телефона 390px).
import type {
  ClientList,
  MetricsOverview,
  StaffDictionaries,
  StaffMe,
  StaffRequestDetail,
  StaffRequestList,
  TeamList,
  VendorDetail,
} from "@bayramm/shared/api/staff";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { badgesOf, initialsOf } from "./Shell";
import { tokenStore } from "./session";
import { t } from "./texts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const TOKEN = "T".repeat(43);
const REQUEST_ID = "cccccccc-0000-0000-0000-000000000001";
const LISTING_ID = "bbbbbbbb-0000-0000-0000-000000000001";
const VENDOR_ID = "aaaaaaaa-0000-0000-0000-000000000001";

const ADMIN: StaffMe = {
  id: "00000000-0000-0000-0000-00000000a001",
  role: "admin",
  displayName: "Test Admin",
  username: null,
  permissions: [
    "catalog.read",
    "vendors.write",
    "listings.write",
    "requests.read",
    "requests.write",
    "clients.read",
    "outbox.read",
    "audit.read",
    "team.manage",
    "settings.write",
    "metrics.read",
    "vendors.delete",
  ],
};

const MANAGER: StaffMe = {
  ...ADMIN,
  role: "manager",
  displayName: "Test Manager",
  permissions: ["catalog.read", "requests.read", "requests.write", "clients.read", "outbox.read"],
};

const DICT: StaffDictionaries = {
  categories: [],
  districts: [],
  occasions: [{ code: "toy", nameRu: "Свадьба", nameUz: "Toʻy" }],
  staff: [],
  settings: { minPhotos: 3, maxPhotos: 10, slaHours: 12 },
};

const QUEUES = {
  awaiting: 4,
  overdue: 2,
  deadTotal: 1,
  listingsReview: 1,
  revisionsPending: 2,
  photosPending: 0,
};
const METRICS: MetricsOverview = { slaHours: 12, category: null, weeks: [], queues: QUEUES };

const REQUEST: StaffRequestDetail = {
  id: REQUEST_ID,
  publicNo: 1001,
  status: "new",
  sla: "overdue",
  slaDueAt: "2026-09-29T06:00:00.000Z",
  firstResponseAt: null,
  firstResponseBy: null,
  occasionCode: "toy",
  eventDate: "2026-11-10",
  guests: 150,
  dayPart: null,
  details: {},
  createdAt: "2026-09-28T18:00:00.000Z",
  listing: { id: LISTING_ID, name: "Oqsaroy Hall", categoryCode: "hall" },
  vendor: { id: VENDOR_ID, code: "V101", name: "Oqsaroy" },
  reminders: 0,
  budgetMinUzs: null,
  budgetMaxUzs: null,
  declineReason: null,
  declineNote: null,
  firstViewedAt: null,
  slaBreachedAt: null,
  source: "tma",
  contactName: "Client",
  comment: null,
  contactPurged: false,
  history: [],
  timeline: [],
  notes: [],
  awaiting: true,
  vendorReachable: 1,
  nextReminderAt: null,
};

const LIST: StaffRequestList = {
  total: 1,
  items: [REQUEST],
  counts: { waiting: 0, overdue: 1, breached: 0, answered: 0, answered_late: 0, ops_contacted: 0, closed: 0 },
};

let container: HTMLDivElement;
let root: Root;
let calls: string[];

type Handler = () => Response;
const json =
  (body: unknown, status = 200): Handler =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function mockApi(me: StaffMe, handlers: Record<string, Handler> = {}) {
  window.sessionStorage.setItem("bayramm.admin.session", TOKEN);
  const all: Record<string, Handler> = {
    "GET /api/staff/me": json(me),
    "GET /api/staff/dictionaries": json(DICT),
    "GET /api/staff/metrics": json(METRICS),
    "GET /api/staff/requests": json(LIST),
    [`GET /api/staff/requests/${REQUEST_ID}`]: json(REQUEST),
    ...handlers,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const key = `${init.method ?? "GET"} ${String(input)}`;
      calls.push(key);
      const found = Object.keys(all).find((k) => k === key || key.startsWith(`${k}?`));
      return found ? (all[found] as Handler)() : new Response("{}", { status: 404 });
    }),
  );
}

/** Ширина окна для медиазапросов (max-width: Npx) */
function screenWidth(width: number) {
  vi.stubGlobal("matchMedia", (query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    return {
      matches: max ? width <= Number(max[1]) : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  });
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
  await act(async () => (element as HTMLElement | null | undefined)?.click());
  await settle();
}

const tabs = () => [...container.querySelectorAll<HTMLElement>("nav.tabbar > *")];
const dialog = () => document.querySelector<HTMLElement>("[role=dialog]");
const byLabel = (label: string) =>
  [...document.querySelectorAll<HTMLElement>("[aria-label]")].find(
    (el) => el.getAttribute("aria-label") === label,
  );

beforeEach(() => {
  calls = [];
  window.scrollTo = () => {};
  screenWidth(390);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  tokenStore.clear();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
  delete (window as { Telegram?: unknown }).Telegram;
});

describe("телефон: оболочка", () => {
  it("нижняя панель: четыре частых раздела роли и «Ещё»; шапки с разделами в строку нет", async () => {
    mockApi(ADMIN);
    await mount("/requests");
    expect(container.querySelector("header.top")).toBeNull();
    expect(container.querySelector("header.appbar")).not.toBeNull();
    expect(tabs().map((tab) => tab.querySelector(".tab-label")?.textContent)).toEqual([
      "Заявки",
      "Модерация",
      "Вендоры",
      "Метрики",
      t.more,
    ]);
    expect(tabs()[0]?.getAttribute("aria-current")).toBe("page");
  });

  it("пять ежедневных разделов — все в панели, без «Ещё»", async () => {
    mockApi({
      ...MANAGER,
      permissions: ["catalog.read", "requests.read", "metrics.read", "clients.read"],
    });
    await mount("/requests");
    expect(tabs().map((tab) => tab.tagName)).toEqual(["A", "A", "A", "A", "A"]);
    expect(container.querySelector("nav.tabbar button")).toBeNull();
  });

  it("пять разделов, среди них уведомления: четыре кнопки и «Ещё»; подписи — названия целиком", async () => {
    // Раньше «Уведомления» вставали пятой кнопкой подписью «Уведомл.»
    mockApi(MANAGER);
    await mount("/requests");
    const labels = tabs().map((tab) => tab.querySelector(".tab-label")?.textContent);
    expect(labels).toEqual([t.requests, t.moderation, t.vendors, t.clients, t.more]);
    for (const label of labels) expect(label).not.toMatch(/\.$/);
    expect(container.querySelector("nav.tabbar button")?.textContent).toContain(t.more);
  });

  it("счётчики — из очередей метрик, одним лёгким запросом; для диктора — словами", async () => {
    mockApi(ADMIN);
    await mount("/requests");
    expect(calls).toContain("GET /api/staff/metrics?weeks=1");
    const requests = tabs()[0];
    expect(requests?.querySelector(".badge")?.textContent).toBe("2");
    expect(requests?.textContent).toContain(t.badges.requests(2));
    expect(tabs()[1]?.querySelector(".badge")?.textContent).toBe("3");
    // Недоставленное — в «Ещё» (уведомления): точка на «Ещё»
    expect(tabs()[4]?.querySelector(".badge-dot")).not.toBeNull();
  });

  it("без права метрик счётчиков нет и запроса за ними — тоже", async () => {
    mockApi(MANAGER);
    await mount("/requests");
    expect(calls.some((c) => c.includes("/staff/metrics"))).toBe(false);
    expect(container.querySelector(".badge")).toBeNull();
  });

  it("«Ещё» — шторка с остальными разделами; переход закрывает её, «Ещё» говорит, что открыто", async () => {
    mockApi(ADMIN);
    await mount("/requests");
    await click(tabs()[4]);
    const sheet = dialog();
    expect(sheet?.getAttribute("aria-modal")).toBe("true");
    const links = [...(sheet?.querySelectorAll("a") ?? [])];
    expect(links.map((a) => a.textContent)).toEqual([
      "Клиенты",
      `Уведомления1, ${t.badges.notifications(1)}`,
      "Журнал",
      "Команда",
      "Настройки",
    ]);
    // Страница под шторкой недоступна
    expect(container.hasAttribute("inert")).toBe(true);
    await click(links.find((a) => a.textContent === "Команда"));
    expect(dialog()).toBeNull();
    expect(window.location.pathname).toBe("/team");
    expect(container.querySelector("h1")?.textContent).toBe("Команда");
    expect(tabs()[4]?.getAttribute("aria-label")).toBe(t.moreCurrent("Команда"));
  });

  it("аккаунт — кнопкой в шапке: имя и роль, выход", async () => {
    mockApi(ADMIN);
    await mount("/requests");
    const account = byLabel(t.accountOf(ADMIN.displayName, t.roles.admin));
    expect(account?.textContent).toBe(initialsOf(ADMIN.displayName));
    await click(account);
    expect(dialog()?.textContent).toContain(ADMIN.displayName);
    expect([...(dialog()?.querySelectorAll("button") ?? [])].some((b) => b.textContent === t.signOut)).toBe(
      true,
    );
  });

  it("экран объекта: «назад» в шапке ведёт к списку раздела; в разделе — нет", async () => {
    mockApi(ADMIN);
    await mount(`/requests/${REQUEST_ID}`);
    const back = byLabel(t.back);
    expect(back).toBeDefined();
    await click(back);
    expect(window.location.pathname).toBe("/requests");
    expect(byLabel(t.back)).toBeUndefined();
  });

  it("в Telegram «назад» — кнопка Telegram: показана на экране объекта, своей в шапке нет", async () => {
    const handlers: (() => void)[] = [];
    const BackButton = {
      show: vi.fn(),
      hide: vi.fn(),
      onClick: vi.fn((h: () => void) => handlers.push(h)),
      offClick: vi.fn(),
    };
    Object.assign(window, {
      Telegram: {
        WebApp: {
          initData: "query_id=1&hash=abc",
          initDataUnsafe: {},
          isVersionAtLeast: () => true,
          ready: vi.fn(),
          expand: vi.fn(),
          BackButton,
        },
      },
    });
    mockApi(ADMIN);
    await mount(`/requests/${REQUEST_ID}`);
    expect(byLabel(t.back)).toBeUndefined();
    expect(BackButton.show).toHaveBeenCalled();
    expect(document.documentElement.classList.contains("in-telegram")).toBe(true);
    await act(async () => handlers.at(-1)?.());
    await settle();
    expect(window.location.pathname).toBe("/requests");
    expect(BackButton.hide).toHaveBeenCalled();
  });
});

describe("телефон: экраны", () => {
  it("заявки — карточками, а не таблицей; вся карточка — ссылка на заявку", async () => {
    mockApi(ADMIN);
    await mount("/requests");
    expect(container.querySelector("table")).toBeNull();
    const card = container.querySelector(".rcard");
    expect(card?.querySelector("a.rcard-link")?.getAttribute("href")).toBe(`/requests/${REQUEST_ID}`);
    expect(card?.textContent).toContain(t.sla.overdue);
    // Чья заявка — имя клиента первой строкой фактов
    expect(card?.querySelector(".rcard-facts dt")?.textContent).toBe(t.colClient);
    expect(card?.querySelector(".rcard-facts dd")?.textContent).toBe("Client");
  });

  it("фильтры — в шторке: выбор уходит на сервер, кнопка говорит «Фильтры (1)», снять — одним нажатием", async () => {
    mockApi(ADMIN);
    await mount("/requests");
    const open = [...container.querySelectorAll("button")].find((b) => b.textContent === t.filters);
    await click(open);
    const late = [...(dialog()?.querySelectorAll<HTMLInputElement>("input[type=radio]") ?? [])].find(
      (input) => input.value === "late",
    );
    await click(late);
    expect(calls.some((c) => c.startsWith("GET /api/staff/requests?") && c.includes("sla=late"))).toBe(true);
    const done = [...(dialog()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === t.done);
    await click(done);
    expect(dialog()).toBeNull();
    expect(container.textContent).toContain(`${t.filters} (1)`);
    await click(byLabel(`${t.reset}: ${t.slaLate}`));
    expect(container.textContent).not.toContain(`${t.filters} (1)`);
  });

  it("заявка: «Напомнить» и «Связались» — в панели внизу страницы; «Связались» — в шторке", async () => {
    mockApi(ADMIN);
    await mount(`/requests/${REQUEST_ID}`);
    const bar = container.querySelector(".actionbar-slot .actionbar");
    expect(bar?.getAttribute("aria-label")).toBe(t.requestActions);
    expect([...(bar?.querySelectorAll("button") ?? [])].map((b) => b.textContent)).toEqual([
      t.remindVendor,
      t.markContacted,
    ]);
    await click([...(bar?.querySelectorAll("button") ?? [])][1]);
    expect(dialog()?.querySelector("textarea")).not.toBeNull();
  });
});

describe("телефон: читаемость списков", () => {
  it("клиенты — карточками: имя ссылкой, код мелко, вход и последняя заявка словами", async () => {
    const list: ClientList = {
      total: 1,
      items: [
        {
          id: "dddddddd-0000-0000-0000-000000000001",
          ref: "C-1a2b3c4d",
          displayName: "Азиза К.",
          signIn: ["telegram", "phone"],
          lastRequest: { publicNo: 1001, listingName: "Oqsaroy Hall", status: "contacted" },
          createdAt: "2026-09-01T06:00:00.000Z",
          lastSeenAt: "2026-09-28T06:00:00.000Z",
          locale: "ru",
          blocked: false,
          deleted: false,
          requests: 2,
          lastRequestAt: "2026-09-28T18:00:00.000Z",
        },
      ],
    };
    mockApi(ADMIN, { "GET /api/staff/clients": json(list) });
    await mount("/clients");
    const card = container.querySelector(".rcard");
    expect(card?.querySelector("a.rcard-link")?.textContent).toBe("Азиза К.");
    expect(card?.querySelector(".rcard-meta")?.textContent).toBe("C-1a2b3c4d");
    const facts = card?.querySelector(".rcard-facts")?.textContent ?? "";
    expect(facts).toContain("Telegram, телефон");
    expect(facts).toContain(t.locales.ru);
    expect(facts).toContain(`${t.requestNo(1001)} · Oqsaroy Hall`);
    expect(facts).toContain(t.requestStatus.contacted);
  });

  it("фильтры заявок: у каждой группы переключателей — видимый заголовок", async () => {
    mockApi(ADMIN);
    await mount("/requests");
    await click([...container.querySelectorAll("button")].find((b) => b.textContent === t.filters));
    const titles = [...(dialog()?.querySelectorAll(".sheet-group") ?? [])];
    expect(titles.map((el) => el.textContent)).toEqual([t.colDue, t.colCategory]);
    for (const title of titles)
      expect(dialog()?.querySelector(`[role=radiogroup][aria-labelledby="${title.id}"]`)).not.toBeNull();
  });

  it("команда: на телефоне сначала сотрудники, приглашение — ниже; на компьютере — наоборот", async () => {
    const team: TeamList = {
      items: [
        {
          id: "00000000-0000-0000-0000-00000000a001",
          displayName: "Test Admin",
          username: "test_admin",
          invitedBy: "telegram",
          role: "admin",
          active: true,
          accepted: true,
          linked: true,
          linkedAt: "2026-09-01T06:00:00.000Z",
          createdAt: "2026-09-01T06:00:00.000Z",
          self: true,
        },
      ],
    };
    mockApi(ADMIN, { "GET /api/staff/team": json(team) });
    await mount("/team");
    const order = () =>
      [...container.querySelectorAll(".stack > *")].map((el) =>
        el.matches("form.fs") ? "invite" : el.matches(".rcards") ? "list" : null,
      );
    expect(order().filter(Boolean)).toEqual(["list", "invite"]);
    act(() => root.unmount());
    container.remove();
    screenWidth(1280);
    await mount("/team");
    expect(order().filter(Boolean)).toEqual(["invite"]);
  });

  it("вендор: «Удалить вендора» — в «Ещё» шапки, подтверждение — шторкой с кодом вендора", async () => {
    const mark = { done: false, at: null, by: null };
    const vendor: VendorDetail = {
      id: VENDOR_ID,
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
      checklist: { contract: mark, stir: mark, contacts: mark, pdConsent: mark },
      users: [],
      listings: [],
      deleteBlocker: null,
    };
    mockApi(ADMIN, {
      [`GET /api/staff/vendors/${VENDOR_ID}`]: json(vendor),
      [`GET /api/staff/metrics/vendors/${VENDOR_ID}`]: json({ error: { code: "not_found" } }, 404),
    });
    await mount(`/vendors/${VENDOR_ID}`);
    const more = container.querySelector<HTMLButtonElement>(".vendor-head .btn-more");
    expect(more?.textContent).toContain(t.more);
    // На телефоне отдельной красной кнопки в шапке нет — только «Ещё»
    expect(
      [...container.querySelectorAll(".vendor-head button")].some((b) => b.textContent === t.vendorDelete),
    ).toBe(false);
    await click(more);
    const item = [...(dialog()?.querySelectorAll<HTMLButtonElement>(".menu-item") ?? [])].find(
      (b) => b.textContent === t.vendorDelete,
    );
    expect(item?.className).toContain("menu-danger");
    await click(item);
    const sheet = document.querySelector<HTMLElement>("[role=alertdialog]");
    expect(sheet?.textContent).toContain(t.vendorDeleteCode("V101"));
    expect(sheet?.querySelector("input")?.className).toBe("input");
  });

  it("заявка: источник — словами; клиент и телефоны вендора выше истории везде, где нет двух колонок", async () => {
    const order = () =>
      [...container.querySelectorAll("section.panel")].map((el) => el.getAttribute("aria-labelledby"));
    mockApi(ADMIN);
    for (const width of [390, 800]) {
      screenWidth(width);
      await mount(`/requests/${REQUEST_ID}`);
      expect(container.querySelector(".columns")).toBeNull();
      const ids = order();
      expect(ids.indexOf("client-title"), `${width}px`).toBeGreaterThan(-1);
      expect(ids.indexOf("client-title")).toBeLessThan(ids.indexOf("history-title"));
      expect(ids.indexOf("vendor-phones-title")).toBeLessThan(ids.indexOf("timeline-title"));
      expect(container.textContent).toContain(`${t.source}${t.sources.tma}`);
      expect(container.textContent).not.toContain(`${t.source}tma`);
      act(() => root.unmount());
      container.remove();
    }
    screenWidth(1280);
    await mount(`/requests/${REQUEST_ID}`);
    expect(container.querySelector(".columns")).not.toBeNull();
  });
});

describe("счётчики и инициалы", () => {
  it("модерация — карточки на проверке, правки и фото вместе; заявки — просроченные", () => {
    expect(badgesOf(QUEUES)).toEqual({ requests: 2, moderation: 3, notifications: 1 });
  });

  it("инициалы — две первые буквы; пустое имя — точка", () => {
    expect(initialsOf("Дильноза Операторова")).toBe("ДО");
    expect(initialsOf("madina")).toBe("M");
    expect(initialsOf("  ")).toBe("•");
  });
});
