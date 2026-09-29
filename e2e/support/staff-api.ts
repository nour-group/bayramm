import type {
  AuditList,
  ClientDetail,
  ClientList,
  ClientListItem,
  ListingDetail,
  ListingInput,
  ListingList,
  OutboxHealth,
  PublishBlocker,
  RevisionDetail,
  RevisionList,
  StaffDictionaries,
  StaffMe,
  StaffRequestDetail,
  StaffRequestList,
  StaffSettings,
  TeamList,
  VendorDetail,
  VendorList,
} from "@bayramm/shared/api/staff";
import type { Page, Route } from "@playwright/test";
import { accountMe, type HubWatch, METHODS, VENDOR_MEMBERSHIP } from "./account";
import { isApi } from "./vendor-api";

/* API панели оператора в памяти теста: page.route перехватывает /api/* до сети.
   Контракт — @bayramm/shared/api/staff. Сессия сотрудника — токен в sessionStorage
   (как после входа) либо вход: как Mini App (initData → POST /auth/staff/webapp) или через
   хаб входа на сайте (код → сессия аккаунта → POST /auth/staff/elevate). Всё незнакомое —
   404 и запись в unexpected. */

export const NOW = new Date("2026-10-01T07:00:00Z");
export const TOKEN = "e2e-staff-token";
/** Сессия аккаунта из обмена кода хаба: панель меняет её на сессию сотрудника и отзывает */
const ACCOUNT_TOKEN = "e2e-account-token";
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
  reminders: 1,
  timeline: [
    { kind: "created", at: new Date(NOW.getTime() - 15 * 3_600_000).toISOString() },
    { kind: "viewed", at: new Date(NOW.getTime() - 14 * 3_600_000).toISOString() },
    {
      kind: "reminder",
      at: new Date(NOW.getTime() - 11 * 3_600_000).toISOString(),
      source: "auto",
      stage: 1,
      by: null,
      recipients: 1,
      delivered: 1,
      failed: 0,
    },
    { kind: "due", at: new Date(NOW.getTime() - 3 * 3_600_000).toISOString(), passed: true },
  ],
  notes: [
    {
      id: "00000000-0000-4000-8700-000000000001",
      text: "Вендор обещал перезвонить",
      authorName: STAFF.displayName,
      at: new Date(NOW.getTime() - 2 * 3_600_000).toISOString(),
    },
  ],
  awaiting: true,
  vendorReachable: 1,
  nextReminderAt: null,
};

export const CLIENT_ID = "00000000-0000-4000-8800-000000000001";
export const REVISION_ID = "00000000-0000-4000-8900-000000000001";

const CLIENT_ITEM: ClientListItem = {
  id: CLIENT_ID,
  ref: "C-00000000",
  createdAt: iso,
  lastSeenAt: iso,
  locale: "uz",
  blocked: false,
  deleted: false,
  requests: 1,
  lastRequestAt: REQUEST.createdAt,
};

const CLIENT: ClientDetail = {
  ...CLIENT_ITEM,
  canMessage: true,
  deletedAt: null,
  blockedInfo: null,
  profile: { firstName: "Азиза", lastName: null, username: null },
  requestList: [
    {
      id: REQUEST_ID,
      publicNo: REQUEST.publicNo,
      status: REQUEST.status,
      sla: REQUEST.sla,
      eventDate: REQUEST.eventDate,
      createdAt: REQUEST.createdAt,
      listing: REQUEST.listing,
    },
  ],
  consents: [
    {
      purpose: "request_transfer",
      action: "grant",
      textVersion: 1,
      source: "tma",
      at: REQUEST.createdAt,
      listing: REQUEST.listing,
    },
  ],
};

const OUTBOX: OutboxHealth = {
  counts: { pending: 1, sending: 0, sent: 12, failed: 0, dead: 1 },
  oldestPendingAt: iso,
  deadTotal: 1,
  dead: [
    {
      id: "00000000-0000-4000-8a00-000000000001",
      kind: "vendor.request_new",
      recipientKind: "vendor_user",
      recipientRef: "00000000",
      attempts: 8,
      error: "api 403: Forbidden: bot was blocked by the user",
      createdAt: iso,
      lastAttemptAt: iso,
      request: { id: REQUEST_ID, publicNo: REQUEST.publicNo },
    },
  ],
};

const AUDIT: AuditList = {
  total: 1,
  items: [
    {
      id: "1",
      at: iso,
      actorKind: "staff",
      actor: { id: STAFF.id, name: STAFF.displayName },
      action: "request.remind",
      objectType: "request",
      objectId: REQUEST_ID,
      detail: { recipients: 1 },
      source: "admin",
    },
  ],
};

const TEAM: TeamList = {
  items: [
    {
      id: STAFF.id,
      displayName: STAFF.displayName,
      username: STAFF.username,
      role: "admin",
      active: true,
      linked: true,
      linkedAt: iso,
      createdAt: iso,
      self: true,
    },
    {
      id: "00000000-0000-4000-8600-000000000002",
      displayName: "Бахтиёр Менеджеров",
      username: "bakhtiyor_ops",
      role: "manager",
      active: true,
      linked: false,
      linkedAt: null,
      createdAt: iso,
      self: false,
    },
  ],
};

const SETTINGS: StaffSettings = {
  items: [
    { key: "sla_hours", value: 12, updatedAt: iso, updatedBy: null },
    { key: "sla_reminder_hours", value: [4, 8], updatedAt: iso, updatedBy: null },
    { key: "quiet_hours", value: { from: "22:00", to: "08:00" }, updatedAt: iso, updatedBy: null },
    { key: "min_photos", value: 3, updatedAt: iso, updatedBy: STAFF.displayName },
  ],
};

const REVISION: RevisionDetail = {
  id: REVISION_ID,
  status: "pending",
  submittedAt: iso,
  decidedAt: null,
  listing: { id: LISTING_ID, name: "Lola zali", status: "active" },
  vendor: { id: VENDOR_ID, code: "V101", name: "Lola" },
  fields: ["name", "priceFromUzs"],
  stale: false,
  changes: [
    { field: "name", before: "Lola zali", after: "Lola Grand" },
    { field: "priceFromUzs", before: 150_000, after: 180_000 },
  ],
  valid: true,
  decisionReason: null,
  decidedBy: null,
};

export interface StaffApi {
  readonly unexpected: string[];
  readonly created: ListingInput[];
  readonly actions: string[];
  /** Входы: как Mini App (initData) и повышения сессии аккаунта до сотрудника */
  readonly webapp: string[];
  readonly elevated: number;
  /** Отозванные сессии: account — сессия аккаунта после повышения */
  readonly loggedOut: ("account" | "staff")[];
}

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const fail = (route: Route, status: number, code: string, details: readonly string[] = []) =>
  json(route, status, { error: { code, message: code, ...(details.length ? { details } : {}) } });

export interface StaffApiOptions {
  /** Сразу вошедший сотрудник: токен в sessionStorage до загрузки */
  readonly signedIn?: boolean;
  /** GET /auth/methods не отвечает: адреса хаба не узнать */
  readonly methodsDown?: boolean;
  /** Обмен кода хаба сверяется с навигациями страницы */
  readonly hub?: HubWatch;
  /** Какие запросы перехватывать: по умолчанию /api любого localhost */
  readonly match?: (url: URL) => boolean;
}

export async function mockStaffApi(
  page: Page,
  { signedIn = true, methodsDown = false, hub, match = isApi }: StaffApiOptions = {},
) {
  let elevated = 0;
  const state: StaffApi = {
    unexpected: [],
    created: [],
    actions: [],
    webapp: [],
    get elevated() {
      return elevated;
    },
    loggedOut: [],
  };
  const listings: ListingDetail[] = [];
  if (signedIn)
    await page.addInitScript(
      ({ key, token }) => {
        if (window.sessionStorage.getItem(key) === null) window.sessionStorage.setItem(key, token);
      },
      { key: TOKEN_KEY, token: TOKEN },
    );

  await page.route(match, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, "");
    const method = request.method();
    const key = `${method} ${path}`;

    const staffSession = () =>
      json(route, 200, { token: TOKEN, expiresAt: new Date(NOW.getTime() + 12 * 3_600_000).toISOString() });
    const authorization = request.headers().authorization;
    if (key === "GET /auth/methods")
      return methodsDown ? fail(route, 503, "service_unavailable") : json(route, 200, METHODS);
    if (key === "POST /auth/staff/webapp") {
      const { initData } = request.postDataJSON() as { initData?: unknown };
      if (typeof initData !== "string" || !initData.includes("hash="))
        return fail(route, 401, "invalid_init_data");
      state.webapp.push(initData);
      return staffSession();
    }
    if (key === "POST /auth/hub/exchange") {
      const ok = hub?.exchange(url.origin, "admin", request.postDataJSON()) ?? false;
      return ok
        ? json(route, 200, {
            token: ACCOUNT_TOKEN,
            expiresAt: new Date(NOW.getTime() + 7 * 86_400_000).toISOString(),
          })
        : fail(route, 400, "invalid_code");
    }
    if (authorization === `Bearer ${ACCOUNT_TOKEN}`) {
      if (key === "POST /auth/staff/elevate") {
        elevated++;
        return staffSession();
      }
      if (key === "POST /auth/logout") {
        state.loggedOut.push("account");
        return route.fulfill({ status: 204 });
      }
    }
    if (authorization !== `Bearer ${TOKEN}`) return fail(route, 401, "unauthorized");
    if (key === "POST /auth/logout") {
      state.loggedOut.push("staff");
      return route.fulfill({ status: 204 });
    }

    // Роли того же аккаунта: панель ведёт в кабинет партнёра
    if (key === "GET /me")
      return json(
        route,
        200,
        accountMe({ vendors: [VENDOR_MEMBERSHIP], staff: true }, { kind: "staff", app: "admin" }),
      );
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
        counts: {
          waiting: 0,
          overdue: 1,
          breached: 0,
          answered: 0,
          answered_late: 0,
          ops_contacted: 0,
          closed: 0,
        },
      };
      return json(route, 200, list);
    }
    if (key === `GET /staff/requests/${REQUEST_ID}`) return json(route, 200, REQUEST);
    if (key === "GET /staff/revisions") {
      const list: RevisionList = { total: 1, items: [REVISION] };
      return json(route, 200, list);
    }
    if (key === `GET /staff/revisions/${REVISION_ID}`) return json(route, 200, REVISION);
    if (key === "GET /staff/clients") {
      const list: ClientList = { total: 1, items: [CLIENT_ITEM] };
      return json(route, 200, list);
    }
    if (key === `GET /staff/clients/${CLIENT_ID}`) return json(route, 200, CLIENT);
    if (key === "GET /staff/outbox") return json(route, 200, OUTBOX);
    if (key === "GET /staff/audit") return json(route, 200, AUDIT);
    if (key === "GET /staff/audit/pii") return json(route, 200, { total: 0, items: [] });
    if (key === "GET /staff/team") return json(route, 200, TEAM);
    if (key === "GET /staff/settings") return json(route, 200, SETTINGS);

    state.unexpected.push(key);
    return fail(route, 404, "not_found");
  });
  return state;
}
