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
import { categoryName } from "./categories";
import { tashkentToday } from "./pages/Calendar";
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
  "requests.write",
  "client_phones.read",
  "clients.read",
  "clients.block",
  "outbox.read",
  "outbox.retry",
  "audit.read",
  "settings.write",
  "team.manage",
  "revisions.moderate",
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
  hasTelegram: false,
  attributes: {},
  missingAttributes: [],
  videoLinks: [],
  parallelCapacity: 1,
  services: [],
  photos: [],
  blockers: { review: [], active: [] },
  vendor: { id: VENDOR_ID, code: "V101", name: "Oqsaroy" },
  history: [],
  pendingRevision: null,
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
        listings: [{ id: LISTING_ID, name: "Oqsaroy Hall", status: "review", categoryCode: "hall" }],
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

  it("новый вендор: без категории запроса нет; с ней — категория первой витрины в теле", async () => {
    mockApi(staff("manager", ["catalog.read", "vendors.write", "listings.write"]), {
      "POST /api/staff/vendors": json({ ...VENDOR, listings: [] }, 201),
      [`GET /api/staff/vendors/${VENDOR_ID}`]: json(VENDOR),
    });
    await mount("/vendors/new");
    const name = [...container.querySelectorAll<HTMLInputElement>("input")].find(
      (input) => input.labels?.[0]?.textContent === t.fields.name,
    );
    if (!name) throw new Error("нет поля названия");
    await type(name, "Navruz");
    await act(async () => button(t.createVendor)?.click());
    await settle();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(text()).toContain(t.categoryRequired);

    await act(async () => container.querySelector<HTMLElement>("button[aria-haspopup=listbox]")?.click());
    await settle();
    const torts = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (o) => o.textContent === "Торты и сладости",
    );
    await act(async () => torts?.click());
    await settle();
    await act(async () => button(t.createVendor)?.click());
    await settle();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ name: "Navruz", categoryCode: "cake" });
    expect(window.location.pathname).toBe(`/vendors/${VENDOR_ID}`);
  });

  it("витрины вендора — с категорией; новую добавляет тот, кто ведёт карточки", async () => {
    mockApi(staff("manager", ["catalog.read", "vendors.write", "listings.write"]), {
      [`GET /api/staff/vendors/${VENDOR_ID}`]: json({
        ...VENDOR,
        listings: [
          {
            id: LISTING_ID,
            name: "Oqsaroy Hall",
            status: "draft",
            categoryCode: "hall",
            slug: "oqsaroy",
            districtCode: null,
            priceFromUzs: null,
            priceUnit: "per_guest",
            capMax: null,
            updatedAt: "2026-09-29T06:00:00.000Z",
            blockers: [],
          },
          {
            id: "bbbbbbbb-0000-0000-0000-000000000002",
            name: "Oqsaroy Kortej",
            status: "draft",
            categoryCode: "car",
            slug: "oqsaroy-kortej",
            districtCode: null,
            priceFromUzs: 300000,
            priceUnit: "per_hour",
            capMax: null,
            updatedAt: "2026-09-29T06:00:00.000Z",
            blockers: [],
          },
        ],
      }),
    });
    await mount(`/vendors/${VENDOR_ID}`);
    expect([...container.querySelectorAll(".cat-chip")].map((chip) => chip.textContent)).toEqual([
      "Площадка / Тойхона",
      "Кортеж",
    ]);
    expect(text()).toMatch(/300\s000\sсум за час/);
    expect([...container.querySelectorAll("a")].some((a) => a.textContent === t.addVitrina)).toBe(true);
  });

  it("телефон контакта скрыт, пока не нажали «Показать»", async () => {
    mockApi(staff("moderator", ["catalog.read", "vendor_phones.read"]), {
      [`GET /api/staff/vendors/${VENDOR_ID}`]: json(VENDOR),
      [`POST /api/staff/vendors/${VENDOR_ID}/phones`]: json({ phone: "+998001234567", phoneAlt: null }),
    });
    await mount(`/vendors/${VENDOR_ID}`);
    expect(text()).not.toContain("123 45 67");
    expect(calls.some((c) => c.url.endsWith("/phones"))).toBe(false);
    await act(async () => button(t.show)?.click());
    await settle();
    expect(text()).toContain("+998 00 123 45 67");
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
        version: 1,
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
        version: 1,
      }),
    });
    await mount(`/listings/${LISTING_ID}`);
    const blockers = [...container.querySelectorAll(".blockers li")].map(
      (li) => li.querySelector(".blocker-text")?.textContent,
    );
    // Проверка вендора — одной строкой со ссылкой на страницу вендора, где её отмечают
    expect(blockers).toEqual([`${t.checklist}${t.blockers.stir}`]);
    const toVendor = container.querySelector<HTMLAnchorElement>(".blockers li a");
    expect(toVendor?.textContent).toBe(t.toChecklist);
    expect(toVendor?.getAttribute("href")).toBe(`/vendors/${LISTING.vendor.id}`);
    // Предупреждение о лицах — всегда на виду
    expect(text()).toContain(t.noFacesWarning);
    // Модератор решает по фото, но не загружает их
    expect(text()).toContain(t.approve);
    expect(text()).not.toContain(t.addPhotos);
  });

  it("пункт «чего не хватает» ведёт к блоку, где он заполняется; телефон и категория — по одному разу", async () => {
    mockApi(staff("admin", ALL_PERMISSIONS), {
      [`GET /api/staff/listings/${LISTING_ID}`]: json({
        ...LISTING,
        status: "draft",
        blockers: { review: ["price", "descriptions"], active: ["price", "descriptions"] },
      }),
      [`GET /api/staff/listings/${LISTING_ID}/availability`]: json({
        from: "2026-09-01",
        to: "2026-09-30",
        busy: [],
        version: 1,
      }),
    });
    await mount(`/listings/${LISTING_ID}`);
    const go = (label: string) =>
      [...container.querySelectorAll<HTMLButtonElement>(".blockers li button")].find((b) =>
        b.textContent?.includes(label),
      );
    await act(async () => go(t.blockers.price ?? "")?.click());
    expect(document.activeElement?.id).toBe("services-title");
    await act(async () => go(t.blockers.descriptions ?? "")?.click());
    expect(document.activeElement?.id).toBe("form-texts-title");
    // Телефон — один блок формы (показать и сменить), а не два; категория — не полем формы
    const headings = [...container.querySelectorAll("h2")].map((h) => h.textContent);
    expect(headings.filter((h) => h === t.listingSections.phone)).toHaveLength(1);
    expect(container.querySelector(`input[value="${categoryName("hall")}"]`)).toBeNull();
  });
});

describe("карточка: телефон и Telegram для клиентов", () => {
  const AVAILABILITY = `/api/staff/listings/${LISTING_ID}/availability`;
  const day = json({ from: "2026-09-01", to: "2026-09-30", busy: [], version: 1 });
  const field = (label: string) =>
    [...container.querySelectorAll<HTMLInputElement>("input")].find(
      (input) => input.labels?.[0]?.textContent === label,
    );
  const base = (listing = LISTING) => ({
    [`GET /api/staff/listings/${LISTING_ID}`]: json(listing),
    [`GET ${AVAILABILITY}`]: day,
  });

  it("скрыты до «Показать»: одно чтение открывает оба, имя Telegram — ссылкой на t.me", async () => {
    mockApi(staff("admin", ALL_PERMISSIONS), {
      ...base({ ...LISTING, hasTelegram: true }),
      [`POST /api/staff/listings/${LISTING_ID}/phone`]: json({
        phone: "+998901112233",
        telegram: "lola_hall",
      }),
    });
    await mount(`/listings/${LISTING_ID}`);
    const reveal = container.querySelector(".contacts-reveal") as HTMLElement;
    expect(reveal.textContent).not.toContain("lola_hall");
    expect(reveal.textContent).not.toContain("123");
    expect(calls.some((c) => c.url.endsWith("/phone"))).toBe(false);

    await act(async () => button(t.contactsShow)?.click());
    await settle();
    expect(calls.filter((c) => c.url.endsWith("/phone"))).toHaveLength(1);
    expect(reveal.textContent).toContain("+998 90 111 22 33");
    expect(reveal.querySelector<HTMLAnchorElement>("a[href^='https://t.me/']")?.textContent).toBe(
      "@lola_hall",
    );
    // «Показать» после чтения не нужна
    expect(button(t.contactsShow)).toBeUndefined();
  });

  it("Telegram не вписан: так и сказано, кнопки «Убрать» нет; вписанное уходит как есть вместе с версией", async () => {
    mockApi(staff("admin", ALL_PERMISSIONS), {
      ...base(),
      [`PATCH /api/staff/listings/${LISTING_ID}`]: json({
        ...LISTING,
        hasTelegram: true,
        version: 8,
        sentForModeration: [],
      }),
    });
    await mount(`/listings/${LISTING_ID}`);
    expect(container.querySelector(".contacts-reveal")?.textContent).toContain(t.telegramMissing);
    expect([...container.querySelectorAll("label")].some((l) => l.textContent === t.telegramRemove)).toBe(
      false,
    );
    const telegram = field(t.telegramChange);
    if (!telegram) throw new Error("нет поля Telegram");
    expect(telegram.value).toBe("");
    await type(telegram, "t.me/Lola_Hall");
    await act(async () => button(t.save)?.click());
    await settle();
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
      telegram: "t.me/Lola_Hall",
      version: 7,
    });
    // Сохранили — в форме Telegram уже «вписан»: пустое поле его не меняет
    expect(container.querySelector(".contacts-reveal")?.textContent).not.toContain(t.telegramMissing);
    expect(field(t.telegramChange)?.value).toBe("");
  });

  it("после сохранения открытые контакты закрываются: показанное было до правки", async () => {
    mockApi(staff("admin", ALL_PERMISSIONS), {
      ...base({ ...LISTING, hasTelegram: true }),
      [`POST /api/staff/listings/${LISTING_ID}/phone`]: json({
        phone: "+998901112233",
        telegram: "old_name",
      }),
      [`PATCH /api/staff/listings/${LISTING_ID}`]: json({
        ...LISTING,
        hasTelegram: true,
        version: 8,
        sentForModeration: [],
      }),
    });
    await mount(`/listings/${LISTING_ID}`);
    await act(async () => button(t.contactsShow)?.click());
    await settle();
    expect(container.querySelector(".contacts-reveal")?.textContent).toContain("old_name");
    const telegram = field(t.telegramChange);
    if (!telegram) throw new Error("нет поля Telegram");
    await type(telegram, "new_name");
    await act(async () => button(t.save)?.click());
    await settle();
    expect(container.querySelector(".contacts-reveal")?.textContent).not.toContain("old_name");
    expect(button(t.contactsShow)).toBeDefined();
  });

  it("плохое имя: ошибка под полем словами, введённое остаётся", async () => {
    mockApi(staff("admin", ALL_PERMISSIONS), {
      ...base(),
      [`PATCH /api/staff/listings/${LISTING_ID}`]: json(
        { error: { code: "invalid_input", message: "invalid_input", details: ["telegram"] } },
        422,
      ),
    });
    await mount(`/listings/${LISTING_ID}`);
    const telegram = field(t.telegramChange);
    if (!telegram) throw new Error("нет поля Telegram");
    await type(telegram, "ab");
    await act(async () => button(t.save)?.click());
    await settle();
    expect(container.querySelector(".field-error")?.textContent).toBe(t.listingFieldErrors.telegram);
    expect(field(t.telegramChange)?.value).toBe("ab");
  });

  it("«Убрать Telegram» — null в теле; поле на это время закрыто", async () => {
    mockApi(staff("admin", ALL_PERMISSIONS), {
      ...base({ ...LISTING, hasTelegram: true }),
      [`PATCH /api/staff/listings/${LISTING_ID}`]: json({
        ...LISTING,
        hasTelegram: false,
        version: 8,
        sentForModeration: [],
      }),
    });
    await mount(`/listings/${LISTING_ID}`);
    const remove = [...container.querySelectorAll<HTMLInputElement>("input[type=checkbox]")].find(
      (input) => input.labels?.[0]?.textContent === t.telegramRemove,
    );
    if (!remove) throw new Error("нет «Убрать Telegram»");
    await act(async () => remove.click());
    expect(field(t.telegramChange)?.disabled).toBe(true);
    await act(async () => button(t.save)?.click());
    await settle();
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ telegram: null, version: 7 });
    expect(container.querySelector(".contacts-reveal")?.textContent).toContain(t.telegramMissing);
  });

  it("только просмотр: показать можно, полей для новых значений нет", async () => {
    mockApi(staff("moderator", ["catalog.read", "vendor_phones.read"]), {
      ...base({ ...LISTING, hasTelegram: true }),
    });
    await mount(`/listings/${LISTING_ID}`);
    expect(button(t.contactsShow)).toBeDefined();
    expect(field(t.telegramChange)).toBeUndefined();
    expect(field(t.phoneChange)).toBeUndefined();
  });
});

/** Занятость витрины с режимом «день целиком» (зал): частей дня и договорённостей нет */
const DAY_MODE = { mode: "day", parallelCapacity: 1, parts: [], bookings: [] } as const;

describe("карточка: занятые дни", () => {
  const MANAGER: StaffMe["permissions"] = ["catalog.read", "listings.write", "listings.submit"];
  const AVAILABILITY = `/api/staff/listings/${LISTING_ID}/availability`;
  const todayButton = () => container.querySelector<HTMLButtonElement>(".cal-today");
  const puts = () => calls.filter((c) => c.method === "PUT" && c.url === AVAILABILITY);

  it("отметка уходит с версией календаря; следующая — с версией из ответа", async () => {
    mockApi(staff("manager", MANAGER), {
      [`GET /api/staff/listings/${LISTING_ID}`]: json(LISTING),
      [`GET ${AVAILABILITY}`]: json({
        ...DAY_MODE,
        from: "2026-09-01",
        to: "2026-09-30",
        busy: [],
        version: 4,
      }),
      [`PUT ${AVAILABILITY}`]: (body) => {
        const input = body as { busy?: string[]; free?: string[]; version: number };
        const day = input.busy?.[0] ?? input.free?.[0];
        return json({
          ...DAY_MODE,
          from: day,
          to: day,
          busy: input.busy ? [{ day, source: "staff" }] : [],
          version: input.version + 1,
        })(body);
      },
    });
    await mount(`/listings/${LISTING_ID}`);
    expect(todayButton()?.getAttribute("aria-pressed")).toBe("false");

    await act(async () => todayButton()?.click());
    await settle();
    expect(puts()[0]?.body).toEqual({ version: 4, busy: [tashkentToday()] });
    expect(todayButton()?.getAttribute("aria-pressed")).toBe("true");

    // Снять отметку: версия — из ответа на первую правку
    await act(async () => todayButton()?.click());
    await settle();
    expect(puts()[1]?.body).toEqual({ version: 5, free: [tashkentToday()] });
    expect(todayButton()?.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector("[role=alert]")).toBeNull();
  });

  it("несколько дней: начало и конец нажатием, «Занять» — одной правкой с версией", async () => {
    mockApi(staff("manager", MANAGER), {
      [`GET /api/staff/listings/${LISTING_ID}`]: json(LISTING),
      [`GET ${AVAILABILITY}`]: json({
        ...DAY_MODE,
        from: "2026-09-01",
        to: "2026-09-30",
        busy: [],
        version: 4,
      }),
      [`PUT ${AVAILABILITY}`]: (body) => {
        const input = body as { busy: string[]; version: number };
        return json({
          ...DAY_MODE,
          from: input.busy[0],
          to: input.busy.at(-1),
          busy: input.busy.map((day) => ({ day, source: "staff" })),
          version: input.version + 1,
        })(body);
      },
    });
    await mount(`/listings/${LISTING_ID}`);
    await act(async () => button(t.rangeMode)?.click());
    const days = [...container.querySelectorAll<HTMLButtonElement>(".cal-day:not(:disabled)")];
    const [first, , third] = days;
    await act(async () => first?.click());
    expect(text()).toContain(t.rangePickEnd);
    // Отметка дня в этом режиме сразу не уходит
    expect(puts()).toHaveLength(0);
    await act(async () => third?.click());
    expect(container.querySelectorAll(".cal-chosen")).toHaveLength(3);
    await act(async () => button(t.rangeBusy(3))?.click());
    await settle();
    expect(puts()[0]?.body).toMatchObject({ version: 4 });
    expect((puts()[0]?.body as { busy?: string[] } | undefined)?.busy).toHaveLength(3);
    expect(first?.getAttribute("aria-pressed")).toBe("true");
    expect(third?.getAttribute("aria-pressed")).toBe("true");
    // Выбор закончен — снова обычный режим
    expect(container.querySelector(".cal-chosen")).toBeNull();
  });

  it("календарь успели изменить — месяц перечитывается, сотрудник видит почему", async () => {
    let reads = 0;
    mockApi(staff("manager", MANAGER), {
      [`GET /api/staff/listings/${LISTING_ID}`]: json(LISTING),
      // Первое чтение — до правки вендора, второе — после: день занят, версия новая
      [`GET ${AVAILABILITY}`]: () => {
        reads++;
        return json({
          ...DAY_MODE,
          from: "2026-09-01",
          to: "2026-09-30",
          busy: reads > 1 ? [{ day: tashkentToday(), source: "vendor" }] : [],
          version: reads > 1 ? 9 : 4,
        })(null);
      },
      [`PUT ${AVAILABILITY}`]: json(
        { error: { code: "calendar_conflict", message: "Calendar was changed" } },
        409,
      ),
    });
    await mount(`/listings/${LISTING_ID}`);
    await act(async () => todayButton()?.click());
    await settle();
    expect(puts()[0]?.body).toMatchObject({ version: 4 });
    expect(reads).toBe(2);
    expect(container.querySelector("[role=alert]")?.textContent).toBe(t.api.calendar_conflict);
    // Показан актуальный месяц: день занят вендором. Дни снова активны — снять можно
    // заново, уже от новой версии
    expect(todayButton()?.getAttribute("aria-pressed")).toBe("true");
    expect(todayButton()?.disabled).toBe(false);
    await act(async () => todayButton()?.click());
    await settle();
    expect(puts()[1]?.body).toEqual({ version: 9, free: [tashkentToday()] });
  });
});

describe("карточка: правка опубликованной менеджером", () => {
  const MANAGER: StaffMe["permissions"] = ["catalog.read", "listings.write", "listings.submit"];
  const REVISION_ID = "dddddddd-0000-0000-0000-000000000001";
  const AVAILABILITY = json({ from: "2026-09-01", to: "2026-09-30", busy: [], version: 1 });
  const PENDING = {
    id: REVISION_ID,
    fields: ["name"],
    submittedAt: "2026-09-30T06:00:00.000Z",
    proposedBy: { kind: "staff", name: "Test manager" },
  } as const;
  const PARTNER = { kind: "partner", name: null } as const;

  /** Поле формы по подписи */
  const field = (label: string) => {
    const id = [...container.querySelectorAll("label")].find((l) => l.textContent === label)?.htmlFor;
    return (id ? document.getElementById(id) : null) as HTMLInputElement | null;
  };

  it("подсказка заранее; название — на модерацию, вместимость — сразу; форма — как в карточке", async () => {
    mockApi(staff("manager", MANAGER), {
      [`GET /api/staff/listings/${LISTING_ID}`]: json(LISTING),
      [`GET /api/staff/listings/${LISTING_ID}/availability`]: AVAILABILITY,
      [`PATCH /api/staff/listings/${LISTING_ID}`]: json({
        ...LISTING,
        capMax: 400,
        version: 8,
        pendingRevision: PENDING,
        sentForModeration: ["name"],
      }),
    });
    await mount(`/listings/${LISTING_ID}`);
    expect(text()).toContain(t.moderatedNotice);
    expect(field(t.listingFields.name ?? "")?.getAttribute("aria-describedby")).toBeTruthy();
    expect(text()).toContain(t.moderatedHint);

    await type(field(t.listingFields.name ?? "") as HTMLInputElement, "Oqsaroy Grand");
    await type(field(t.listingFields.capMax ?? "") as HTMLInputElement, "400");
    await act(async () => button(t.save)?.click());
    await settle();

    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
      name: "Oqsaroy Grand",
      capMax: 400,
      version: 7,
    });
    expect(container.querySelector(".formbar [role=status]")?.textContent).toBe(
      t.sentForModeration(t.revisionFields.name ?? "", true),
    );
    expect(container.querySelector(".saved")).toBeNull();
    // Карточка не изменилась: в форме — прежнее название, вместимость — новая
    expect(field(t.listingFields.name ?? "")?.value).toBe("Oqsaroy Hall");
    expect(field(t.listingFields.capMax ?? "")?.value).toBe("400");
    // Отметка о правке — со ссылкой на неё
    const notice = container.querySelector(".pending-revision");
    expect(notice?.textContent).toContain(t.pendingRevisionTitle);
    expect(notice?.textContent).toContain(t.proposedBy("staff", "Test manager"));
    expect(notice?.querySelector(`a[href="/revisions/${REVISION_ID}"]`)?.textContent).toBe(
      t.pendingRevisionOpen,
    );
  });

  it("открытая правка уже есть — 409 revision_pending: объяснение, карточка перечитана", async () => {
    // Вендор подал правку, пока менеджер правил: страница о ней ещё не знает
    let reads = 0;
    mockApi(staff("manager", MANAGER), {
      [`GET /api/staff/listings/${LISTING_ID}`]: () =>
        json({ ...LISTING, pendingRevision: reads++ > 0 ? { ...PENDING, proposedBy: PARTNER } : null })(null),
      [`GET /api/staff/listings/${LISTING_ID}/availability`]: AVAILABILITY,
      [`PATCH /api/staff/listings/${LISTING_ID}`]: json(
        { error: { code: "revision_pending", message: "Revision pending" } },
        409,
      ),
    });
    await mount(`/listings/${LISTING_ID}`);
    expect(container.querySelector(".pending-revision")).toBeNull();
    await type(field(t.listingFields.name ?? "") as HTMLInputElement, "Oqsaroy Grand");
    await act(async () => button(t.save)?.click());
    await settle();
    expect(container.querySelector("form [role=alert]")?.textContent).toBe(t.api.revision_pending);
    expect(container.querySelector(".formbar [role=status]")).toBeNull();
    expect(reads).toBe(2);
    expect(container.querySelector(".pending-revision")?.textContent).toContain(
      t.proposedBy("partner", null),
    );
    // Введённое не пропало: можно дождаться решения и сохранить снова
    expect(field(t.listingFields.name ?? "")?.value).toBe("Oqsaroy Grand");
  });

  it("администратор решает по правкам сам: подсказки нет, «Сохранено»", async () => {
    mockApi(staff("admin", ALL_PERMISSIONS), {
      [`GET /api/staff/listings/${LISTING_ID}`]: json(LISTING),
      [`GET /api/staff/listings/${LISTING_ID}/availability`]: AVAILABILITY,
      [`PATCH /api/staff/listings/${LISTING_ID}`]: json({
        ...LISTING,
        name: "Oqsaroy Grand",
        version: 8,
        sentForModeration: [],
      }),
    });
    await mount(`/listings/${LISTING_ID}`);
    expect(text()).not.toContain(t.moderatedNotice);
    expect(text()).not.toContain(t.moderatedHint);
    await type(field(t.listingFields.name ?? "") as HTMLInputElement, "Oqsaroy Grand");
    await act(async () => button(t.save)?.click());
    await settle();
    expect(container.querySelector(".saved")?.textContent).toBe(t.saved);
    expect(container.querySelector(".sent")).toBeNull();
    expect(container.querySelector(".pending-revision")).toBeNull();
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
    dayPart: null,
    details: {},
    createdAt: "2026-09-28T18:00:00.000Z",
    listing: { id: LISTING_ID, name: "Oqsaroy Hall", categoryCode: "hall" },
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
    reminders: 0,
    timeline: [
      { kind: "created", at: "2026-09-28T18:00:00.000Z" },
      { kind: "due", at: "2026-09-29T06:00:00.000Z", passed: true },
    ],
    notes: [],
    awaiting: true,
    vendorReachable: 1,
    nextReminderAt: null,
  };

  it("телефон клиента: администратор — только с причиной", async () => {
    mockApi(staff("admin", ALL_PERMISSIONS), {
      [`GET /api/staff/requests/${REQUEST_ID}`]: json(DETAIL),
      [`POST /api/staff/requests/${REQUEST_ID}/client-phone`]: json({ phone: "+998001112233" }),
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
    expect(text()).toContain("+998 00 111 22 33");
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
