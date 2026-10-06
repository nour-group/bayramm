import type {
  AuditList,
  Availability,
  AvailabilityInput,
  CategoryMetricsList,
  ClientDetail,
  ClientList,
  ClientListItem,
  ContactMetrics,
  ListingDetail,
  ListingInput,
  ListingList,
  ListingListItem,
  ListingSaveResult,
  MetricsOverview,
  OutboxHealth,
  PiiAccessList,
  PublishBlocker,
  RevealedListingContacts,
  RevisionDetail,
  RevisionList,
  StaffDictionaries,
  StaffMe,
  StaffPermission,
  StaffRequestDetail,
  StaffRequestList,
  StaffRole,
  StaffSettings,
  TeamList,
  VendorDetail,
  VendorList,
  VendorMetrics,
  VendorMetricsList,
  VendorResponseStats,
} from "@bayramm/shared/api/staff";
import { categoryConfig } from "@bayramm/shared/categories";
import type { Page, Route } from "@playwright/test";
import { accountMe, type HubWatch, METHODS, VENDOR_MEMBERSHIP } from "./account";
import {
  applyAvailability,
  availabilityOf,
  CAR_CONTACTS,
  CAR_LISTING_ID,
  CAR_REQUEST_ID,
  type Calendar,
  carRequest,
  createService,
  decide,
  emptyListing,
  newCalendar,
  normalizeTelegram,
  patchCategoryFields,
  refresh,
  seededListings,
  serviceQueue,
  updateService,
} from "./staff-catalog";
import { isApi } from "./vendor-api";

export {
  BOOKED_DAY,
  BRIDE_CAR_ID,
  CAKE_LISTING_ID,
  CAR_CONTACTS,
  CAR_LISTING_ID,
  CAR_REQUEST_ID,
  LIMOUSINE_ID,
  PHOTO_DECLINE_REASON,
  PHOTO_DECLINED_ID,
  PHOTO_LISTING_ID,
  PHOTO_PENDING_2_ID,
  PHOTO_PENDING_ID,
} from "./staff-catalog";

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
/** Опубликованная карточка с новыми фото вендора — очередь «Новые фото» в модерации */
export const PHOTO_QUEUE_LISTING_ID = "00000000-0000-4000-8100-000000000010";
export const REQUEST_ID = "00000000-0000-4000-8300-000000000001";
const iso = NOW.toISOString();

/* Права ролей — как в apps/api/src/staff/access.ts (единственная таблица там; здесь — её
   копия для подмены GET /staff/me): менеджер ведёт вендоров, карточки и заявки, но не
   публикует; модератор проверяет и публикует, заявок и клиентов не видит */
const ALL_ROLES: readonly StaffRole[] = ["admin", "manager", "moderator"];
const ADMIN_MANAGER: readonly StaffRole[] = ["admin", "manager"];
const ADMIN_MODERATOR: readonly StaffRole[] = ["admin", "moderator"];
const PERMISSION_ROLES: Readonly<Record<StaffPermission, readonly StaffRole[]>> = {
  "catalog.read": ALL_ROLES,
  "vendors.write": ADMIN_MANAGER,
  "vendor_users.write": ADMIN_MANAGER,
  "listings.write": ADMIN_MANAGER,
  "listings.submit": ADMIN_MANAGER,
  "listings.publish": ADMIN_MODERATOR,
  "listings.moderate": ADMIN_MODERATOR,
  "listings.draft": ALL_ROLES,
  "photos.moderate": ADMIN_MODERATOR,
  "vendor_phones.read": ALL_ROLES,
  "requests.read": ADMIN_MANAGER,
  "requests.write": ADMIN_MANAGER,
  "client_phones.read": ["admin"],
  "clients.read": ADMIN_MANAGER,
  "clients.block": ADMIN_MANAGER,
  "outbox.read": ADMIN_MANAGER,
  "outbox.retry": ["admin"],
  "audit.read": ["admin"],
  "settings.write": ["admin"],
  "team.manage": ["admin"],
  "revisions.moderate": ADMIN_MODERATOR,
  "metrics.read": ALL_ROLES,
};

export const permissionsOf = (role: StaffRole): StaffPermission[] =>
  (Object.keys(PERMISSION_ROLES) as StaffPermission[]).filter((p) => PERMISSION_ROLES[p].includes(role));

/** Вошедший сотрудник с этой ролью */
export const staffOf = (role: StaffRole): StaffMe => ({
  id: "00000000-0000-4000-8600-000000000001",
  role,
  displayName: "Дильноза Операторова",
  username: "dilnoza_ops",
  permissions: permissionsOf(role),
});

export const STAFF: StaffMe = staffOf("admin");

const DICTIONARIES: StaffDictionaries = {
  categories: [
    { code: "hall", nameRu: "Тойхона", nameUz: "Toʻyxona", enabled: true },
    { code: "car", nameRu: "Кортеж", nameUz: "Kortej", enabled: true },
  ],
  districts: [
    { code: "yunusobod", nameRu: "Юнусабад", nameUz: "Yunusobod" },
    { code: "chilonzor", nameRu: "Чиланзар", nameUz: "Chilonzor" },
  ],
  occasions: [{ code: "toy", nameRu: "Свадьба", nameUz: "Toʻy" }],
  staff: [{ id: STAFF.id, displayName: STAFF.displayName, role: "admin" }],
  settings: { minPhotos: 3, maxPhotos: 10, slaHours: 12 },
};

const CHECKLIST_OPEN = { done: false, at: null, by: null } as const;

function vendorDetail(listings: readonly ListingDetail[], name = "Lola"): VendorDetail {
  return {
    id: VENDOR_ID,
    code: "V101",
    name,
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
      categoryCode: l.categoryCode,
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
    priceUnit: "per_guest",
    capMin: null,
    capMax: null,
    submittedAt: null,
    publishedAt: null,
    version: 1,
    createdAt: iso,
    updatedAt: iso,
    hasPhone: false,
    hasTelegram: false,
    attributes: {},
    missingAttributes: [],
    videoLinks: [],
    parallelCapacity: 1,
    services: [],
    photos: [],
    blockers: { review: REVIEW_BLOCKERS, active: ACTIVE_BLOCKERS },
    vendor: { id: VENDOR_ID, code: "V101", name: "Lola" },
    history: [
      { from: null, to: "draft", reason: null, actorKind: "staff", actorName: STAFF.displayName, at: iso },
    ],
    pendingRevision: null,
  };
}

/** Опубликованная карточка, в которую вендор из кабинета добавил два фото: ждут решения */
const PHOTO_QUEUE_ITEM: ListingListItem = {
  id: PHOTO_QUEUE_LISTING_ID,
  name: "Bogʻ zali",
  categoryCode: "hall",
  status: "active",
  slug: "bog-zali",
  districtCode: "yunusobod",
  priceFromUzs: 180_000,
  priceUnit: "per_guest",
  capMax: 250,
  updatedAt: iso,
  blockers: [],
  statusReason: null,
  capMin: 40,
  submittedAt: null,
  vendor: { id: VENDOR_ID, code: "V101", name: "Lola" },
  photos: { ready: 7, approved: 5, pending: 2 },
};

/** PATCH карточки: поля, которые заглушка переносит в карточку */
const EDITABLE = [
  "name",
  "slug",
  "districtCode",
  "addressRu",
  "addressUz",
  "descriptionRu",
  "descriptionUz",
  "capMin",
  "capMax",
] as const;

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
  dayPart: null,
  details: {},
  createdAt: new Date(NOW.getTime() - 15 * 3_600_000).toISOString(),
  listing: { id: LISTING_ID, name: "Lola zali", categoryCode: "hall" },
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
  displayName: "Азиза К.",
  signIn: ["telegram"],
  lastRequest: { publicNo: REQUEST.publicNo, listingName: REQUEST.listing.name, status: REQUEST.status },
  createdAt: iso,
  lastSeenAt: iso,
  locale: "uz",
  blocked: false,
  deleted: false,
  requests: 1,
  lastRequestAt: REQUEST.createdAt,
};

/** Остальные клиенты списка: вошёл и Telegram, и телефоном; только телефон, без имени; удалил аккаунт */
const OTHER_CLIENTS: readonly ClientListItem[] = [
  {
    ...CLIENT_ITEM,
    id: "00000000-0000-4000-8800-000000000002",
    ref: "C-3f9a1c2e",
    displayName: "Рустам Б.",
    signIn: ["telegram", "phone"],
    lastRequest: { publicNo: 1049, listingName: "Bogʻ zali", status: "contacted" },
    locale: "ru",
    requests: 3,
    lastRequestAt: new Date(NOW.getTime() - 40 * 3_600_000).toISOString(),
    lastSeenAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
  },
  {
    ...CLIENT_ITEM,
    id: "00000000-0000-4000-8800-000000000003",
    ref: "C-7b21d0aa",
    displayName: null,
    signIn: ["phone"],
    lastRequest: null,
    locale: "uz",
    requests: 0,
    lastRequestAt: null,
    lastSeenAt: null,
  },
  {
    ...CLIENT_ITEM,
    id: "00000000-0000-4000-8800-000000000004",
    ref: "C-c4e8f517",
    displayName: null,
    signIn: [],
    lastRequest: { publicNo: 1012, listingName: "Oq kortej", status: "declined" },
    deleted: true,
    requests: 2,
    lastRequestAt: new Date(NOW.getTime() - 20 * 86_400_000).toISOString(),
  },
];

const CLIENT: ClientDetail = {
  ...CLIENT_ITEM,
  canMessage: true,
  deletedAt: null,
  blockedInfo: null,
  profile: { firstName: "Азиза", lastName: "Каримова", username: "aziza_k" },
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
      recipientLabel: "Бахтиёр Рашидов",
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
      objectLabel: "№1051",
      detail: { recipients: 1 },
      source: "admin",
    },
    {
      id: "2",
      at: iso,
      actorKind: "vendor_user",
      actor: { id: "00000000-0000-4000-8400-0000000000a1", name: "Бахтиёр Рашидов" },
      action: "listing.update",
      objectType: "listing",
      objectId: LISTING_ID,
      objectLabel: "Lola zali",
      detail: { fields: ["name"] },
      source: "vendor_cabinet",
    },
    {
      id: "3",
      at: iso,
      actorKind: "client",
      actor: { id: "00000000-0000-4000-8200-000000000001", name: "C-00000000" },
      action: "request.update",
      objectType: "request",
      objectId: REQUEST_ID,
      objectLabel: "№1051",
      detail: {},
      source: "tma",
    },
    {
      id: "4",
      at: iso,
      actorKind: "staff",
      actor: { id: STAFF.id, name: STAFF.displayName },
      action: "listing.update",
      objectType: "listing",
      objectId: "00000000-0000-4000-8100-0000000000ff",
      objectLabel: null,
      detail: { fields: ["name"] },
      source: "admin",
    },
  ],
};

/** Кто читал телефоны: чей телефон — словами, номеров нет */
const PII_AUDIT: PiiAccessList = {
  total: 2,
  items: [
    {
      id: "1",
      at: iso,
      actorKind: "staff",
      actor: { id: STAFF.id, name: STAFF.displayName },
      subjectKind: "request_contact",
      subjectId: REQUEST_ID,
      subjectLabel: "№1051",
      field: "phone",
      purpose: "staff_reveal",
      reason: "Клиент просит перезвонить",
    },
    {
      id: "2",
      at: iso,
      actorKind: "vendor_user",
      actor: { id: "00000000-0000-4000-8400-0000000000a1", name: "Бахтиёр Рашидов" },
      subjectKind: "request_contact",
      subjectId: REQUEST_ID,
      subjectLabel: null,
      field: "phone",
      purpose: "request_inbox",
      reason: null,
    },
  ],
};

const TEAM: TeamList = {
  items: [
    {
      id: STAFF.id,
      displayName: STAFF.displayName,
      username: STAFF.username,
      invitedBy: "telegram",
      role: "admin",
      active: true,
      accepted: true,
      linked: true,
      linkedAt: iso,
      createdAt: iso,
      self: true,
    },
    {
      id: "00000000-0000-4000-8600-000000000002",
      displayName: "Бахтиёр Менеджеров",
      username: "bakhtiyor_ops",
      invitedBy: "telegram",
      role: "manager",
      active: true,
      accepted: false,
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
    { key: "ops_reminder_pause_minutes", value: 30, updatedAt: iso, updatedBy: null },
    { key: "min_photos", value: 3, updatedAt: iso, updatedBy: STAFF.displayName },
  ],
};

// Метрики запуска: неделя с ответами и текущая без, вендор с низкой долей ответов в срок
const WEEK = {
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
} as const;

const METRICS: MetricsOverview = {
  slaHours: 12,
  category: null,
  weeks: [
    { ...WEEK, weekStart: "2026-09-28", weekLabel: "2026-W40", partial: true, answeredRate: null },
    { ...WEEK, weekStart: "2026-09-21", weekLabel: "2026-W39", partial: false },
  ],
  queues: { awaiting: 3, overdue: 1, deadTotal: 1, listingsReview: 0, revisionsPending: 1, photosPending: 0 },
};

const VENDOR_METRICS: VendorMetrics = {
  vendor: { id: VENDOR_ID, code: "V101", name: "Lola" },
  activeListings: 1,
  categories: ["hall"],
  requests: 5,
  measurable: 4,
  answeredInTime: 1,
  answeredRate: 25,
  responded: 2,
  medianResponseMinutes: 840,
  slaBreaches: 2,
  agreed: 0,
  lastRequestAt: iso,
};

const REVISION: RevisionDetail = {
  id: REVISION_ID,
  status: "pending",
  submittedAt: iso,
  decidedAt: null,
  listing: { id: LISTING_ID, name: "Lola zali", status: "active", categoryCode: "hall" },
  vendor: { id: VENDOR_ID, code: "V101", name: "Lola" },
  proposedBy: { kind: "partner", name: null },
  fields: ["name", "descriptionRu"],
  stale: false,
  changes: [
    { field: "name", before: "Lola zali", after: "Lola Grand" },
    { field: "descriptionRu", before: "Зал на 300 гостей", after: "Зал на 300 гостей, своя кухня" },
  ],
  valid: true,
  decisionReason: null,
  decidedBy: null,
};

export interface StaffApi {
  readonly unexpected: string[];
  /** POST /staff/listings — прежний путь создания карточки (панель им больше не ходит) */
  readonly created: ListingInput[];
  /** POST /staff/vendors — тела создания вендора (с категорией первой витрины) */
  readonly vendorsCreated: Record<string, unknown>[];
  /** POST /staff/vendors/:id/listings — новые витрины вендора */
  readonly vitrinas: Record<string, unknown>[];
  /** PATCH /staff/listings/:id — тела правок витрин */
  readonly patches: Record<string, unknown>[];
  /** Услуги: «МЕТОД путь» и тело (если есть) по порядку */
  readonly services: { readonly key: string; readonly body: unknown }[];
  /** Смены категории витрины */
  readonly categoryChanges: Record<string, unknown>[];
  /** Строки запроса GET /staff/requests, /staff/vendors, /staff/clients и метрик контактов */
  readonly queries: string[];
  /** Витрины, чьи контакты показали («Показать»): POST …/phone — каждое чтение пишется в журнал */
  readonly reveals: string[];
  readonly actions: string[];
  /** Правки занятых дней: тело PUT …/availability (с версией календаря) */
  readonly calendar: AvailabilityInput[];
  /** Решения по фото: POST …/photos/:id/moderation — какое фото и тело (отказ — с причиной) */
  readonly photoDecisions: { readonly listingId: string; readonly photoId: string; readonly body: unknown }[];
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
  /** Роль вошедшего сотрудника: по умолчанию администратор */
  readonly role?: StaffRole;
  /**
   * Отказы API: «МЕТОД путь» (без /api) → [статус, код]. Проверяются раньше всего прочего:
   * так тест видит, что панель говорит словами на 409/422/429
   */
  readonly fail?: Readonly<Record<string, readonly [number, string]>>;
  /**
   * У вендора сразу есть витрины в других категориях (кортеж — опубликован, с услугами и
   * очередью модерации; фото и видео; торты) и заявка на кортеж
   */
  readonly seeded?: boolean;
}

export async function mockStaffApi(
  page: Page,
  {
    signedIn = true,
    methodsDown = false,
    hub,
    match = isApi,
    role = "admin",
    fail: failures = {},
    seeded = false,
  }: StaffApiOptions = {},
) {
  let elevated = 0;
  const state: StaffApi = {
    unexpected: [],
    created: [],
    vendorsCreated: [],
    vitrinas: [],
    patches: [],
    services: [],
    categoryChanges: [],
    queries: [],
    reveals: [],
    actions: [],
    calendar: [],
    photoDecisions: [],
    webapp: [],
    get elevated() {
      return elevated;
    },
    loggedOut: [],
  };
  const listings: ListingDetail[] = seeded ? seededListings() : [];
  let vendorName = "Lola";
  // Занятость каждой витрины и версия её календаря (растёт с каждой правкой)
  const calendars = new Map<string, Calendar>();
  const calendarOf = (id: string) => {
    const found = calendars.get(id) ?? newCalendar(id);
    calendars.set(id, found);
    return found;
  };
  const replace = (listing: ListingDetail) => {
    const next = refresh(listing);
    const index = listings.findIndex((l) => l.id === listing.id);
    if (index >= 0) listings.splice(index, 1, next);
    return next;
  };
  // Телефон и Telegram витрин: пишутся PATCH, читаются по «Показать»; у кортежа есть сразу
  const contacts = new Map<string, { phone: string | null; telegram: string | null }>(
    seeded ? [[CAR_LISTING_ID, { ...CAR_CONTACTS }]] : [],
  );
  const contactsOf = (id: string) => contacts.get(id) ?? { phone: null, telegram: null };
  const requests = seeded ? [REQUEST, carRequest(REQUEST)] : [REQUEST];
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
    const refusal = failures[key];
    if (refusal) return fail(route, refusal[0], refusal[1]);
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
    if (key === "GET /staff/me") return json(route, 200, staffOf(role));
    if (key === "GET /staff/dictionaries") return json(route, 200, DICTIONARIES);
    if (key === "GET /staff/vendors") {
      state.queries.push(`vendors?${url.searchParams}`);
      const detail = vendorDetail(listings, vendorName);
      const category = url.searchParams.get("category");
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
            listings: listings.map((l) => ({
              id: l.id,
              name: l.name,
              status: l.status,
              categoryCode: l.categoryCode,
            })),
            users: 0,
            linkedUsers: 0,
          },
        ],
      };
      if (category && !listings.some((l) => l.categoryCode === category))
        return json(route, 200, { total: 0, items: [] });
      return json(route, 200, list);
    }
    if (key === `GET /staff/vendors/${VENDOR_ID}`)
      return json(route, 200, vendorDetail(listings, vendorName));
    if (key === "POST /staff/vendors") {
      // Один вендор на подмену: «новый» — тот же V101 с новым названием и первой витриной
      const input = request.postDataJSON() as Record<string, unknown>;
      state.vendorsCreated.push(input);
      if (typeof input.name !== "string" || input.name.trim().length < 2)
        return fail(route, 422, "invalid_input", ["name"]);
      const code = input.categoryCode;
      if (code !== undefined && (typeof code !== "string" || !categoryConfig(code)?.enabled))
        return fail(route, 422, "invalid_input", ["categoryCode"]);
      vendorName = input.name.trim();
      listings.splice(0, listings.length);
      if (typeof code === "string") listings.push(emptyListing(LISTING_ID, code, vendorName, "navruz"));
      return json(route, 201, vendorDetail(listings, vendorName));
    }
    if (key === `POST /staff/vendors/${VENDOR_ID}/listings`) {
      const input = request.postDataJSON() as Record<string, unknown>;
      state.vitrinas.push(input);
      const code = input.categoryCode;
      if (typeof code !== "string" || !categoryConfig(code)?.enabled)
        return fail(route, 422, "invalid_input", ["categoryCode"]);
      const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : vendorName;
      // Первая созданная в тесте витрина — LISTING_ID: на неё ведут адреса тестов
      const id = listings.some((l) => l.id === LISTING_ID)
        ? `00000000-0000-4000-8100-0000000001${String(listings.length).padStart(2, "0")}`
        : LISTING_ID;
      const listing = emptyListing(id, code, name, `vitrina-${listings.length + 1}`);
      listings.push(listing);
      return json(route, 201, listing);
    }
    if (key === "GET /staff/services") return json(route, 200, serviceQueue(listings));
    const decision = /^\/staff\/services\/([0-9a-f-]{36})\/(approve|decline)$/.exec(path);
    if (decision?.[1] && method === "POST") {
      const body = decision[2] === "decline" ? (request.postDataJSON() as { reason?: unknown }) : null;
      state.services.push({ key, body });
      const owner = listings.find((l) => l.services.some((sv) => sv.id === decision[1]));
      const current = owner?.services.find((sv) => sv.id === decision[1]);
      if (!owner || !current) return fail(route, 404, "not_found");
      if (decision[2] === "decline" && (typeof body?.reason !== "string" || body.reason.trim() === ""))
        return fail(route, 422, "invalid_input", ["reason"]);
      const next = decide(
        current,
        decision[2] === "approve" ? "approved" : "declined",
        typeof body?.reason === "string" ? body.reason : null,
      );
      replace({ ...owner, services: owner.services.map((sv) => (sv.id === next.id ? next : sv)) });
      return json(route, 200, next);
    }
    if (key === "GET /staff/listings") {
      // Очередь «Новые фото» — опубликованные карточки с фото на решении; остальное пусто
      const photos = url.searchParams.get("photos") === "pending";
      const list: ListingList = {
        total: photos ? 1 : 0,
        items: photos ? [PHOTO_QUEUE_ITEM] : [],
        counts: { lead: 0, draft: listings.length, review: 0, active: 1, suspended: 0, rejected: 0 },
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
    const servicesMatch =
      /^\/staff\/listings\/([0-9a-f-]{36})\/services(?:\/([0-9a-f-]{36})(?:\/(pause|resume))?)?$/.exec(path);
    if (servicesMatch?.[1]) {
      const listing = listings.find((l) => l.id === servicesMatch[1]);
      if (!listing) return fail(route, 404, "not_found");
      const sid = servicesMatch[2];
      const step = servicesMatch[3];
      const body = method === "POST" || method === "PATCH" ? request.postDataJSON() : undefined;
      state.services.push({ key, body });
      if (!sid && method === "GET") return json(route, 200, { items: listing.services });
      if (!sid && method === "POST") {
        const created = createService(listing, (body ?? {}) as Record<string, unknown>, role);
        if (!created.ok) return fail(route, 422, "invalid_input", created.errors);
        replace({ ...listing, services: [...listing.services, created.service] });
        return json(route, 201, created.service);
      }
      const current = listing.services.find((sv) => sv.id === sid);
      if (!current) return fail(route, 404, "not_found");
      const put = (next: (typeof listing.services)[number]) => {
        replace({ ...listing, services: listing.services.map((sv) => (sv.id === next.id ? next : sv)) });
        return json(route, 200, next);
      };
      if (!step && method === "PATCH") {
        const updated = updateService(listing, current, (body ?? {}) as Record<string, unknown>, role);
        if (!updated.ok) return fail(route, 422, "invalid_input", updated.errors);
        return put(updated.service);
      }
      if (step === "pause") return put({ ...current, status: "paused" });
      if (step === "resume") return put({ ...current, status: role === "manager" ? "review" : "active" });
      if (!step && method === "DELETE") {
        replace({ ...listing, services: listing.services.filter((sv) => sv.id !== sid) });
        return route.fulfill({ status: 204 });
      }
    }
    // Решение по фото: отказ — только с причиной (1–500 знаков), как на сервере; ответ — фото витрины
    const photoMatch = /^\/staff\/listings\/([0-9a-f-]{36})\/photos\/([0-9a-f-]{36})\/moderation$/.exec(path);
    if (photoMatch?.[1] && photoMatch[2] && method === "POST") {
      const owner = listings.find((l) => l.id === photoMatch[1]);
      const current = owner?.photos.find((p) => p.id === photoMatch[2]);
      if (!owner || !current) return fail(route, 404, "not_found");
      const body = request.postDataJSON() as { decision?: unknown; reason?: unknown };
      state.photoDecisions.push({ listingId: owner.id, photoId: current.id, body });
      if (body.decision !== "approved" && body.decision !== "declined")
        return fail(route, 422, "invalid_input", ["decision"]);
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (body.decision === "declined" && (reason === "" || reason.length > 500))
        return fail(route, 422, "invalid_input", ["reason"]);
      const photos = owner.photos.map((p) =>
        p.id === current.id
          ? {
              ...p,
              moderation: body.decision as "approved" | "declined",
              declineReason: body.decision === "declined" ? reason : null,
            }
          : p,
      );
      replace({ ...owner, photos });
      return json(route, 200, photos);
    }
    const listingMatch = /^\/staff\/listings\/([0-9a-f-]{36})(?:\/(\w+))?$/.exec(path);
    if (listingMatch?.[1]) {
      const listing = listings.find((l) => l.id === listingMatch[1]);
      if (!listing) return fail(route, 404, "not_found");
      const action = listingMatch[2];
      if (!action && method === "GET") return json(route, 200, listing);
      if (!action && method === "PATCH") {
        // Сотрудник — администратор: решает по правкам сам, на модерацию ничего не уходит
        const input = request.postDataJSON() as ListingInput;
        state.patches.push(input as unknown as Record<string, unknown>);
        if (input.version !== listing.version) return fail(route, 409, "version_conflict");
        const fields = patchCategoryFields(listing, input as unknown as Record<string, unknown>);
        if (!fields.ok) return fail(route, 422, "invalid_input", fields.errors);
        const patch = Object.fromEntries(EDITABLE.filter((k) => k in input).map((k) => [k, input[k]]));
        // Telegram: имя, @имя или t.me/имя → имя без @; null — убрать; плохое — 422 у поля
        const stored = contactsOf(listing.id);
        let telegram = stored.telegram;
        if (input.telegram === null) telegram = null;
        else if (typeof input.telegram === "string") {
          telegram = normalizeTelegram(input.telegram);
          if (telegram === null) return fail(route, 422, "invalid_input", ["telegram"]);
        }
        const phone = typeof input.phone === "string" ? input.phone.replace(/\s+/g, "") : stored.phone;
        contacts.set(listing.id, { phone, telegram });
        const next = replace({
          ...fields.listing,
          ...patch,
          hasPhone: listing.hasPhone || typeof input.phone === "string",
          hasTelegram: telegram !== null,
          version: listing.version + 1,
        });
        const saved: ListingSaveResult = { ...next, sentForModeration: [] };
        return json(route, 200, saved);
      }
      if (action === "category" && method === "POST") {
        const input = request.postDataJSON() as Record<string, unknown>;
        state.categoryChanges.push(input);
        if (input.version !== listing.version) return fail(route, 409, "version_conflict");
        if (listing.services.length > 0) return fail(route, 409, "category_locked");
        const code = input.categoryCode;
        if (typeof code !== "string" || !categoryConfig(code)?.enabled)
          return fail(route, 422, "invalid_input", ["categoryCode"]);
        const next = replace({
          ...listing,
          categoryCode: code,
          attributes: {},
          version: listing.version + 1,
        });
        return json(route, 200, next);
      }
      if (action === "availability" && method === "GET") {
        const from = url.searchParams.get("from") ?? "";
        const to = url.searchParams.get("to") ?? "";
        const availability: Availability = availabilityOf(listing, calendarOf(listing.id), from, to);
        return json(route, 200, availability);
      }
      if (action === "availability" && method === "PUT") {
        // Правка — только от последней версии календаря, как на сервере
        const input = request.postDataJSON() as AvailabilityInput;
        state.calendar.push(input);
        const calendar = calendarOf(listing.id);
        const applied = applyAvailability(listing, calendar, input);
        if (!applied.ok)
          return fail(route, applied.code === "calendar_conflict" ? 409 : 422, applied.code, applied.details);
        const from = applied.days[0] ?? "";
        const to = applied.days.at(-1) ?? from;
        return json(route, 200, availabilityOf(listing, calendar, from, to));
      }
      if (action === "phone" && method === "POST") {
        // Телефон и Telegram одним чтением; у витрины без номера в тесте — условный
        state.reveals.push(listing.id);
        const stored = contactsOf(listing.id);
        const revealed: RevealedListingContacts = {
          phone: listing.hasPhone ? (stored.phone ?? "+998900000001") : null,
          telegram: stored.telegram,
        };
        return json(route, 200, revealed);
      }
      if (action && method === "POST" && ["submit", "publish"].includes(action)) {
        state.actions.push(action);
        const blockers = action === "submit" ? listing.blockers.review : listing.blockers.active;
        return fail(route, 422, "publish_blocked", blockers);
      }
    }
    if (key === "GET /staff/requests") {
      state.queries.push(`requests?${url.searchParams}`);
      const category = url.searchParams.get("category");
      const items = requests.filter((r) => !category || r.listing.categoryCode === category);
      const list: StaffRequestList = {
        total: items.length,
        items,
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
    const car = requests.find((r) => r.id === CAR_REQUEST_ID);
    if (car && key === `GET /staff/requests/${CAR_REQUEST_ID}`) return json(route, 200, car);
    if (key === "GET /staff/revisions") {
      const list: RevisionList = { total: 1, items: [REVISION] };
      return json(route, 200, list);
    }
    if (key === `GET /staff/revisions/${REVISION_ID}`) return json(route, 200, REVISION);
    if (key === "GET /staff/clients") {
      state.queries.push(`clients?${url.searchParams}`);
      const items = [CLIENT_ITEM, ...OTHER_CLIENTS].filter(
        (c) => url.searchParams.get("blocked") !== "1" || c.blocked,
      );
      const list: ClientList = { total: items.length, items };
      return json(route, 200, list);
    }
    if (key === `GET /staff/clients/${CLIENT_ID}`) return json(route, 200, CLIENT);
    if (key === "GET /staff/outbox") return json(route, 200, OUTBOX);
    if (key === "GET /staff/audit") return json(route, 200, AUDIT);
    if (key === "GET /staff/audit/pii") return json(route, 200, PII_AUDIT);
    if (key === "GET /staff/team") return json(route, 200, TEAM);
    if (key === "GET /staff/settings") return json(route, 200, SETTINGS);
    if (key === "GET /staff/metrics")
      return json(route, 200, { ...METRICS, category: url.searchParams.get("category") });
    if (key === "GET /staff/metrics/categories") {
      const list: CategoryMetricsList = {
        days: 30,
        items: [
          {
            ...VENDOR_METRICS,
            categoryCode: "hall",
            activeVendors: 1,
            clients: 4,
            p90ResponseMinutes: 1_200,
            agreedRate: 0,
          },
        ],
      };
      return json(route, 200, list);
    }
    if (key === "GET /staff/metrics/vendors") {
      const list: VendorMetricsList = {
        days: 30,
        category: url.searchParams.get("category"),
        items: [VENDOR_METRICS],
      };
      return json(route, 200, list);
    }
    if (key === "GET /staff/metrics/contacts") {
      state.queries.push(`contacts?${url.searchParams}`);
      const category = url.searchParams.get("category");
      const vendor = { id: VENDOR_ID, name: "Lola" };
      const rows: ContactMetrics["items"][number][] = [
        {
          listing: {
            id: REQUEST.listing.id,
            name: REQUEST.listing.name,
            status: "active",
            categoryCode: "hall",
          },
          vendor,
          opens: 48,
          phone: 21,
          telegram: 9,
          opensPrev: 40,
        },
        {
          listing: { id: CAR_LISTING_ID, name: "Oq kortej", status: "active", categoryCode: "car" },
          vendor,
          opens: 17,
          phone: 6,
          telegram: 7,
          opensPrev: 17,
        },
        {
          listing: { id: PHOTO_QUEUE_LISTING_ID, name: "Bogʻ zali", status: "active", categoryCode: "hall" },
          vendor,
          opens: 5,
          phone: 1,
          telegram: 0,
          opensPrev: 9,
        },
      ];
      const items = rows.filter((row) => !category || row.listing.categoryCode === category);
      const stats: ContactMetrics = { days: 30, category, items };
      return json(route, 200, stats);
    }
    if (key === `GET /staff/metrics/vendors/${VENDOR_ID}`) {
      const stats: VendorResponseStats = { days: 30, vendor: VENDOR_METRICS, listings: [] };
      return json(route, 200, stats);
    }

    state.unexpected.push(key);
    return fail(route, 404, "not_found");
  });
  return state;
}
