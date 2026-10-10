import type {
  Availability,
  AvailabilityInput,
  BusyDay,
  BusyPart,
  DayPartRef,
  ListingDetail,
  ListingService,
  PartBookings,
  PublishBlocker,
  ServiceQueue,
  ServiceQueueItem,
  StaffPhoto,
  StaffRequestDetail,
  StaffRole,
} from "@bayramm/shared/api/staff";
import {
  type CategoryConfig,
  categoryConfig,
  categoryTexts,
  mergeAttributes,
  missingAttributes,
  readAttributes,
  type ServiceOptionValue,
  serviceType,
  validateAttributePatch,
  validateServiceInput,
  validateVideoLinks,
} from "@bayramm/shared/categories";

/* Категории в подмене API панели (staff-api.ts): витрины в разных категориях, данные витрины,
   услуги и их модерация, занятость по частям дня. Проверки — те же функции
   @bayramm/shared/categories, что у сервера: ошибка поля в тесте — та же, что в жизни. */

export const NOW = new Date("2026-10-01T07:00:00Z");
const iso = NOW.toISOString();

export const VENDOR_ID = "00000000-0000-4000-8400-000000000001";
const VENDOR_REF = { id: VENDOR_ID, code: "V101", name: "Lola" } as const;

/** Витрины, которые есть сразу (seeded): кортеж опубликован, фото и торты — черновики */
export const CAR_LISTING_ID = "00000000-0000-4000-8100-000000000c01";
export const PHOTO_LISTING_ID = "00000000-0000-4000-8100-000000000c02";
export const CAKE_LISTING_ID = "00000000-0000-4000-8100-000000000c03";
export const CAR_REQUEST_ID = "00000000-0000-4000-8300-000000000c01";
/** Услуги кортежа: на витрине (с предложением правки цены) и новая — на проверке */
export const BRIDE_CAR_ID = "00000000-0000-4000-8b00-000000000001";
export const LIMOUSINE_ID = "00000000-0000-4000-8b00-000000000002";
/** Услуга, которую партнёр отправил на проверку у черновика тортов (draftService) */
export const BENTO_ID = "00000000-0000-4000-8b00-000000000003";
const CHAMPAGNE_ID = "00000000-0000-4000-8c00-000000000001";
/** Фото витрины «Kadr studio»: два ждут решения, третье отклонено с причиной */
export const PHOTO_PENDING_ID = "00000000-0000-4000-8d00-000000000001";
export const PHOTO_PENDING_2_ID = "00000000-0000-4000-8d00-000000000002";
export const PHOTO_DECLINED_ID = "00000000-0000-4000-8d00-000000000003";
/** Причина отказа длинная и в одно слово подряд: в двух колонках на 320px текст переносится, а не растягивает страницу */
export const PHOTO_DECLINE_REASON =
  "Размыто — нужен кадр при дневном свете, без людей на заднем плане и без https://example.com/очень-длинная-ссылка-на-исходник";
/** День с договорённостью на вечер у кортежа (одна из двух машин занята) */
export const BOOKED_DAY = "2026-10-10";

let serial = 0;
const nextId = (block: string) =>
  `00000000-0000-4000-${block}-${(0xd00000000000 + ++serial).toString(16).padStart(12, "0")}`;

function category(code: string): CategoryConfig {
  const found = categoryConfig(code);
  if (!found) throw new Error(`нет категории ${code}`);
  return found;
}

/** Контакты кортежа, которые панель показывает по «Показать» (остальные витрины — свои, из PATCH) */
export const CAR_CONTACTS = { phone: "+998901112233", telegram: "oq_kortej" } as const;

/**
 * Telegram витрины, как его понимает сервер (apps/api/src/staff/input.ts): «@имя», «имя» или ссылка
 * t.me/имя → имя без @ (5–32 знака, латиница, цифры и «_», с буквы, не на «_»); иначе null
 */
export { normalizeTelegram } from "@bayramm/shared";

const BASE_REVIEW: readonly PublishBlocker[] = ["price", "descriptions", "phone", "photos"];
const CHECKLIST: readonly PublishBlocker[] = ["contract", "stir", "contacts", "pd_consent"];

/** Чего не хватает — по категории: поля витрины, обязательные услуги, цена */
export function blockersOf(listing: ListingDetail): ListingDetail["blockers"] {
  const config = category(listing.categoryCode);
  const review: PublishBlocker[] = BASE_REVIEW.filter(
    (code) =>
      code !== "price" || !listing.services.some((s) => s.status === "active" || s.status === "review"),
  );
  if (config.listingFields.includes("guest_capacity") && listing.capMax === null) review.push("capacity");
  if (config.listingFields.includes("district") && listing.districtCode === null) review.push("district");
  const types = new Set(listing.services.map((s) => s.type));
  if (config.requiredServices.some((code) => !types.has(code))) review.push("packages");
  if (listing.missingAttributes.length > 0) review.push("attributes");
  return { review, active: [...review, ...CHECKLIST] };
}

/** Витрина после правки: недостающие поля и блокеры — как посчитал бы сервер */
export function refresh(listing: ListingDetail): ListingDetail {
  const config = category(listing.categoryCode);
  const withMissing = { ...listing, missingAttributes: missingAttributes(config, listing.attributes) };
  const active = listing.services.filter((s) => s.status === "active" || s.status === "review");
  const cheapest = active.reduce<ListingService | null>(
    (min, s) => (min === null || s.priceUzs < min.priceUzs ? s : min),
    null,
  );
  return {
    ...withMissing,
    priceFromUzs: cheapest?.priceUzs ?? null,
    priceUnit: cheapest?.priceUnit ?? listing.priceUnit,
    blockers: blockersOf(withMissing),
    // Заявки знает подмена API (staff-api.ts); здесь — только статус
    deleteBlocker:
      listing.deleteBlocker === "requests"
        ? "requests"
        : listing.status === "review" || listing.status === "active"
          ? "published"
          : null,
  };
}

export function emptyListing(id: string, categoryCode: string, name: string, slug: string): ListingDetail {
  return refresh({
    id,
    slug,
    categoryCode,
    status: "draft",
    statusReason: null,
    statusChangedAt: iso,
    name,
    districtCode: null,
    addressRu: null,
    addressUz: null,
    descriptionRu: null,
    descriptionUz: null,
    priceFromUzs: null,
    priceUnit: category(categoryCode).services[0]?.units[0] ?? "per_event",
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
    blockers: { review: [], active: [] },
    vendor: VENDOR_REF,
    history: [{ from: null, to: "draft", reason: null, actorKind: "staff", actorName: null, at: iso }],
    pendingRevision: null,
    deleteBlocker: null,
  });
}

function service(
  id: string,
  categoryCode: string,
  type: string,
  fields: Partial<ListingService> & Pick<ListingService, "priceUzs" | "priceUnit" | "status">,
): ListingService {
  const config = category(categoryCode);
  const found = serviceType(config, type);
  return {
    id,
    type,
    name: found ? categoryTexts(found.label) : { ru: type, uz: type },
    customName: false,
    minQty: null,
    leadDays: null,
    includes: null,
    options: [],
    sort: 0,
    proposal: null,
    decision: null,
    submittedAt: iso,
    updatedAt: iso,
    ...fields,
  };
}

/** Фото витрины для подмены API: файл не грузится (картинок в тесте нет), решение — по полям */
function stubPhoto(
  listingId: string,
  id: string,
  sort: number,
  moderation: StaffPhoto["moderation"],
  declineReason: string | null = null,
): StaffPhoto {
  return {
    id,
    key: `listings/${listingId}/${id}.webp`,
    width: 1600,
    height: 1200,
    bytes: 120_000,
    sort,
    isCover: sort === 0,
    moderation,
    declineReason,
    createdAt: iso,
  };
}

/**
 * Витрины вендора в категориях, кроме зала: кортеж (опубликован), фото и видео, торты.
 * draftService — у черновика тортов ещё и услуга, которую партнёр отправил на проверку
 */
export function seededListings({ draftService = false } = {}): ListingDetail[] {
  const car = emptyListing(CAR_LISTING_ID, "car", "Oq kortej", "oq-kortej");
  const photo = emptyListing(PHOTO_LISTING_ID, "photo", "Kadr studio", "kadr-studio");
  const cake = emptyListing(CAKE_LISTING_ID, "cake", "Shirin", "shirin");
  return [
    refresh({
      ...car,
      status: "active",
      publishedAt: iso,
      descriptionRu: "Кортеж",
      descriptionUz: "Kortej",
      hasPhone: true,
      hasTelegram: true,
      parallelCapacity: 2,
      attributes: {
        fleet: [{ model: "Chevrolet Malibu", class: "sedan", color: "white", seats: 4 }],
        service_area: "tashkent",
      },
      services: [
        service(BRIDE_CAR_ID, "car", "bride_car", {
          status: "active",
          priceUzs: 300_000,
          priceUnit: "per_hour",
          minQty: 3,
          options: [
            {
              id: CHAMPAGNE_ID,
              code: "champagne",
              name: { ru: "Шампанское и вода", uz: "Shampan va suv" },
              priceUzs: 50_000,
              priceUnit: "per_item",
            },
          ],
          proposal: { changes: { priceUzs: 350_000 }, submittedAt: iso },
        }),
        service(LIMOUSINE_ID, "car", "limousine", {
          status: "review",
          priceUzs: 900_000,
          priceUnit: "per_hour",
          sort: 1,
        }),
      ],
    }),
    refresh({
      ...photo,
      photos: [
        stubPhoto(PHOTO_LISTING_ID, PHOTO_PENDING_ID, 0, "pending"),
        stubPhoto(PHOTO_LISTING_ID, PHOTO_PENDING_2_ID, 1, "pending"),
        stubPhoto(PHOTO_LISTING_ID, PHOTO_DECLINED_ID, 2, "declined", PHOTO_DECLINE_REASON),
      ],
    }),
    refresh({
      ...cake,
      attributes: { cake_kinds: ["wedding"], lead_days: 3 },
      services: [
        service(nextId("8b00"), "cake", "wedding_cake", {
          status: "draft",
          priceUzs: 120_000,
          priceUnit: "per_kg",
          minQty: 3,
          leadDays: 5,
        }),
        ...(draftService
          ? [
              service(BENTO_ID, "cake", "bento", {
                status: "review",
                priceUzs: 45_000,
                priceUnit: "per_item",
                sort: 1,
              }),
            ]
          : []),
      ],
    }),
  ];
}

/** Заявка на кортеж: вечер, две машины, выбранная услуга с добавкой — как была при подаче */
export function carRequest(base: StaffRequestDetail): StaffRequestDetail {
  return {
    ...base,
    id: CAR_REQUEST_ID,
    publicNo: 1052,
    sla: "waiting",
    guests: null,
    dayPart: "evening",
    eventDate: BOOKED_DAY,
    listing: { id: CAR_LISTING_ID, name: "Oq kortej", categoryCode: "car" },
    details: {
      start_time: "18:30",
      hours: 4,
      cars_count: 2,
      car_class: "premium",
      services: [
        {
          id: BRIDE_CAR_ID,
          type: "bride_car",
          name: { ru: "Машина для молодожёнов", uz: "Kelin-kuyov mashinasi" },
          priceUzs: 300_000,
          priceUnit: "per_hour",
          qty: 4,
          options: [
            {
              id: CHAMPAGNE_ID,
              name: { ru: "Шампанское и вода", uz: "Shampan va suv" },
              priceUzs: 50_000,
              priceUnit: "per_item",
            },
          ],
        },
      ],
    },
  };
}

// ── правки витрины ──────────────────────────────────────────────────────────

type Body = Readonly<Record<string, unknown>>;

/** Данные витрины, видео, заказы одновременно из PATCH: ошибки — как у сервера */
export function patchCategoryFields(
  listing: ListingDetail,
  input: Body,
):
  | { readonly ok: true; readonly listing: ListingDetail }
  | { readonly ok: false; readonly errors: string[] } {
  const config = category(listing.categoryCode);
  const errors: string[] = [];
  let next = listing;
  if (input.attributes !== undefined) {
    const parsed = validateAttributePatch(config, input.attributes);
    if (parsed.ok) next = { ...next, attributes: mergeAttributes(next.attributes, parsed.value) };
    else errors.push(...parsed.errors);
  }
  if (input.videoLinks !== undefined) {
    const parsed = validateVideoLinks(config, input.videoLinks);
    if (parsed.ok) next = { ...next, videoLinks: parsed.value };
    else errors.push(...parsed.errors);
  }
  if (input.parallelCapacity !== undefined) {
    const n = input.parallelCapacity;
    if (typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 50)
      next = { ...next, parallelCapacity: n };
    else errors.push("parallelCapacity");
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, listing: next };
}

// ── услуги ──────────────────────────────────────────────────────────────────

const optionsOf = (options: readonly ServiceOptionValue[] | undefined): ListingService["options"] =>
  (options ?? []).map((o) => ({
    id: o.id ?? nextId("8c00"),
    code: o.code ?? null,
    name: o.name,
    priceUzs: o.priceUzs,
    priceUnit: o.priceUnit,
  }));

const withoutSubmit = (body: Body) =>
  Object.fromEntries(Object.entries(body).filter(([k]) => k !== "submit"));

/** Новая услуга: модератор и администратор — сразу на витрину, менеджер — на проверку */
export function createService(
  listing: ListingDetail,
  body: Body,
  role: StaffRole,
):
  | { readonly ok: true; readonly service: ListingService }
  | { readonly ok: false; readonly errors: string[] } {
  const config = category(listing.categoryCode);
  const parsed = validateServiceInput(config, withoutSubmit(body), { create: true });
  if (!parsed.ok) return parsed;
  const v = parsed.value;
  const type = serviceType(config, v.type ?? "");
  const status = body.submit === false ? "draft" : role === "manager" ? "review" : "active";
  return {
    ok: true,
    service: {
      id: nextId("8b00"),
      type: v.type ?? "",
      status,
      name: v.name ?? (type ? categoryTexts(type.label) : { ru: "", uz: "" }),
      customName: v.name !== undefined && v.name !== null,
      priceUzs: v.priceUzs ?? 0,
      priceUnit: v.priceUnit ?? "per_event",
      minQty: v.minQty ?? null,
      leadDays: v.leadDays ?? null,
      includes: v.includes ?? null,
      options: optionsOf(v.options),
      sort: listing.services.length,
      proposal: null,
      decision: null,
      submittedAt: iso,
      updatedAt: iso,
    },
  };
}

/** Правка: у опубликованной витрины менеджер правит активную услугу предложением */
export function updateService(
  listing: ListingDetail,
  current: ListingService,
  body: Body,
  role: StaffRole,
):
  | { readonly ok: true; readonly service: ListingService }
  | { readonly ok: false; readonly errors: string[] } {
  const config = category(listing.categoryCode);
  const parsed = validateServiceInput(config, withoutSubmit(body), { create: false, typeCode: current.type });
  if (!parsed.ok) return parsed;
  const v = parsed.value;
  const changes = {
    ...(v.name ? { name: v.name } : {}),
    ...(v.priceUzs !== undefined ? { priceUzs: v.priceUzs } : {}),
    ...(v.priceUnit !== undefined ? { priceUnit: v.priceUnit } : {}),
    ...(v.minQty !== undefined ? { minQty: v.minQty } : {}),
    ...(v.leadDays !== undefined ? { leadDays: v.leadDays } : {}),
    ...(v.includes !== undefined ? { includes: v.includes } : {}),
    ...(v.options !== undefined ? { options: optionsOf(v.options) } : {}),
  };
  if (role === "manager" && listing.status === "active" && current.status === "active") {
    return { ok: true, service: { ...current, proposal: { changes, submittedAt: iso } } };
  }
  return { ok: true, service: { ...current, ...changes, updatedAt: iso } };
}

/**
 * Очередь модерации услуг: новые и предложения правок у любых витрин, кроме отклонённых (у
 * черновика тоже — как staff/services.ts)
 */
export function serviceQueue(listings: readonly ListingDetail[]): ServiceQueue {
  const items: ServiceQueueItem[] = [];
  for (const listing of listings) {
    if (listing.status === "rejected") continue;
    for (const s of listing.services) {
      if (s.status !== "review" && s.proposal === null) continue;
      items.push({
        kind: s.proposal ? "proposal" : "review",
        service: s,
        listing: {
          id: listing.id,
          name: listing.name,
          status: listing.status,
          categoryCode: listing.categoryCode,
        },
        vendor: VENDOR_REF,
        proposedBy: { kind: "partner", name: null },
        submittedAt: s.proposal?.submittedAt ?? s.submittedAt ?? iso,
      });
    }
  }
  return { total: items.length, items };
}

/** Решение по услуге или её предложению */
export function decide(
  current: ListingService,
  outcome: "approved" | "declined",
  reason: string | null,
): ListingService {
  const decision = { outcome, reason, at: iso } as const;
  if (current.proposal) {
    return outcome === "approved"
      ? { ...current, ...current.proposal.changes, proposal: null, decision }
      : { ...current, proposal: null, decision };
  }
  return { ...current, status: outcome === "approved" ? "active" : "rejected", decision };
}

// ── занятость ───────────────────────────────────────────────────────────────

export interface Calendar {
  readonly busy: Map<string, BusyDay>;
  readonly parts: Map<string, BusyPart>;
  readonly bookings: readonly PartBookings[];
  version: number;
}

export function newCalendar(listingId: string): Calendar {
  return {
    busy: new Map(),
    parts: new Map(),
    // У кортежа — одна договорённость на вечер: занята одна из двух машин
    bookings: listingId === CAR_LISTING_ID ? [{ day: BOOKED_DAY, part: "evening", count: 1 }] : [],
    version: 0,
  };
}

const partKey = (ref: DayPartRef) => `${ref.day}:${ref.part}`;

export function availabilityOf(
  listing: ListingDetail,
  cal: Calendar,
  from: string,
  to: string,
): Availability {
  const config = category(listing.categoryCode);
  const inRange = (item: { day: string }) => item.day >= from && item.day <= to;
  return {
    from,
    to,
    mode: config.availability,
    parallelCapacity: listing.parallelCapacity,
    busy: [...cal.busy.values()].filter(inRange),
    parts: [...cal.parts.values()].filter(inRange),
    bookings: cal.bookings.filter(inRange),
    version: cal.version,
  };
}

/** Правка занятости: дни целиком и части дня (только у режима parts) */
export function applyAvailability(
  listing: ListingDetail,
  cal: Calendar,
  input: AvailabilityInput,
):
  | { readonly ok: true; readonly days: string[] }
  | { readonly ok: false; readonly code: string; readonly details?: string[] } {
  if (input.version !== cal.version) return { ok: false, code: "calendar_conflict" };
  const parts = [...(input.busyParts ?? []), ...(input.freeParts ?? [])];
  if (parts.length > 0 && category(listing.categoryCode).availability !== "parts")
    return { ok: false, code: "invalid_input", details: ["busyParts"] };
  for (const day of input.busy ?? []) cal.busy.set(day, { day, source: "staff" });
  for (const day of input.free ?? []) cal.busy.delete(day);
  for (const ref of input.busyParts ?? []) cal.parts.set(partKey(ref), { ...ref, source: "staff" });
  for (const ref of input.freeParts ?? []) cal.parts.delete(partKey(ref));
  cal.version++;
  return {
    ok: true,
    days: [...(input.busy ?? []), ...(input.free ?? []), ...parts.map((p) => p.day)].sort(),
  };
}

export { readAttributes };
