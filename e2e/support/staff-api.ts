import type {
  ListingDetail,
  ListingInput,
  ListingList,
  PublishBlocker,
  StaffDictionaries,
  StaffMe,
  StaffRequestDetail,
  StaffRequestList,
  VendorDetail,
  VendorList,
} from "@bayramm/shared/api/staff";
import type { Page, Route } from "@playwright/test";
import { isApi } from "./vendor-api";

/* API панели оператора в памяти теста: page.route перехватывает /api/* до сети.
   Контракт — @bayramm/shared/api/staff. Сессия сотрудника — токен в sessionStorage
   (как после входа виджетом) либо вход через /login/telegram. Всё незнакомое — 404 и
   запись в unexpected. */

export const NOW = new Date("2026-10-01T07:00:00Z");
export const TOKEN = "e2e-staff-token";
const TOKEN_KEY = "bayramm.admin.session";

export const VENDOR_ID = "00000000-0000-4000-8400-000000000001";
export const LISTING_ID = "00000000-0000-4000-8100-000000000009";
export const REQUEST_ID = "00000000-0000-4000-8300-000000000001";
const iso = NOW.toISOString();

export const STAFF: StaffMe = {
  id: "00000000-0000-4000-8600-000000000001",
  role: "admin",
  displayName: "Дильноза Операторова",
  username: "dilnoza_ops",
  permissions: [
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
  ],
};

const DICTIONARIES: StaffDictionaries = {
  categories: [{ code: "hall", nameRu: "Площадка / Тойхона", nameUz: "Maydon / Toʻyxona", enabled: true }],
  districts: [
    { code: "yunusobod", nameRu: "Юнусабад", nameUz: "Yunusobod" },
    { code: "chilonzor", nameRu: "Чиланзар", nameUz: "Chilonzor" },
  ],
  occasions: [{ code: "toy", nameRu: "Свадьба", nameUz: "Toʻy" }],
  staff: [{ id: STAFF.id, displayName: STAFF.displayName, role: "admin" }],
  settings: { minPhotos: 3, maxPhotos: 10, slaHours: 12 },
};

const CHECKLIST_OPEN = { done: false, at: null, by: null } as const;

function vendorDetail(listings: readonly ListingDetail[]): VendorDetail {
  return {
    id: VENDOR_ID,
    code: "V101",
    name: "Lola",
    legalForm: "ooo",
    contractNo: null,
    manager: null,
    createdAt: iso,
    updatedAt: iso,
    contacts: {
      legalName: "ООО «Лола Холл»",
      stir: null,
      legalAddress: null,
      contactPerson: "Шахло Каримова",
      contactRole: "Директор",
      telegramUsername: null,
    },
    checklist: {
      contract: CHECKLIST_OPEN,
      stir: CHECKLIST_OPEN,
      contacts: CHECKLIST_OPEN,
      pdConsent: CHECKLIST_OPEN,
    },
    users: [],
    listings: listings.map((l) => ({
      id: l.id,
      name: l.name,
      status: l.status,
      slug: l.slug,
      districtCode: l.districtCode,
      priceFromUzs: l.priceFromUzs,
      priceUnit: l.priceUnit,
      capMax: l.capMax,
      updatedAt: l.updatedAt,
      blockers: l.blockers.active,
    })),
  };
}

// Пустая карточка: не хватает всего — и вендорских отметок проверки тоже
const REVIEW_BLOCKERS: readonly PublishBlocker[] = [
  "price",
  "capacity",
  "district",
  "descriptions",
  "phone",
  "packages",
  "photos",
];
const ACTIVE_BLOCKERS: readonly PublishBlocker[] = [
  ...REVIEW_BLOCKERS,
  "contract",
  "stir",
  "contacts",
  "pd_consent",
];

function newListing(input: ListingInput): ListingDetail {
  return {
    id: LISTING_ID,
    slug: input.slug || "navruz-zali",
    categoryCode: input.categoryCode ?? "hall",
    status: input.status ?? "draft",
    statusReason: null,
    statusChangedAt: iso,
    name: input.name ?? "",
    districtCode: input.districtCode ?? null,
    addressRu: null,
    addressUz: null,
    descriptionRu: null,
    descriptionUz: null,
    priceFromUzs: null,
    priceUnit: input.priceUnit ?? "per_guest",
    capMin: null,
    capMax: null,
    submittedAt: null,
    publishedAt: null,
    version: 1,
    createdAt: iso,
    updatedAt: iso,
    hasPhone: false,
    packages: [],
    photos: [],
    blockers: { review: REVIEW_BLOCKERS, active: ACTIVE_BLOCKERS },
    vendor: { id: VENDOR_ID, code: "V101", name: "Lola" },
    history: [
      { from: null, to: "draft", reason: null, actorKind: "staff", actorName: STAFF.displayName, at: iso },
    ],
  };
}

const REQUEST: StaffRequestDetail = {
  id: REQUEST_ID,
  publicNo: 1051,
  status: "viewed",
  sla: "overdue",
  slaDueAt: new Date(NOW.getTime() - 3 * 3_600_000).toISOString(),
  firstResponseAt: null,
  firstResponseBy: null,
  occasionCode: "toy",
  eventDate: "2026-10-24",
  guests: 180,
  createdAt: new Date(NOW.getTime() - 15 * 3_600_000).toISOString(),
  listing: { id: LISTING_ID, name: "Lola zali" },
  vendor: { id: VENDOR_ID, code: "V101", name: "Lola" },
  budgetMinUzs: 30_000_000,
  budgetMaxUzs: 50_000_000,
  declineReason: null,
  declineNote: null,
  firstViewedAt: new Date(NOW.getTime() - 14 * 3_600_000).toISOString(),
  slaBreachedAt: null,
  source: "tma",
  contactName: "Азиза",
  comment: "Нужен детский стол",
  contactPurged: false,
  history: [
    {
      from: null,
      to: "new",
      actorKind: "client",
      source: "tma",
      reason: null,
      at: new Date(NOW.getTime() - 15 * 3_600_000).toISOString(),
    },
    {
      from: "new",
      to: "viewed",
      actorKind: "vendor_user",
      source: "vendor",
      reason: null,
      at: new Date(NOW.getTime() - 14 * 3_600_000).toISOString(),
    },
  ],
};

export interface StaffApi {
  readonly unexpected: string[];
  readonly created: ListingInput[];
  readonly actions: string[];
}

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const fail = (route: Route, status: number, code: string, details: readonly string[] = []) =>
  json(route, status, { error: { code, message: code, ...(details.length ? { details } : {}) } });

export interface StaffApiOptions {
  /** Сразу вошедший сотрудник: токен в sessionStorage до загрузки */
  readonly signedIn?: boolean;
  /** GET /telegram/bot не отвечает */
  readonly botDown?: boolean;
}

export async function mockStaffApi(page: Page, { signedIn = true, botDown = false }: StaffApiOptions = {}) {
  const state: StaffApi = { unexpected: [], created: [], actions: [] };
  const listings: ListingDetail[] = [];
  if (signedIn)
    await page.addInitScript(
      ({ key, token }) => {
        if (window.sessionStorage.getItem(key) === null) window.sessionStorage.setItem(key, token);
      },
      { key: TOKEN_KEY, token: TOKEN },
    );

  await page.route(isApi, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, "");
    const method = request.method();
    const key = `${method} ${path}`;

    if (key === "GET /telegram/bot")
      return botDown
        ? fail(route, 503, "service_unavailable")
        : json(route, 200, { username: "bayramm_demo_bot", miniAppUrl: "http://localhost:4310" });
    if (key === "POST /auth/staff/telegram") {
      const fields = request.postDataJSON() as Record<string, string>;
      return fields.hash === "e2e-good"
        ? json(route, 200, { token: TOKEN, expiresAt: new Date(NOW.getTime() + 8 * 3_600_000).toISOString() })
        : fail(route, 401, "invalid_login");
    }
    if (request.headers().authorization !== `Bearer ${TOKEN}`) return fail(route, 401, "unauthorized");
    if (key === "POST /auth/staff/logout" || key === "POST /auth/logout")
      return route.fulfill({ status: 204 });

    if (key === "GET /staff/me") return json(route, 200, STAFF);
    if (key === "GET /staff/dictionaries") return json(route, 200, DICTIONARIES);
    if (key === "GET /staff/vendors") {
      const detail = vendorDetail(listings);
      const list: VendorList = {
        total: 1,
        items: [
          {
            id: VENDOR_ID,
            code: detail.code,
            name: detail.name,
            legalForm: detail.legalForm,
            legalName: detail.contacts.legalName,
            contactPerson: detail.contacts.contactPerson,
            managerName: null,
            createdAt: iso,
            checklist: { contract: false, stir: false, contacts: false, pdConsent: false },
            listings: listings.map((l) => ({ id: l.id, name: l.name, status: l.status })),
            users: 0,
            linkedUsers: 0,
          },
        ],
      };
      return json(route, 200, list);
    }
    if (key === `GET /staff/vendors/${VENDOR_ID}`) return json(route, 200, vendorDetail(listings));
    if (key === "GET /staff/listings") {
      const list: ListingList = {
        total: 0,
        items: [],
        counts: { lead: 0, draft: listings.length, review: 0, active: 0, suspended: 0, rejected: 0 },
      };
      return json(route, 200, list);
    }
    if (key === "POST /staff/listings") {
      const input = request.postDataJSON() as ListingInput;
      state.created.push(input);
      if (!input.name || input.name.trim().length < 2) return fail(route, 422, "invalid_input", ["name"]);
      const listing = newListing(input);
      listings.splice(0, listings.length, listing);
      return json(route, 201, listing);
    }
    const listingMatch = /^\/staff\/listings\/([0-9a-f-]{36})(?:\/(\w+))?$/.exec(path);
    if (listingMatch?.[1]) {
      const listing = listings.find((l) => l.id === listingMatch[1]);
      if (!listing) return fail(route, 404, "not_found");
      const action = listingMatch[2];
      if (!action && method === "GET") return json(route, 200, listing);
      if (action === "availability" && method === "GET") {
        return json(route, 200, {
          from: url.searchParams.get("from"),
          to: url.searchParams.get("to"),
          busy: [],
        });
      }
      if (action && method === "POST" && ["submit", "publish"].includes(action)) {
        state.actions.push(action);
        const blockers = action === "submit" ? listing.blockers.review : listing.blockers.active;
        return fail(route, 422, "publish_blocked", blockers);
      }
    }
    if (key === "GET /staff/requests") {
      const list: StaffRequestList = {
        total: 1,
        items: [REQUEST],
        counts: { waiting: 0, overdue: 1, breached: 0, answered: 0, answered_late: 0, closed: 0 },
      };
      return json(route, 200, list);
    }
    if (key === `GET /staff/requests/${REQUEST_ID}`) return json(route, 200, REQUEST);

    state.unexpected.push(key);
    return fail(route, 404, "not_found");
  });
  return state;
}
