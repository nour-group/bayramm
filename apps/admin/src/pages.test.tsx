// @vitest-environment jsdom
// Экраны панели: вендоры, карточка, заявки. API — подменённый fetch; проверяем, что
// уходит на сервер и что видит сотрудник его роли.
import type {
  ListingDetail,
  StaffDictionaries,
  StaffMe,
  StaffRequestDetail,
  VendorDetail,
  VendorList,
} from "@bayramm/shared/api/staff";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { tokenStore } from "./session";
import { t } from "./texts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const TOKEN = "T".repeat(43);
const VENDOR_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const LISTING_ID = "bbbbbbbb-0000-0000-0000-000000000001";
const REQUEST_ID = "cccccccc-0000-0000-0000-000000000001";

const ALL_PERMISSIONS: StaffMe["permissions"] = [
  "catalog.read",
  "vendors.write",
  "vendor_users.write",
  "listings.write",
  "listings.submit",
  "listings.publish",
  "listings.moderate",
  "listings.draft",
  "photos.moderate",
  "vendor_phones.read",
  "requests.read",
  "client_phones.read",
];

const staff = (role: StaffMe["role"], permissions: StaffMe["permissions"]): StaffMe => ({
  id: "00000000-0000-0000-0000-00000000a001",
  role,
  displayName: `Test ${role}`,
  username: null,
  permissions,
});

const DICT: StaffDictionaries = {
  categories: [{ code: "hall", nameRu: "Площадка / Тойхона", nameUz: "Maydon / Toʻyxona", enabled: true }],
  districts: [{ code: "chilonzor", nameRu: "Чиланзар", nameUz: "Chilonzor" }],
  occasions: [{ code: "toy", nameRu: "Свадьба", nameUz: "Toʻy" }],
  staff: [],
  settings: { minPhotos: 3, maxPhotos: 10, slaHours: 12 },
};

const mark = (done: boolean) => ({
  done,
  at: done ? "2026-09-29T06:00:00.000Z" : null,
  by: done ? "Test" : null,
});

const VENDOR: VendorDetail = {
  id: VENDOR_ID,
  code: "V101",
  name: "Oqsaroy",
  legalForm: "ooo",
  contractNo: null,
  manager: null,
  createdAt: "2026-09-29T06:00:00.000Z",
  updatedAt: "2026-09-29T06:00:00.000Z",
  contacts: {
    legalName: "OOO Oqsaroy",
    stir: "301234567",
    legalAddress: null,
    contactPerson: "Test Person",
    contactRole: null,
    telegramUsername: null,
  },
  checklist: { contract: mark(true), stir: mark(false), contacts: mark(false), pdConsent: mark(false) },
  users: [],
  listings: [],
};

const LISTING: ListingDetail = {
  id: LISTING_ID,
  slug: "oqsaroy",
  categoryCode: "hall",
  status: "active",
  statusReason: null,
  statusChangedAt: null,
  name: "Oqsaroy Hall",
  districtCode: "chilonzor",
  addressRu: null,
  addressUz: null,
  descriptionRu: "Описание",
  descriptionUz: "Tavsif",
  priceFromUzs: 150000,
  priceUnit: "per_guest",
  capMin: 50,
  capMax: 300,
  submittedAt: null,
  publishedAt: "2026-09-29T06:00:00.000Z",
  version: 7,
  createdAt: "2026-09-29T06:00:00.000Z",
  updatedAt: "2026-09-29T06:00:00.000Z",
  hasPhone: true,
  packages: [
    { kind: "weekday", nameRu: "Будни", nameUz: "Ish kunlari", priceUzs: 150000, priceUnit: "per_guest" },
    {
      kind: "weekend",
      nameRu: "Выходные",
      nameUz: "Dam olish kunlari",
      priceUzs: 180000,
      priceUnit: "per_guest",
    },
  ],
  photos: [],
  blockers: { review: [], active: [] },
  vendor: { id: VENDOR_ID, code: "V101", name: "Oqsaroy" },
  history: [],
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

const text = () => container.textContent ?? "";
const button = (name: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === name) as
    | HTMLButtonElement
    | undefined;

async function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

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

describe("вендоры", () => {
  const LIST: VendorList = {
    total: 1,
    items: [
      {
        id: VENDOR_ID,
        code: "V101",
        name: "Oqsaroy",
        legalForm: "ooo",
        legalName: "OOO Oqsaroy",
        contactPerson: "Test Person",
        managerName: null,
        createdAt: "2026-09-29T06:00:00.000Z",
        checklist: { contract: true, stir: true, contacts: false, pdConsent: false },
        listings: [{ id: LISTING_ID, name: "Oqsaroy Hall", status: "review" }],
        users: 1,
        linkedUsers: 0,
      },
    ],
  };

  it("список: вендор, его карточки со статусом, готовность 2/4; менеджер видит «Новый вендор»", async () => {
    mockApi(staff("manager", ["catalog.read", "vendors.write"]), { "GET /api/staff/vendors": json(LIST) });
    await mount("/vendors");
    expect(text()).toContain("Oqsaroy");
    expect(text()).toContain("Oqsaroy Hall");
    expect(text()).toContain(t.status.review);
    expect(container.querySelector(".ring")?.textContent).toBe("2/4");
    expect(text()).toContain(t.newVendor);
  });

  it("модератор вендоров не заводит — кнопки нет", async () => {
    mockApi(staff("moderator", ["catalog.read"]), { "GET /api/staff/vendors": json(LIST) });
    await mount("/vendors");
    expect(text()).not.toContain(t.newVendor);
  });

  it("чек-лист: отметка уходит на сервер, заголовок — название вендора", async () => {
    mockApi(staff("admin", ALL_PERMISSIONS), {
      [`GET /api/staff/vendors/${VENDOR_ID}`]: json(VENDOR),
      [`POST /api/staff/vendors/${VENDOR_ID}/checklist`]: json({
        ...VENDOR,
        checklist: { ...VENDOR.checklist, stir: mark(true) },
      }),
    });
    await mount(`/vendors/${VENDOR_ID}`);
    expect(container.querySelector("h1")?.textContent).toBe("Oqsaroy");
    const boxes = [...container.querySelectorAll<HTMLInputElement>(".check input")];
    expect(boxes.map((b) => b.checked)).toEqual([true, false, false, false]);
    await act(async () => boxes[1]?.click());
    await settle();
    expect(calls.find((c) => c.url.endsWith("/checklist"))?.body).toEqual({ item: "stir", done: true });
    expect([...container.querySelectorAll<HTMLInputElement>(".check input")].map((b) => b.checked)).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  it("телефон контакта скрыт, пока не нажали «Показать»", async () => {
    mockApi(staff("moderator", ["catalog.read", "vendor_phones.read"]), {
      [`GET /api/staff/vendors/${VENDOR_ID}`]: json(VENDOR),
      [`POST /api/staff/vendors/${VENDOR_ID}/phones`]: json({ phone: "+998901234567", phoneAlt: null }),
    });
    await mount(`/vendors/${VENDOR_ID}`);
    expect(text()).not.toContain("123 45 67");
    expect(calls.some((c) => c.url.endsWith("/phones"))).toBe(false);
    await act(async () => button(t.show)?.click());
    await settle();
    expect(text()).toContain("+998 90 123 45 67");
  });
});

describe("карточка", () => {
  it("приостановка — только с причиной; уходит версия карточки", async () => {
    mockApi(staff("moderator", ["catalog.read", "listings.moderate", "listings.publish", "listings.draft"]), {
      [`GET /api/staff/listings/${LISTING_ID}`]: json(LISTING),
      [`GET /api/staff/listings/${LISTING_ID}/availability`]: json({
        from: "2026-09-01",
        to: "2026-09-30",
        busy: [],
      }),
      [`POST /api/staff/listings/${LISTING_ID}/suspend`]: json({
        ...LISTING,
        status: "suspended",
        statusReason: "Ремонт",
        version: 8,
      }),
    });
    await mount(`/listings/${LISTING_ID}`);
    expect(container.querySelector("h1")?.textContent).toBe("Oqsaroy Hall");
    // Модератор не правит поля карточки
    expect(button(t.save)).toBeUndefined();

    await act(async () => button(t.actions.suspend)?.click());
    const confirm = [...container.querySelectorAll<HTMLButtonElement>(".confirm button")].find(
      (b) => b.textContent === t.actions.suspend,
    );
    expect(confirm?.disabled).toBe(true);
    await type(
      container.querySelector<HTMLTextAreaElement>(".confirm textarea") as HTMLTextAreaElement,
      "Ремонт",
    );
    expect(confirm?.disabled).toBe(false);
    await act(async () => confirm?.click());
    await settle();
    expect(calls.find((c) => c.url.endsWith("/suspend"))?.body).toEqual({ version: 7, reason: "Ремонт" });
    expect(text()).toContain(t.status.suspended);
    expect(text()).toContain("Ремонт");
  });

  it("чего не хватает — человеческими словами; фото, ждущие решения, публикации не мешают", async () => {
    const photo = (n: number) => ({
      id: `dddddddd-0000-0000-0000-00000000000${n}`,
      key: `listings/${LISTING_ID}/dddddddd-0000-0000-0000-00000000000${n}.webp`,
      width: 1600,
      height: 1200,
      bytes: 1000,
      sort: n,
      isCover: false,
      moderation: "pending" as const,
      createdAt: "2026-09-29T06:00:00.000Z",
    });
    mockApi(staff("moderator", ["catalog.read", "listings.publish", "photos.moderate"]), {
      [`GET /api/staff/listings/${LISTING_ID}`]: json({
        ...LISTING,
        status: "review",
        photos: [photo(1), photo(2), photo(3)],
        blockers: { review: [], active: ["photos", "stir"] },
      }),
      [`GET /api/staff/listings/${LISTING_ID}/availability`]: json({
        from: "2026-09-01",
        to: "2026-09-30",
        busy: [],
      }),
    });
    await mount(`/listings/${LISTING_ID}`);
    const blockers = [...container.querySelectorAll(".blockers li")].map((li) => li.textContent);
    expect(blockers).toEqual([t.blockers.stir]);
    // Предупреждение о лицах — всегда на виду
    expect(text()).toContain(t.noFacesWarning);
    // Модератор решает по фото, но не загружает их
    expect(text()).toContain(t.approve);
    expect(text()).not.toContain(t.addPhotos);
  });
});

describe("заявки", () => {
  const DETAIL: StaffRequestDetail = {
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
    createdAt: "2026-09-28T18:00:00.000Z",
    listing: { id: LISTING_ID, name: "Oqsaroy Hall" },
    vendor: { id: VENDOR_ID, code: "V101", name: "Oqsaroy" },
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
  };

  it("телефон клиента: администратор — только с причиной", async () => {
    mockApi(staff("admin", ALL_PERMISSIONS), {
      [`GET /api/staff/requests/${REQUEST_ID}`]: json(DETAIL),
      [`POST /api/staff/requests/${REQUEST_ID}/client-phone`]: json({ phone: "+998901112233" }),
    });
    await mount(`/requests/${REQUEST_ID}`);
    expect(container.querySelector("h1")?.textContent).toContain("1001");
    expect(text()).toContain(t.sla.overdue);
    const form = container.querySelector(".confirm") as HTMLFormElement;
    const show = form.querySelector("button") as HTMLButtonElement;
    expect(show.disabled).toBe(true);
    await type(form.querySelector("input") as HTMLInputElement, "Клиент просит перезвонить");
    await act(async () => show.click());
    await settle();
    expect(calls.find((c) => c.url.endsWith("/client-phone"))?.body).toEqual({
      reason: "Клиент просит перезвонить",
    });
    expect(text()).toContain("+998 90 111 22 33");
  });

  it("менеджер телефона клиента не видит — формы нет", async () => {
    mockApi(staff("manager", ["catalog.read", "requests.read", "vendor_phones.read"]), {
      [`GET /api/staff/requests/${REQUEST_ID}`]: json(DETAIL),
    });
    await mount(`/requests/${REQUEST_ID}`);
    expect(text()).toContain("Client");
    expect(text()).not.toContain(t.clientPhoneReason);
  });
});
