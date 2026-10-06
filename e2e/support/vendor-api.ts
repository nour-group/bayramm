import type {
  BusyDay,
  BusyPart,
  DayPart,
  ListingRevisionPayload,
  ListingService,
  PartBookings,
  RequestTab,
  ServiceChanges,
  VendorAttention,
  VendorCalendar,
  VendorCalendarChange,
  VendorListing,
  VendorListingRef,
  VendorMe,
  VendorPhoto,
  VendorRequestDetail,
  VendorRequestItem,
  VendorRequestPatch,
  VendorRevision,
  VendorRole,
} from "@bayramm/shared/api/vendor";
import { TAB_STATUSES } from "@bayramm/shared/api/vendor";
import {
  type CategoryConfig,
  categoryConfig,
  categoryTexts,
  DAY_PARTS,
  type ServiceValues,
  serviceType,
  validateServiceInput,
} from "@bayramm/shared/categories";
import type { Page, Route } from "@playwright/test";
import { APPS, accountMe, BOT, type HubWatch, METHODS, VENDOR_MEMBERSHIP } from "./account";

/* API кабинета вендора в памяти теста: page.route перехватывает /api/* до сети.
   Контракт — @bayramm/shared/api/vendor. Заявки, календарь, фото, правки и услуги меняются по
   PATCH/PUT/POST/DELETE, как у настоящего API; всё незнакомое — 404 и запись в unexpected
   (тест это проверит). Вход — по initData (внутри Telegram) или кодом хаба входа на сайте (hub).

   Витрины: по умолчанию одна — зал (listings: "one"); listings: "many" — ещё кортеж (части
   дня, автопарк, два заказа одновременно), фото и видео (портфолио, ссылки на видео, не
   опубликована) и торты (срок заказа вместо календаря), у каждой — свои заявки, услуги,
   правки и календарь.

   Как у API: правка календаря — только с If-Match от текущей версии (нет — 428, устарела —
   409 calendar_conflict); части дня (?part=) — только у режима parts; карточку (фото, правки,
   услуги) меняет только владелец кабинета — сотруднику площадки (role: "member") 403
   vendor_owner_required. Услуги проверяются теми же правилами (validateServiceInput); правка
   услуги на витрине опубликованной карточки — предложением. Фото — по правилу категории:
   no_people — X-No-Faces, portfolio — X-No-Faces или X-Photo-Consent.

   Отказы команды (declined: true): у зала отклонённое фото с причиной, отклонённая услуга и
   история решений по предложениям (решённых больше пяти). Значки «требует внимания» в
   GET /vendor/me считаются из этого состояния теми же правилами, что в API (vendor/profile.ts):
   отклонённые услуги, отклонённые фото, последнее предложение партнёра отклонено — поэтому
   после удаления фото или нового предложения значок меняется. У сотрудника площадки — нули.
   Первый ответ менеджера (staffReply: true): заявка «связались», которую отметил сотрудник
   (firstResponseBy: "staff"). */

export const NOW = new Date("2026-10-01T07:00:00Z");
const HOUR = 3_600_000;
const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * HOUR).toISOString();
const due = (hoursAgo: number) => new Date(NOW.getTime() + (12 - hoursAgo) * HOUR).toISOString();

export const LISTING_ID = "00000000-0000-4000-8100-000000000001";
/** Витрины режима listings: "many" */
export const CAR_ID = "00000000-0000-4000-8100-000000000002";
export const PHOTO_ID = "00000000-0000-4000-8100-000000000003";
export const CAKE_ID = "00000000-0000-4000-8100-000000000004";
const PHOTO = "http://localhost:8790";

export const REQUEST_NEW = "00000000-0000-4000-8300-000000000001";
export const REQUEST_LATE = "00000000-0000-4000-8300-000000000002";
/** Заявка на кортеж: вечер, поля категории и выбранная услуга с дополнением (listings: "many") */
export const REQUEST_CAR = "00000000-0000-4000-8300-000000000003";
/** Заявка, на которую первым ответил менеджер Bayramm (staffReply: true) */
export const REQUEST_STAFF = "00000000-0000-4000-8300-000000000004";
export const SERVICE_CAR = "00000000-0000-4000-8800-000000000001";
const SERVICE_CAR_OPTION = "00000000-0000-4000-8900-000000000001";

export type SignIn = "ok" | "not_linked" | "disabled" | "expired" | "error";

export interface VendorApi {
  readonly unexpected: string[];
  readonly patches: { readonly id: string; readonly body: VendorRequestPatch }[];
  readonly calls: string[];
  /** Занятые дни зала (витрина LISTING_ID) */
  readonly busy: Map<string, BusyDay>;
  /**
   * Версия календаря зала: растёт на каждой правке. Тест может поднять её сам —
   * «календарь изменил кто-то другой», следующая правка кабинета получит 409
   */
  readonly calendar: { version: number };
  /** Календари всех витрин: версия, сколько заказов одновременно, дни и части дня */
  readonly calendars: Map<string, FakeCalendar>;
  /** Правки календаря, как пришли: «PUT 2026-10-20 If-Match: 1», «PUT 2026-10-24?part=evening If-Match: 1» */
  readonly calendarWrites: string[];
  /** Фото площадки, как в базе (порядок — порядок показа) */
  readonly photos: VendorPhoto[];
  /** Что пришло в POST /photos: витрина, тип, размер и подтверждения «лиц нет» и «согласие» */
  readonly uploads: {
    readonly listingId: string;
    readonly contentType: string;
    readonly bytes: number;
    readonly noFaces: string;
    readonly consent: string;
  }[];
  /** Предложения правок карточки зала, новые первыми */
  readonly revisions: VendorRevision[];
  /** Предложения правок по витринам */
  readonly revisionsOf: Map<string, VendorRevision[]>;
  /** Услуги витрин, как в базе */
  readonly services: Map<string, ListingService[]>;
  /** Запросы к услугам: «POST /vendor/listings/…/services» и тело */
  readonly serviceWrites: { readonly key: string; readonly body: unknown }[];
  /** Какие запросы входящих пришли: tab и listingId */
  readonly inboxQueries: { readonly tab: string; readonly listingId: string | null }[];
  /** Чем входили: тело POST /auth/telegram */
  readonly signIns: unknown[];
  /** Запросы, которым API отказало по роли (vendor_owner_required) */
  readonly ownerOnly: string[];
}

export interface FakeCalendar {
  version: number;
  capacity: number;
  readonly busy: Map<string, BusyDay>;
  /** Ключ — «день/часть» */
  readonly parts: Map<string, BusyPart>;
  readonly bookings: PartBookings[];
}

function item(
  id: string,
  publicNo: number,
  hoursAgo: number,
  overrides: Partial<VendorRequestItem> = {},
): VendorRequestItem {
  return {
    id,
    publicNo,
    status: "new",
    declineReason: null,
    listing: { id: LISTING_ID, name: "Lola zali", categoryCode: "hall" },
    occasionCode: "toy",
    eventDate: "2026-10-24",
    guests: 180,
    dayPart: null,
    details: {},
    budgetMinUzs: 30_000_000,
    budgetMaxUzs: 50_000_000,
    createdAt: at(hoursAgo),
    sla: { dueAt: due(hoursAgo), firstResponseAt: null, breached: hoursAgo > 12 },
    firstResponseBy: null,
    contactName: "Азиза",
    ...overrides,
  };
}

const NO_ATTENTION: VendorAttention = { services: 0, photos: 0, proposals: 0 };
type ListingBase = Omit<VendorListingRef, "attention">;
const HALL_REF: ListingBase = {
  id: LISTING_ID,
  name: "Lola zali",
  status: "active",
  categoryCode: "hall",
};
const MANY_REFS: readonly ListingBase[] = [
  HALL_REF,
  { id: CAR_ID, name: "Kortej Premium", status: "active", categoryCode: "car" },
  { id: PHOTO_ID, name: "Kadr Studio", status: "draft", categoryCode: "photo" },
  { id: CAKE_ID, name: "Shirin Tort", status: "active", categoryCode: "cake" },
];

/** GET /vendor/me: attention считает вызывающий по состоянию витрины (без него — нули) */
export function vendorMe(
  locale: "ru" | "uz" = "ru",
  role: VendorRole = "owner",
  listings: "one" | "many" = "one",
  attention: (listingId: string) => VendorAttention = () => NO_ATTENTION,
): VendorMe {
  return {
    user: { id: "00000000-0000-4000-8200-000000000001", locale, fullName: "Шахло Каримова", role },
    vendor: {
      id: VENDOR_MEMBERSHIP.vendorId,
      code: VENDOR_MEMBERSHIP.code,
      name: VENDOR_MEMBERSHIP.name ?? "",
    },
    listings: (listings === "many" ? MANY_REFS : [HALL_REF]).map((ref) => ({
      ...ref,
      // Исправляет владелец: у сотрудника площадки значков нет
      attention: role === "owner" ? attention(ref.id) : NO_ATTENTION,
    })),
  };
}

const photoOf = (
  n: number,
  moderation: VendorPhoto["moderation"],
  isCover = false,
  listingId = LISTING_ID,
  declineReason: string | null = null,
): VendorPhoto => ({
  id: `00000000-0000-4000-8500-${String(n).padStart(12, "0")}`,
  width: 1600,
  height: 1067,
  moderation,
  declineReason: moderation === "declined" ? declineReason : null,
  isCover,
  src: `${PHOTO}/640/listings/${listingId}/p${n}.webp`,
  srcSet: `${PHOTO}/320/listings/${listingId}/p${n}.webp 320w, ${PHOTO}/640/listings/${listingId}/p${n}.webp 640w`,
});

const svc = (
  patch: Partial<ListingService> & Pick<ListingService, "id" | "type" | "name">,
): ListingService => ({
  status: "active",
  customName: false,
  priceUzs: 1_000_000,
  priceUnit: "per_event",
  minQty: null,
  leadDays: null,
  includes: null,
  options: [],
  sort: 0,
  proposal: null,
  decision: null,
  submittedAt: at(48),
  updatedAt: at(48),
  ...patch,
});

const LISTING: VendorListing = {
  id: LISTING_ID,
  slug: "lola-zali",
  name: "Lola zali",
  status: "active",
  statusReason: null,
  categoryCode: "hall",
  districtCode: "yunusobod",
  address: { ru: "Ташкент, Юнусабад, 4-й квартал", uz: "Toshkent, Yunusobod, 4-mavze" },
  description: { ru: "Зал на 300 гостей, своя кухня.", uz: "300 mehmonga zal, oshxona bor." },
  priceFromUzs: 25_000_000,
  priceUnit: "per_event",
  capMin: 80,
  capMax: 300,
  photos: [
    photoOf(1, "approved", true),
    photoOf(2, "approved"),
    photoOf(3, "approved"),
    photoOf(4, "pending"),
  ],
  phone: "+998000000001",
  blockers: [],
  photoLimits: { min: 3, max: 10 },
  attributes: { halls_count: 2, parking_spaces: 80, stage: true },
  missingAttributes: [],
  videoLinks: [],
  parallelCapacity: 1,
  services: [],
};

/** Услуги зала: банкеты будни и выходные — на витрине */
const HALL_SERVICES: readonly ListingService[] = [
  svc({
    id: "00000000-0000-4000-8800-000000000011",
    type: "banquet_weekday",
    name: categoryTexts("svc_hall_banquet_weekday"),
    priceUzs: 25_000_000,
  }),
  svc({
    id: "00000000-0000-4000-8800-000000000012",
    type: "banquet_weekend",
    name: categoryTexts("svc_hall_banquet_weekend"),
    priceUzs: 30_000_000,
    sort: 1,
  }),
];

const CAR: VendorListing = {
  ...LISTING,
  id: CAR_ID,
  slug: "kortej-premium",
  name: "Kortej Premium",
  categoryCode: "car",
  districtCode: null,
  description: { ru: "Свадебный кортеж.", uz: "Toʻy korteji." },
  priceFromUzs: 300_000,
  priceUnit: "per_hour",
  capMin: null,
  capMax: null,
  photos: [
    photoOf(11, "approved", true, CAR_ID),
    photoOf(12, "approved", false, CAR_ID),
    photoOf(13, "approved", false, CAR_ID),
  ],
  attributes: {
    fleet: [{ model: "Chevrolet Malibu", class: "sedan", color: "white", seats: 4 }],
    service_area: "tashkent",
  },
  parallelCapacity: 2,
};

const CAR_SERVICES: readonly ListingService[] = [
  svc({
    id: SERVICE_CAR,
    type: "bride_car",
    name: categoryTexts("svc_car_bride_car"),
    priceUzs: 300_000,
    priceUnit: "per_hour",
    minQty: 3,
    options: [
      {
        id: SERVICE_CAR_OPTION,
        code: "flower_decor",
        name: categoryTexts("opt_flower_decor"),
        priceUzs: 500_000,
        priceUnit: "per_event",
      },
    ],
  }),
];

const PHOTO_LISTING: VendorListing = {
  ...LISTING,
  id: PHOTO_ID,
  slug: "kadr-studio",
  name: "Kadr Studio",
  status: "draft",
  categoryCode: "photo",
  districtCode: null,
  description: { ru: "", uz: "" },
  priceFromUzs: null,
  priceUnit: "per_event",
  capMin: null,
  capMax: null,
  photos: [],
  blockers: ["price", "descriptions", "attributes", "photos"],
  attributes: {},
  missingAttributes: ["team", "delivery_days"],
};

const CAKE: VendorListing = {
  ...LISTING,
  id: CAKE_ID,
  slug: "shirin-tort",
  name: "Shirin Tort",
  categoryCode: "cake",
  districtCode: null,
  description: { ru: "Торты на заказ.", uz: "Buyurtma tortlar." },
  priceFromUzs: 180_000,
  priceUnit: "per_kg",
  capMin: null,
  capMax: null,
  photos: [
    photoOf(21, "approved", true, CAKE_ID),
    photoOf(22, "approved", false, CAKE_ID),
    photoOf(23, "approved", false, CAKE_ID),
  ],
  attributes: { cake_kinds: ["wedding"], lead_days: 3 },
};

const CAKE_SERVICES: readonly ListingService[] = [
  svc({
    id: "00000000-0000-4000-8800-000000000031",
    type: "wedding_cake",
    name: categoryTexts("svc_cake_wedding_cake"),
    priceUzs: 180_000,
    priceUnit: "per_kg",
    leadDays: 5,
  }),
];

export const isApi = (url: URL) => url.hostname === "localhost" && url.pathname.startsWith("/api/");
const TOKEN = "e2e-vendor-token";

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const fail = (route: Route, status: number, code: string, details?: readonly string[]) =>
  json(route, status, { error: { code, message: code, ...(details ? { details } : {}) } });

export interface VendorApiOptions {
  /** Чем ответит вход по initData */
  readonly signIn?: SignIn;
  /** У аккаунта есть и роль сотрудника: в кабинете видна ссылка на панель */
  readonly staff?: boolean;
  /** Обмен кода хаба (POST /auth/hub/exchange) сверяется с навигациями страницы */
  readonly hub?: HubWatch;
  /** Какие запросы перехватывать: по умолчанию /api любого localhost */
  readonly match?: (url: URL) => boolean;
  /** Роль в кабинете: owner (по умолчанию) меняет карточку, member — только заявки и календарь */
  readonly role?: VendorRole;
  /** Витрины: одна (зал) или несколько в разных категориях */
  readonly listings?: "one" | "many";
  /** Отказы команды по залу: фото с причиной, услуга, предложения (см. шапку файла) */
  readonly declined?: boolean;
  /** Заявка, на которую первым ответил менеджер Bayramm */
  readonly staffReply?: boolean;
}

/** Значения услуги из формы (validateServiceInput) → поля услуги, как их вернул бы API */
function applyValues(
  service: ListingService,
  values: ServiceValues,
  category: CategoryConfig,
  newId: () => string,
): ListingService {
  const type = serviceType(category, service.type);
  return {
    ...service,
    ...(values.name ? { name: values.name } : {}),
    ...(values.priceUzs === undefined ? {} : { priceUzs: values.priceUzs }),
    ...(values.priceUnit === undefined ? {} : { priceUnit: values.priceUnit }),
    ...(values.minQty === undefined ? {} : { minQty: values.minQty }),
    ...(values.leadDays === undefined ? {} : { leadDays: values.leadDays }),
    ...(values.includes === undefined ? {} : { includes: values.includes }),
    ...(values.options === undefined
      ? {}
      : {
          options: values.options.map((o) => ({
            id: o.id ?? newId(),
            code: o.code ?? null,
            name: o.name,
            priceUzs: o.priceUzs,
            priceUnit: o.priceUnit,
          })),
        }),
    customName: type?.freeName ?? false,
  };
}

/** Что меняет правка услуги на витрине: только отличающиеся поля */
function changesOf(before: ListingService, after: ListingService): ServiceChanges {
  const out: Record<string, unknown> = {};
  for (const key of ["name", "priceUzs", "priceUnit", "minQty", "leadDays", "includes"] as const) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) out[key] = after[key];
  }
  const options = (s: ListingService) =>
    JSON.stringify(
      s.options.map((o) => ({ ...o, id: before.options.some((b) => b.id === o.id) ? o.id : "" })),
    );
  if (options(before) !== options(after)) out.options = after.options;
  return out as ServiceChanges;
}

/** Подменить /api кабинета */
export async function mockVendorApi(
  page: Page,
  {
    signIn = "ok",
    staff = false,
    hub,
    match = isApi,
    role = "owner",
    listings: listingMode = "one",
    declined = false,
    staffReply = false,
  }: VendorApiOptions = {},
): Promise<VendorApi> {
  const many = listingMode === "many";
  const hallCalendar: FakeCalendar = {
    version: 1,
    capacity: 1,
    busy: new Map(),
    parts: new Map(),
    bookings: [],
  };
  const hallRevisions: VendorRevision[] = [];
  const state: VendorApi = {
    unexpected: [],
    patches: [],
    calls: [],
    busy: hallCalendar.busy,
    calendar: hallCalendar,
    calendars: new Map([[LISTING_ID, hallCalendar]]),
    calendarWrites: [],
    photos: [...LISTING.photos],
    uploads: [],
    revisions: hallRevisions,
    revisionsOf: new Map([[LISTING_ID, hallRevisions]]),
    services: new Map([[LISTING_ID, [...HALL_SERVICES]]]),
    serviceWrites: [],
    inboxQueries: [],
    signIns: [],
    ownerOnly: [],
  };
  const cards = new Map<string, VendorListing>([[LISTING_ID, LISTING]]);
  const photosOf = new Map<string, VendorPhoto[]>([[LISTING_ID, state.photos]]);
  if (many) {
    for (const [card, services] of [
      [CAR, CAR_SERVICES],
      [PHOTO_LISTING, []],
      [CAKE, CAKE_SERVICES],
    ] as const) {
      cards.set(card.id, card);
      photosOf.set(card.id, [...card.photos]);
      state.services.set(card.id, [...services]);
      state.revisionsOf.set(card.id, []);
      state.calendars.set(card.id, {
        version: 1,
        capacity: card.parallelCapacity,
        busy: new Map(),
        parts: new Map(),
        bookings: [],
      });
    }
    // Кортеж: 20-е занято целиком, утро 24-го закрыл вендор, вечер 24-го — одна договорённость из двух
    const car = state.calendars.get(CAR_ID);
    car?.busy.set("2026-10-20", { day: "2026-10-20", source: "vendor", requestId: null });
    car?.parts.set("2026-10-24/morning", {
      day: "2026-10-24",
      part: "morning",
      source: "vendor",
      requestId: null,
    });
    car?.bookings.push({ day: "2026-10-24", part: "evening", count: 1 });
  }
  if (declined) {
    // Отказы команды по залу: фото с причиной, отклонённая услуга и история решений (новые первыми)
    state.photos.push(photoOf(5, "declined", false, LISTING_ID, "На фото виден человек"));
    state.services.get(LISTING_ID)?.push(
      svc({
        id: "00000000-0000-4000-8800-000000000013",
        type: "other",
        name: { ru: "Фуршет", uz: "Furshet" },
        customName: true,
        status: "rejected",
        sort: 2,
        decision: { outcome: "declined", reason: "Укажите, что входит в цену", at: at(20) },
      }),
    );
    const decidedRevision = (
      n: number,
      status: "approved" | "declined",
      hoursAgo: number,
      reason: string | null,
      payload: ListingRevisionPayload,
    ): VendorRevision => ({
      id: `00000000-0000-4000-8700-0000000000a${n}`,
      status,
      submittedAt: at(hoursAgo + 2),
      decidedAt: at(hoursAgo),
      decisionReason: reason,
      payload,
      byTeam: false,
    });
    hallRevisions.push(
      decidedRevision(1, "declined", 30, "Название не как на вывеске", { name: "Lola Grand" }),
      decidedRevision(2, "approved", 100, null, { description_ru: "Зал на 300 гостей, своя кухня." }),
      decidedRevision(3, "declined", 200, "Описание без контактов", { description_uz: "Katta zal" }),
      decidedRevision(4, "approved", 300, null, { attributes: { parking_spaces: 80 } }),
      decidedRevision(5, "approved", 400, null, { video_links: [] }),
      decidedRevision(6, "declined", 500, "Слишком длинное название", { name: "Lola Grand Palace Hall" }),
    );
  }
  /** Что ждёт партнёра на витрине — те же правила, что у API (vendor/profile.ts) */
  const attentionOf = (id: string): VendorAttention => {
    const last = state.revisionsOf.get(id)?.[0];
    return {
      services: (state.services.get(id) ?? []).filter((s) => s.status === "rejected").length,
      photos: (photosOf.get(id) ?? []).filter((p) => p.moderation === "declined").length,
      proposals: last?.status === "declined" && !last.byTeam ? 1 : 0,
    };
  };
  let photoNo = 30;
  let serviceNo = 100;
  let locale: "ru" | "uz" = "ru";
  const newId = () => `00000000-0000-4000-8a00-${String(++serviceNo).padStart(12, "0")}`;

  const requests = new Map<string, VendorRequestDetail>([
    [
      REQUEST_NEW,
      {
        ...item(REQUEST_NEW, 1051, 3),
        declineNote: null,
        contact: { name: "Азиза", phone: "+998001234567", comment: "Нужен детский стол" },
        history: [{ status: "new", at: at(3), by: "client" }],
      },
    ],
    [
      REQUEST_LATE,
      {
        ...item(REQUEST_LATE, 1047, 15, { status: "viewed", eventDate: "2026-11-07", contactName: "Бекзод" }),
        declineNote: null,
        contact: { name: "Бекзод", phone: "+998007654321", comment: null },
        history: [
          { status: "new", at: at(15), by: "client" },
          { status: "viewed", at: at(14), by: "vendor_user" },
        ],
      },
    ],
  ]);
  if (many) {
    requests.set(REQUEST_CAR, {
      ...item(REQUEST_CAR, 1060, 2, {
        listing: { id: CAR_ID, name: "Kortej Premium", categoryCode: "car" },
        guests: null,
        dayPart: "evening",
        eventDate: "2026-10-24",
        contactName: "Дильноза",
        budgetMinUzs: null,
        budgetMaxUzs: 3_000_000,
        details: {
          start_time: "18:00",
          hours: 5,
          cars_count: 3,
          car_class: "premium",
          services: [
            {
              id: SERVICE_CAR,
              type: "bride_car",
              name: categoryTexts("svc_car_bride_car"),
              priceUzs: 300_000,
              priceUnit: "per_hour",
              qty: 5,
              options: [
                {
                  id: SERVICE_CAR_OPTION,
                  name: categoryTexts("opt_flower_decor"),
                  priceUzs: 500_000,
                  priceUnit: "per_event",
                },
              ],
            },
          ],
        },
      }),
      declineNote: null,
      contact: { name: "Дильноза", phone: "+998005551122", comment: "Белые машины" },
      history: [{ status: "new", at: at(2), by: "client" }],
    });
  }
  if (staffReply) {
    // «Связались» отметил менеджер Bayramm из панели: первый ответ — не партнёра
    requests.set(REQUEST_STAFF, {
      ...item(REQUEST_STAFF, 1040, 5, {
        status: "contacted",
        contactName: "Нодира",
        sla: { dueAt: due(5), firstResponseAt: at(4), breached: false },
        firstResponseBy: "staff",
      }),
      declineNote: null,
      contact: { name: "Нодира", phone: "+998005550001", comment: null },
      history: [
        { status: "new", at: at(5), by: "client" },
        { status: "contacted", at: at(4), by: "staff" },
      ],
    });
  }
  state.busy.set("2026-10-10", { day: "2026-10-10", source: "vendor", requestId: null });
  state.busy.set("2026-10-17", { day: "2026-10-17", source: "staff", requestId: null });

  const tabOf = (status: VendorRequestItem["status"]): RequestTab =>
    (Object.keys(TAB_STATUSES) as RequestTab[]).find((tab) => TAB_STATUSES[tab].includes(status)) ?? "closed";
  const listItem = (detail: VendorRequestDetail): VendorRequestItem => {
    const { declineNote: _n, contact: _c, history: _h, ...rest } = detail;
    return rest;
  };
  const listingView = (id: string): VendorListing | null => {
    const card = cards.get(id);
    if (!card) return null;
    const services = state.services.get(id) ?? [];
    return { ...card, photos: photosOf.get(id) ?? [], services };
  };

  // Только /api/* своего origin: исходники в разработке тоже бывают по путям с «/api/»
  await page.route(match, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, "");
    const method = request.method();
    const key = `${method} ${path}`;

    if (key === "GET /telegram/bot") return json(route, 200, { username: BOT, miniAppUrl: APPS.web });
    if (key === "GET /auth/methods") return json(route, 200, METHODS);
    if (key === "POST /auth/hub/exchange") {
      const ok = hub?.exchange(url.origin, "vendor", request.postDataJSON()) ?? false;
      return ok
        ? json(route, 200, { token: TOKEN, expiresAt: new Date(NOW.getTime() + 7 * 24 * HOUR).toISOString() })
        : fail(route, 400, "invalid_code");
    }
    // Кабинет входит общим адресом с app: "vendor"; устаревший /auth/vendor/telegram — в unexpected
    if (key === "POST /auth/telegram") {
      const body = request.postDataJSON() as { app?: unknown };
      state.signIns.push(body);
      if (body.app !== "vendor") return fail(route, 400, "invalid_request");
      if (signIn === "not_linked") return fail(route, 403, "vendor_not_linked");
      if (signIn === "disabled") return fail(route, 403, "vendor_disabled");
      if (signIn === "expired") return fail(route, 401, "invalid_init_data");
      if (signIn === "error") return fail(route, 503, "service_unavailable");
      return json(route, 200, {
        token: TOKEN,
        expiresAt: new Date(NOW.getTime() + 12 * HOUR).toISOString(),
      });
    }
    if (request.headers().authorization !== `Bearer ${TOKEN}`) return fail(route, 401, "unauthorized");

    if (key === "GET /me")
      return json(
        route,
        200,
        accountMe({ vendors: [{ ...VENDOR_MEMBERSHIP, role }], staff }, { kind: "account", app: "vendor" }),
      );
    if (key === "POST /auth/logout") return route.fulfill({ status: 204 });

    if (key === "GET /vendor/me") return json(route, 200, vendorMe(locale, role, listingMode, attentionOf));
    if (key === "PATCH /vendor/me") {
      locale = (request.postDataJSON() as { locale: "ru" | "uz" }).locale;
      return json(route, 200, vendorMe(locale, role, listingMode, attentionOf));
    }
    if (key === "GET /vendor/requests") {
      const tab = (url.searchParams.get("tab") ?? "new") as RequestTab;
      const listingId = url.searchParams.get("listingId");
      state.inboxQueries.push({ tab, listingId });
      // Чужая или несуществующая витрина — пустой список, как у API
      const all = [...requests.values()].filter((r) => listingId === null || r.listing.id === listingId);
      const counts = { new: 0, active: 0, closed: 0 };
      for (const r of all) counts[tabOf(r.status)]++;
      const items = all.filter((r) => tabOf(r.status) === tab).map(listItem);
      return json(route, 200, { items, nextCursor: null, counts });
    }
    const requestMatch = /^\/vendor\/requests\/([0-9a-f-]{36})(\/call)?$/.exec(path);
    if (requestMatch?.[1]) {
      const id = requestMatch[1];
      const current = requests.get(id);
      if (!current) return fail(route, 404, "not_found");
      if (requestMatch[2] && method === "POST") {
        state.calls.push(id);
        return route.fulfill({ status: 204 });
      }
      if (method === "GET") {
        // Открытие новой отмечает её просмотренной — как API
        if (current.status === "new") {
          const viewed: VendorRequestDetail = {
            ...current,
            status: "viewed",
            history: [...current.history, { status: "viewed", at: NOW.toISOString(), by: "vendor_user" }],
          };
          requests.set(id, viewed);
          return json(route, 200, viewed);
        }
        return json(route, 200, current);
      }
      if (method === "PATCH") {
        const body = request.postDataJSON() as VendorRequestPatch;
        state.patches.push({ id, body });
        const next: VendorRequestDetail = {
          ...current,
          status: body.status,
          declineReason: body.declineReason ?? null,
          sla: { ...current.sla, firstResponseAt: current.sla.firstResponseAt ?? NOW.toISOString() },
          // Первый ответ остаётся за тем, кто ответил первым (так база не даёт его менять)
          firstResponseBy: current.sla.firstResponseAt ? current.firstResponseBy : "vendor_user",
          history: [...current.history, { status: body.status, at: NOW.toISOString(), by: "vendor_user" }],
        };
        requests.set(id, next);
        return json(route, 200, listItem(next));
      }
    }

    const listingMatch = /^\/vendor\/listings\/([0-9a-f-]{36})(\/.*)?$/.exec(path);
    const listingId = listingMatch?.[1] ?? "";
    const rest = listingMatch?.[2] ?? "";
    const card = listingMatch ? cards.get(listingId) : undefined;
    if (listingMatch && !card) return fail(route, 404, "not_found");
    if (card && rest === "" && method === "GET") return json(route, 200, listingView(listingId));

    // Карточку (фото, правки, услуги) меняет только владелец кабинета — как vendor/access.ts
    const changesCard = method !== "GET" && /^\/(revisions|photos|services)(\/|$)/.test(rest);
    if (card && changesCard && role !== "owner") {
      state.ownerOnly.push(key);
      return fail(route, 403, "vendor_owner_required");
    }

    if (card && rest === "/photos" && method === "POST") {
      const noFaces = request.headers()["x-no-faces"] ?? "";
      const consent = request.headers()["x-photo-consent"] ?? "";
      const portfolio = categoryConfig(card.categoryCode)?.photoPolicy === "portfolio";
      if (portfolio ? noFaces !== "1" && consent !== "1" : noFaces !== "1")
        return fail(route, 422, portfolio ? "photo_consent_required" : "no_faces_ack_required");
      const photos = photosOf.get(listingId) ?? [];
      if (photos.length >= card.photoLimits.max) return fail(route, 409, "too_many_photos");
      state.uploads.push({
        listingId,
        contentType: request.headers()["content-type"] ?? "",
        bytes: request.postDataBuffer()?.length ?? 0,
        noFaces,
        consent,
      });
      photoNo += 1;
      const photo = photoOf(photoNo, "pending", false, listingId);
      photos.push(photo);
      return json(route, 201, photo);
    }
    const photoMatch = /^\/photos\/([0-9a-f-]{36})$/.exec(rest);
    if (card && photoMatch && method === "DELETE") {
      const photos = photosOf.get(listingId) ?? [];
      const index = photos.findIndex((p) => p.id === photoMatch[1]);
      const photo = photos[index];
      if (!photo) return fail(route, 404, "not_found");
      // Опубликованная площадка не останется без минимума одобренных фото
      const approved = photos.filter((p) => p.moderation === "approved").length;
      if (photo.moderation === "approved" && approved <= card.photoLimits.min) {
        return fail(route, 422, "publish_blocked", ["photos"]);
      }
      photos.splice(index, 1);
      return route.fulfill({ status: 204 });
    }

    const revisions = state.revisionsOf.get(listingId) ?? [];
    if (card && rest === "/revisions" && method === "GET") return json(route, 200, { items: revisions });
    if (card && rest === "/revisions" && method === "POST") {
      if (revisions.some((r) => r.status === "pending")) return fail(route, 409, "revision_pending");
      const revision: VendorRevision = {
        id: `00000000-0000-4000-8700-0000000000${String(revisions.length + 1).padStart(2, "0")}`,
        status: "pending",
        submittedAt: NOW.toISOString(),
        decidedAt: null,
        decisionReason: null,
        payload: request.postDataJSON() as ListingRevisionPayload,
        byTeam: false,
      };
      revisions.unshift(revision);
      return json(route, 201, revision);
    }
    const withdraw = /^\/revisions\/([0-9a-f-]{36})\/withdraw$/.exec(rest);
    if (card && withdraw && method === "POST") {
      const index = revisions.findIndex((r) => r.id === withdraw[1]);
      const current = revisions[index];
      if (!current) return fail(route, 404, "not_found");
      if (current.status !== "pending") return fail(route, 409, "illegal_transition");
      if (current.byTeam) return fail(route, 403, "forbidden_for_actor");
      const next: VendorRevision = { ...current, status: "withdrawn" };
      revisions[index] = next;
      return json(route, 200, next);
    }

    // ── услуги ───────────────────────────────────────────────────────────────
    const category = card ? categoryConfig(card.categoryCode) : undefined;
    const services = state.services.get(listingId) ?? [];
    if (card && category && rest.startsWith("/services")) {
      const body = method === "GET" || method === "DELETE" ? undefined : (request.postDataJSON() as unknown);
      if (method !== "GET") state.serviceWrites.push({ key, body });
      if (rest === "/services" && method === "GET") return json(route, 200, { items: services });
      if (rest === "/services" && method === "POST") {
        const { submit = true, ...input } = (body ?? {}) as { submit?: boolean } & Record<string, unknown>;
        const result = validateServiceInput(category, input, { create: true });
        if (!result.ok) return fail(route, 422, "invalid_input", result.errors);
        if (services.length >= 30) return fail(route, 409, "too_many_services");
        const type = result.value.type ?? "other";
        const created = applyValues(
          svc({
            id: newId(),
            type,
            name: serviceType(category, type)?.freeName
              ? { ru: "", uz: "" }
              : categoryTexts(serviceType(category, type)?.label ?? "svc_other"),
            status: submit ? "review" : "draft",
            sort: services.length,
            submittedAt: submit ? NOW.toISOString() : null,
          }),
          result.value,
          category,
          newId,
        );
        services.push(created);
        return json(route, 201, created);
      }
      const one = /^\/services\/([0-9a-f-]{36})(\/submit|\/withdraw)?$/.exec(rest);
      const index = one ? services.findIndex((s) => s.id === one[1]) : -1;
      const current = services[index];
      if (!one || !current) return fail(route, 404, "not_found");
      const save = (next: ListingService) => {
        services[index] = next;
        return json(route, 200, next);
      };
      if (!one[2] && method === "PATCH") {
        const { submit = true, ...input } = (body ?? {}) as { submit?: boolean } & Record<string, unknown>;
        const result = validateServiceInput(category, input, { create: false, typeCode: current.type });
        if (!result.ok) return fail(route, 422, "invalid_input", result.errors);
        const edited = applyValues(current, result.value, category, newId);
        const restricted = ["review", "active", "suspended"].includes(card.status);
        if (restricted && (current.status === "active" || current.status === "paused")) {
          const changes = changesOf(current, edited);
          if (Object.keys(changes).length === 0) return fail(route, 422, "no_changes");
          return save({ ...current, proposal: { changes, submittedAt: NOW.toISOString() } });
        }
        const status =
          submit && (current.status === "draft" || current.status === "rejected") ? "review" : current.status;
        return save({ ...edited, status });
      }
      if (one[2] === "/submit" && method === "POST") {
        if (!["draft", "rejected", "paused"].includes(current.status))
          return fail(route, 409, "illegal_transition");
        return save({ ...current, status: "review", submittedAt: NOW.toISOString() });
      }
      if (one[2] === "/withdraw" && method === "POST") {
        if (current.status === "review") return save({ ...current, status: "draft" });
        if (current.proposal) return save({ ...current, proposal: null });
        if (current.status === "active") return save({ ...current, status: "paused" });
        return fail(route, 409, "illegal_transition");
      }
      if (!one[2] && method === "DELETE") {
        if (current.status === "active") return fail(route, 409, "illegal_transition");
        services.splice(index, 1);
        return route.fulfill({ status: 204 });
      }
    }

    // ── календарь ────────────────────────────────────────────────────────────
    const calendarState = state.calendars.get(listingId);
    const mode = category?.availability ?? "day";
    if (card && calendarState && rest === "/calendar" && method === "GET") {
      // Срок заказа вместо календаря: кабинет его не запрашивает
      if (mode === "lead") {
        state.unexpected.push(key);
        return fail(route, 404, "not_found");
      }
      const month = url.searchParams.get("month") ?? "2026-10";
      const calendar: VendorCalendar = {
        listingId,
        month,
        today: "2026-10-01",
        maxDay: "2027-09-30",
        busy: [...calendarState.busy.values()].filter((b) => b.day.startsWith(month)),
        requestDays: [...requests.values()]
          .filter((r) => r.listing.id === listingId)
          .map((r) => r.eventDate)
          .filter((d) => d.startsWith(month)),
        version: calendarState.version,
        mode,
        parallelCapacity: calendarState.capacity,
        parts: [...calendarState.parts.values()].filter((p) => p.day.startsWith(month)),
        bookings: calendarState.bookings.filter((b) => b.day.startsWith(month)),
      };
      return json(route, 200, calendar);
    }
    // Правка — от версии, которую видел человек: как calendar/version.ts в API
    const versionCheck = () => {
      const ifMatch = request.headers()["if-match"];
      if (ifMatch === undefined || ifMatch.trim() === "") return "version_required";
      if (Number(ifMatch.replace(/^(?:W\/)?"?|"$/g, "")) !== calendarState?.version)
        return "calendar_conflict";
      return null;
    };
    if (card && calendarState && rest === "/calendar/capacity" && method === "PUT") {
      state.calendarWrites.push(`PUT capacity If-Match: ${request.headers()["if-match"] ?? "—"}`);
      const problem = versionCheck();
      if (problem) return fail(route, problem === "version_required" ? 428 : 409, problem);
      const value = (request.postDataJSON() as { parallelCapacity?: unknown }).parallelCapacity;
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 50)
        return fail(route, 422, "invalid_input", ["parallelCapacity"]);
      calendarState.capacity = value;
      calendarState.version += 1;
      return json(route, 200, { parallelCapacity: value, version: calendarState.version });
    }
    const dayMatch = /^\/calendar\/(\d{4}-\d{2}-\d{2})$/.exec(rest);
    if (card && calendarState && dayMatch?.[1] && (method === "PUT" || method === "DELETE")) {
      const day = dayMatch[1];
      const partParam = url.searchParams.get("part");
      const part = partParam === null ? null : (partParam as DayPart);
      state.calendarWrites.push(
        `${method} ${day}${part ? `?part=${part}` : ""} If-Match: ${request.headers()["if-match"] ?? "—"}`,
      );
      if (part !== null && (mode !== "parts" || !(DAY_PARTS as readonly string[]).includes(part)))
        return fail(route, 422, "invalid_input", ["part"]);
      const problem = versionCheck();
      if (problem) return fail(route, problem === "version_required" ? 428 : 409, problem);
      let busy: BusyDay | BusyPart | null;
      if (part === null) {
        if (calendarState.busy.get(day)?.source === "staff") return fail(route, 403, "forbidden_for_actor");
        if (method === "PUT" && !calendarState.busy.has(day))
          calendarState.busy.set(day, { day, source: "vendor", requestId: null });
        if (method === "DELETE") calendarState.busy.delete(day);
        busy = calendarState.busy.get(day) ?? null;
      } else {
        const partKey = `${day}/${part}`;
        if (calendarState.parts.get(partKey)?.source === "staff")
          return fail(route, 403, "forbidden_for_actor");
        if (method === "PUT" && !calendarState.parts.has(partKey))
          calendarState.parts.set(partKey, { day, part, source: "vendor", requestId: null });
        if (method === "DELETE") calendarState.parts.delete(partKey);
        busy = calendarState.parts.get(partKey) ?? null;
      }
      calendarState.version += 1;
      const change: VendorCalendarChange = { day, part, busy, version: calendarState.version };
      return json(route, 200, change);
    }

    state.unexpected.push(key);
    return fail(route, 404, "not_found");
  });
  return state;
}
