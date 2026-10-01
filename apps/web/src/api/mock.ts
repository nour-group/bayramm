import { normalizeUzPhone } from "@bayramm/shared";
import {
  type CatalogCategories,
  type CatalogPage,
  type CatalogQuery,
  type ClientConsentPurpose,
  type ClientRequest,
  type ConsentText,
  type CreateRequest,
  comparablePriceUzs,
  type DateLoad,
  type DayPart,
  type Dictionaries,
  FAVORITES_MAX,
  type ListingCard,
  type ListingDetail,
  type Locale,
  type RequestDetails,
  type RequestStatus,
} from "@bayramm/shared/api";
import type { AccountIdentity, AppCode, VendorMembership } from "@bayramm/shared/api/account";
import type { ClientDataExport, ClientMe, Favorites, Me } from "@bayramm/shared/api/me";
import {
  type AttributeFilter,
  CATEGORIES,
  type ChosenServiceSnapshot,
  categoryConfig,
  categoryTexts,
  dayPartOf,
  guestsAllowed,
  hasDayParts,
  parseAttributeFilters,
  validateRequestDetails,
} from "@bayramm/shared/categories";
import { addDays, tashkentToday } from "../format";
import { demoUuid, demoVitrinas } from "./demo-vitrinas";
import { ApiError } from "./errors";
import type { ClientApi, PhoneProof } from "./types";

/* Демо-реализация API в памяти: для тестов и для `pnpm dev:web` без сервера.
   Ведёт себя по контракту @bayramm/shared/api: выдача по категории (без неё — залы),
   фильтры по полям витрины (a.*), загрузка на дату (свободно, занята часть дня, занято),
   занятые — в конце выдачи при любом порядке, гости отсекают по вместимости, курсор, 404,
   заявка проверяется по форме категории (поля, услуги, срок заказа), 409 на повторную.
   Площадки вымышленные, телефоны в несуществующем коде +998 00 — живых людей тут нет.
   В сборку для staging и production не попадает (api/index.ts, проверка в тесте). */

export const DEMO_DICTIONARIES: Dictionaries = {
  categories: CATEGORIES.filter((c) => c.enabled).map((c) => ({
    code: c.code,
    name: categoryTexts(c.label),
  })),
  districts: [
    { code: "yunusobod", name: { ru: "Юнусабад", uz: "Yunusobod" } },
    { code: "mirzo_ulugbek", name: { ru: "Мирзо-Улугбек", uz: "Mirzo Ulugʻbek" } },
    { code: "chilonzor", name: { ru: "Чиланзар", uz: "Chilonzor" } },
    { code: "yakkasaroy", name: { ru: "Яккасарай", uz: "Yakkasaroy" } },
    { code: "shayxontohur", name: { ru: "Шайхантахур", uz: "Shayxontohur" } },
    { code: "mirobod", name: { ru: "Мирабад", uz: "Mirobod" } },
    { code: "sergeli", name: { ru: "Сергели", uz: "Sergeli" } },
    { code: "uchtepa", name: { ru: "Учтепа", uz: "Uchtepa" } },
    { code: "olmazor", name: { ru: "Алмазар", uz: "Olmazor" } },
    { code: "yashnobod", name: { ru: "Яшнабад", uz: "Yashnobod" } },
    { code: "bektemir", name: { ru: "Бектемир", uz: "Bektemir" } },
    { code: "yangihayot", name: { ru: "Янгихаят", uz: "Yangihayot" } },
  ],
  occasions: [
    { code: "toy", name: { ru: "Свадьба", uz: "Toʻy" } },
    { code: "beshik", name: { ru: "Бешик-той", uz: "Beshik toʻyi" } },
    { code: "bd", name: { ru: "День рождения", uz: "Tugʻilgan kun" } },
    { code: "corp", name: { ru: "Корпоратив", uz: "Korporativ" } },
    { code: "small", name: { ru: "Частное", uz: "Yopiq davra" } },
  ],
};

const NAMES = [
  "Lola",
  "Anor",
  "Bahor",
  "Yulduz",
  "Shams",
  "Nilufar",
  "Oydin",
  "Sadaf",
  "Marvarid",
  "Durdona",
  "Kamalak",
  "Zumrad",
  "Ipak",
  "Chinor",
  "Gulzor",
  "Osmon",
  "Tong",
  "Nur",
  "Bogʻ",
  "Sarv",
  "Olmos",
  "Dilbar",
  "Qamar",
  "Sayyora",
];

const SLUGS = NAMES.map((name) => `${name.toLowerCase().replace(/[^a-z]/g, "")}-zali`);

const CAPACITY = [120, 200, 250, 300, 350, 400, 500, 600, 800, 1000];

/** UUID из числа: у каждого демо-листинга и фото свой, формат как у Postgres */
const uuid = demoUuid;

/** Демо-залы; занятые даты считаются от today, чтобы календарь всегда был живой */
export function demoListings(today: string): ListingDetail[] {
  return NAMES.map((name, i) => {
    const id = uuid(1, i + 1);
    const capMax = CAPACITY[i % CAPACITY.length] ?? 300;
    const perGuest = i % 3 === 0;
    const priceFromUzs = perGuest ? 150_000 + (i % 5) * 35_000 : 25_000_000 + ((i * 7) % 12) * 5_000_000;
    const weekend = Math.round((priceFromUzs * 1.2) / 10_000) * 10_000;
    const photos = Array.from({ length: 3 + (i % 3) }, (_, k) => ({
      key: `listings/${id}/${uuid(2, i * 10 + k + 1)}.webp`,
      width: 1600,
      height: 1067,
    }));
    const district = DEMO_DICTIONARIES.districts[i % DEMO_DICTIONARIES.districts.length];
    const busyDates = [
      ...(i % 3 === 0 ? [addDays(today, 7)] : []),
      ...Array.from({ length: 8 }, (_, k) => addDays(today, ((i * 5 + k * 13) % 150) + 2)),
    ];
    return {
      id,
      slug: SLUGS[i] ?? `zal-${i + 1}`,
      name: `${name} zali`,
      categoryCode: "hall",
      districtCode: district?.code ?? null,
      priceFromUzs,
      priceUnit: perGuest ? "per_guest" : "per_event",
      capMin: Math.max(50, Math.round(capMax / 40) * 10),
      capMax,
      cover: photos[0] ?? null,
      photoCount: photos.length,
      busyOnDate: null,
      dateLoad: null,
      description: {
        ru: `Демо-площадка для разработки: зал на ${capMax} гостей, своя кухня и парковка.\nНастоящие описания приходят из API.`,
        uz: `Ishlab chiqish uchun demo maydon: ${capMax} mehmonga zal, oshxona va avtoturargoh bor.\nHaqiqiy tavsiflar API dan keladi.`,
      },
      address: {
        ru: `Ташкент, ${district?.name.ru ?? ""}, демо-адрес ${i + 1}`,
        uz: `Toshkent, ${district?.name.uz ?? ""}, demo manzil ${i + 1}`,
      },
      attributes: {},
      videoLinks: [],
      services: (["banquet_weekday", "banquet_weekend"] as const).map((type, k) => ({
        id: uuid(5, i * 10 + k + 1),
        type,
        name:
          k === 0
            ? { ru: "Банкет в будни", uz: "Ish kunlari banketi" }
            : { ru: "Банкет в выходные", uz: "Dam olish kunlari banketi" },
        priceUzs: k === 0 ? priceFromUzs : weekend,
        priceUnit: perGuest ? "per_guest" : "per_event",
        minQty: null,
        leadDays: null,
        includes: null,
        options: [],
      })),
      parallelCapacity: 1,
      photos,
      phone: `+998000000${String(i + 1).padStart(3, "0")}`,
      busyDates: [...new Set(busyDates)].sort(),
      busyParts: [],
    } satisfies ListingDetail;
  });
}

/** Все демо-витрины: залы и остальные категории (api/demo-vitrinas.ts) */
export function allDemoListings(today: string): ListingDetail[] {
  return [...demoListings(today), ...demoVitrinas(today)];
}

const PURPOSES: readonly ClientConsentPurpose[] = ["client_service", "request_transfer", "bot_notifications"];

const CONSENT_BODY: Readonly<Record<Locale, Record<ClientConsentPurpose, string>>> = {
  ru: {
    client_service: "Демо-текст согласия на обслуживание.\nНастоящий текст приходит из API.",
    request_transfer:
      "Демо-текст согласия на передачу заявки исполнителю: имя, телефон, дата, гости, бюджет и комментарий.\nНастоящий текст приходит из API.",
    bot_notifications:
      "Демо-текст согласия на уведомления в Telegram-боте.\nНастоящий текст приходит из API.",
  },
  uz: {
    client_service: "Xizmat koʻrsatishga rozilikning demo matni.\nHaqiqiy matn API dan keladi.",
    request_transfer:
      "Soʻrovni hamkorga berishga rozilikning demo matni: ism, telefon, sana, mehmonlar, byudjet va izoh.\nHaqiqiy matn API dan keladi.",
    bot_notifications:
      "Telegram-botdagi bildirishnomalarga rozilikning demo matni.\nHaqiqiy matn API dan keladi.",
  },
};

export function demoConsentTexts(locale: Locale): ConsentText[] {
  return PURPOSES.map((purpose) => ({
    id: `demo-${purpose}-${locale}`,
    purpose,
    version: 1,
    locale,
    body: CONSENT_BODY[locale][purpose],
  }));
}

const ACTIVE: readonly RequestStatus[] = ["new", "viewed", "contacted"];
const HOUR = 60 * 60 * 1000;

/** Снимок выбранной услуги витрины — как его сохраняет сервер в заявке */
function snapshot(
  listing: ListingDetail,
  serviceId: string,
  qty: number | null,
  optionIds: readonly string[],
): ChosenServiceSnapshot | null {
  const service = listing.services.find((s) => s.id === serviceId);
  if (!service) return null;
  return {
    id: service.id,
    type: service.type,
    name: service.name,
    priceUzs: service.priceUzs,
    priceUnit: service.priceUnit,
    qty,
    options: service.options
      .filter((o) => optionIds.includes(o.id))
      .map((o) => ({ id: o.id, name: o.name, priceUzs: o.priceUzs, priceUnit: o.priceUnit })),
  };
}

/**
 * Заявки для показа статусов в `pnpm dev:web`: ждём, просрочено, ответили, отказ — у первых
 * залов; если среди витрин есть кортеж и торт — ещё по заявке с полями категории
 */
export function demoRequests(listings: readonly ListingDetail[], now: number): ClientRequest[] {
  const today = tashkentToday(now);
  const at = (hoursAgo: number) => new Date(now - hoursAgo * HOUR).toISOString();
  const halls = listings.filter((l) => l.categoryCode === "hall");
  const seeds: [number, RequestStatus, number, number | null, ClientRequest["declineReason"]][] = [
    [0, "new", 3, null, null],
    [1, "viewed", 14, null, null],
    [2, "contacted", 26, 2.25, null],
    [3, "declined", 50, 5, "busy"],
  ];
  const base = (
    listing: ListingDetail,
    n: number,
    status: RequestStatus,
    hoursAgo: number,
    answeredAfter: number | null,
  ) => {
    const createdAt = now - hoursAgo * HOUR;
    return {
      id: uuid(3, n + 1),
      publicNo: 1040 + n,
      status,
      declineReason: null,
      eventDate: addDays(today, 30 + n * 9),
      occasionCode: "toy",
      createdAt: at(hoursAgo),
      slaDueAt: new Date(createdAt + 12 * HOUR).toISOString(),
      firstResponseAt:
        answeredAfter === null ? null : new Date(createdAt + answeredAfter * HOUR).toISOString(),
      slaBreached: answeredAfter === null && hoursAgo > 12,
      listing: pickListing(listing),
    };
  };
  const out: ClientRequest[] = seeds.flatMap(([index, status, hoursAgo, answeredAfter, declineReason], n) => {
    const listing = halls[index];
    if (!listing) return [];
    return [
      {
        ...base(listing, n, status, hoursAgo, answeredAfter),
        declineReason,
        guests: Math.min(200, listing.capMax ?? 200),
        dayPart: null,
        details: {},
      },
    ];
  });
  const car = listings.find((l) => l.categoryCode === "car");
  const carService = car?.services[0];
  const carChoice =
    car && carService ? snapshot(car, carService.id, 5, [carService.options[0]?.id ?? ""]) : null;
  if (car && carChoice)
    out.push({
      ...base(car, 4, "new", 1, null),
      guests: null,
      dayPart: "evening",
      details: { start_time: "17:30", hours: 5, cars_count: 2, car_class: "premium", services: [carChoice] },
    });
  const cake = listings.find((l) => l.categoryCode === "cake");
  const cakeService = cake?.services[0];
  const cakeChoice = cake && cakeService ? snapshot(cake, cakeService.id, 6, []) : null;
  if (cake && cakeChoice)
    out.push({
      ...base(cake, 5, "contacted", 30, 3),
      guests: 150,
      dayPart: null,
      details: { weight_kg: 6, tiers: 3, filling: "berry", fulfillment: "delivery", services: [cakeChoice] },
    });
  return out;
}

function pickListing(listing: ListingDetail): ClientRequest["listing"] {
  return {
    id: listing.id,
    slug: listing.slug,
    name: listing.name,
    categoryCode: listing.categoryCode,
    cover: listing.cover,
    districtCode: listing.districtCode,
  };
}

/**
 * Загрузка витрины на дату — как app.listing_day_load: занята целиком (вендор отметил день или
 * заняты все части дня) — busy, занята часть дня — partial; без календаря (срок заказа) — free
 */
export function demoDayLoad(listing: ListingDetail, date: string): DateLoad {
  if (categoryConfig(listing.categoryCode)?.availability === "lead") return "free";
  if (listing.busyDates.includes(date)) return "busy";
  const parts = listing.busyParts.find((p) => p.date === date)?.parts ?? [];
  if (parts.length >= 3) return "busy";
  return parts.length > 0 ? "partial" : "free";
}

function toCard(listing: ListingDetail, date: string | undefined): ListingCard {
  const load = date ? demoDayLoad(listing, date) : null;
  return {
    id: listing.id,
    slug: listing.slug,
    name: listing.name,
    categoryCode: listing.categoryCode,
    districtCode: listing.districtCode,
    priceFromUzs: listing.priceFromUzs,
    priceUnit: listing.priceUnit,
    capMin: listing.capMin,
    capMax: listing.capMax,
    cover: listing.cover,
    photoCount: listing.photoCount,
    busyOnDate: load === null ? null : load === "busy",
    dateLoad: load,
  };
}

/** Фильтр по полю витрины — как SQL каталога (apps/api/src/catalog/service.ts, attributeFilter) */
export function matchesAttributeFilter(
  attributes: ListingDetail["attributes"],
  filter: AttributeFilter,
): boolean {
  const [key = "", sub] = filter.path;
  const raw: unknown = attributes[key];
  // Значения поля: у списка (автопарк) — поле каждой записи, «есть запись, где…»
  const values: unknown[] =
    sub === undefined
      ? [raw]
      : Array.isArray(raw)
        ? raw.map((item: unknown) =>
            typeof item === "object" && item !== null ? (item as Record<string, unknown>)[sub] : undefined,
          )
        : [];
  const test = (value: unknown): boolean => {
    switch (filter.kind) {
      case "eq":
        return value === true;
      case "any":
        return Array.isArray(value)
          ? filter.values.some((v) => value.includes(v))
          : filter.values.includes(value as string);
      case "all":
        return Array.isArray(value) ? filter.values.every((v) => value.includes(v)) : false;
      case "min":
        return typeof value === "number" && value >= filter.value;
      case "max":
        return typeof value === "number" && value <= filter.value;
    }
  };
  // Список и «все из»: каждое значение — в какой-нибудь записи (как and из path у сервера)
  if (sub !== undefined && filter.kind === "all") return filter.values.every((v) => values.includes(v));
  return values.some(test);
}

const invalid = (details: readonly string[]) =>
  new ApiError(400, "invalid_request", undefined, undefined, [...new Set(details)]);

/**
 * Поля заявки по форме категории витрины — как apps/api/src/requests/details.ts: гости по
 * правилу формы и вместимости, поля категории, услуги только этой витрины, срок заказа,
 * часть дня из времени начала
 */
function checkDetails(
  listing: ListingDetail,
  body: CreateRequest,
  today: string,
): { details: RequestDetails; dayPart: DayPart | null } {
  const category = categoryConfig(listing.categoryCode);
  if (!category) throw invalid(["listingId"]);
  const guests = body.guests ?? null;
  const bad: string[] = [];
  if (!guestsAllowed(category, guests)) bad.push("guests");
  const parsed = validateRequestDetails(category, body.details);
  if (!parsed.ok) bad.push(...parsed.errors);
  if (bad.length > 0 || !parsed.ok) throw invalid(bad);
  if (guests !== null && listing.capMax !== null && guests > listing.capMax)
    throw new ApiError(422, "guests_over_capacity");
  const { values, services: choices } = parsed.value;
  const lead = listing.attributes.lead_days;
  let leadDays = typeof lead === "number" ? lead : 0;
  const snapshots: ChosenServiceSnapshot[] = [];
  choices.forEach((choice, index) => {
    const at = `details.services.${index}`;
    const service = listing.services.find((s) => s.id === choice.id);
    if (!service) {
      bad.push(`${at}.id`);
      return;
    }
    if (choice.qty !== null && service.minQty !== null && choice.qty < service.minQty) bad.push(`${at}.qty`);
    if (!choice.options.every((id) => service.options.some((o) => o.id === id))) {
      bad.push(`${at}.options`);
      return;
    }
    leadDays = Math.max(leadDays, service.leadDays ?? 0);
    const shot = snapshot(listing, choice.id, choice.qty, choice.options);
    if (shot) snapshots.push(shot);
  });
  if (bad.length > 0) throw invalid(bad);
  if (leadDays > 0 && body.eventDate < addDays(today, leadDays))
    throw new ApiError(422, "lead_time_too_short", undefined, undefined, ["eventDate"]);
  const details: Record<string, RequestDetails[string]> = { ...values };
  const servicesField = category.requestForm.fields.find((f) => f.type === "services");
  if (servicesField && snapshots.length > 0) details[servicesField.key] = snapshots;
  const start = values.start_time;
  return {
    details,
    dayPart: hasDayParts(category) && typeof start === "string" ? dayPartOf(category, start) : null,
  };
}

function abortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

export interface MockOptions {
  /** Задержка ответа, мс: в разработке видно состояния загрузки; в тестах 0 */
  readonly latencyMs?: number;
  readonly now?: () => number;
  readonly listings?: readonly ListingDetail[];
  readonly requests?: readonly ClientRequest[];
  readonly botUsername?: string;
  /** Ответ на любой вызов — эта ошибка (проверка экранов ошибок) */
  readonly failWith?: (method: keyof ClientApi) => ApiError | null;
  /** Профиль демо-клиента: язык и уведомления */
  readonly me?: Partial<ClientMe>;
  /** Роли демо-аккаунта кроме клиента: членства в вендорах, роль сотрудника */
  readonly roles?: { readonly vendors?: readonly VendorMembership[]; readonly staff?: Me["roles"]["staff"] };
  /** Адреса приложений (GET /auth/methods): хаб ведёт туда по коду */
  readonly apps?: Readonly<Record<AppCode, string>>;
  /** Вход по коду из сообщения включён (по умолчанию да; код — DEMO_OTP_CODE) */
  readonly phone?: boolean;
  /** Домен виджета входа Telegram; по умолчанию — нет (виджет в демо не работает) */
  readonly loginDomain?: string | null;
  /**
   * Проверка «не робот» (Turnstile) у кода на телефон: ключ виджета. Тогда код без токена
   * или initData — 400 turnstile_required, как у настоящего API
   */
  readonly turnstileSiteKey?: string | null;
  /** Избранное демо-аккаунта (id площадок, последние отмеченные — первыми) */
  readonly favorites?: readonly string[];
  /** Площадки «сняты с публикации»: в выдаче, карточках и избранном их нет, карточка — 404 */
  readonly hidden?: readonly string[];
}

/** Код из сообщения в демо: сообщений нет, код всегда этот */
export const DEMO_OTP_CODE = "123456";

/** Адреса приложений в разработке: те же порты, что у pnpm dev:vendor и dev:admin */
export const DEMO_APPS: Readonly<Record<AppCode, string>> = {
  web: "http://localhost:5173",
  vendor: "http://localhost:5174",
  admin: "http://localhost:5175",
};

export interface MockApi extends ClientApi {
  /** Тела всех принятых POST /requests — для проверок в тестах */
  readonly created: CreateRequest[];
  readonly requests: ClientRequest[];
  /** Профиль демо-клиента сейчас (после PATCH /me, отзыва, удаления) */
  readonly profile: () => ClientMe;
  /** Аккаунт удалён (DELETE /me) */
  readonly deleted: () => boolean;
  /** Выданные коды хаба: приложение, state и challenge — для проверок в тестах */
  readonly hubCodes: { readonly app: string; readonly state: string; readonly codeChallenge: string }[];
  /** Номера, на которые «отправлен» код */
  readonly codesSent: string[];
  /** Чем каждый запрос кода доказал, что его шлёт человек */
  readonly phoneProofs: PhoneProof[];
  /** Избранное аккаунта сейчас */
  readonly favoriteIds: () => readonly string[];
}

const DEMO_CREATED = "2026-09-01T09:00:00.000Z";

const DEMO_ME: ClientMe = {
  id: "00000000-0000-4000-8500-000000000001",
  locale: "uz",
  firstName: "Demo",
  lastName: null,
  username: null,
  canMessage: true,
  notifications: true,
};

export function createMockApi(options: MockOptions = {}): MockApi {
  const now = options.now ?? Date.now;
  const hidden = new Set(options.hidden ?? []);
  const listings = (options.listings ?? allDemoListings(tashkentToday(now()))).filter(
    (l) => !hidden.has(l.id),
  );
  const requests: ClientRequest[] = [...(options.requests ?? [])];
  const created: CreateRequest[] = [];
  const latency = options.latencyMs ?? 0;
  let me: ClientMe = { ...DEMO_ME, ...options.me };
  let deleted = false;
  let identities: AccountIdentity[] = [
    { kind: "telegram", verifiedAt: new Date(now() - 30 * 24 * HOUR).toISOString() },
  ];
  const hubCodes: MockApi["hubCodes"] = [];
  const codesSent: string[] = [];
  const phoneProofs: PhoneProof[] = [];
  let favoriteIds: string[] = [...(options.favorites ?? [])];
  const published = (id: string) => listings.find((l) => l.id === id);
  const favoritesNow = (): Favorites => ({
    items: favoriteIds.flatMap((id) => {
      const listing = published(id);
      return listing ? [toCard(listing, undefined)] : [];
    }),
  });
  const apps = options.apps ?? DEMO_APPS;
  const account = (): Me => ({
    ...me,
    account: { id: "00000000-0000-4000-8600-000000000001", locale: me.locale, createdAt: DEMO_CREATED },
    profile: { firstName: me.firstName, lastName: me.lastName, username: me.username },
    identities,
    roles: {
      client: { id: me.id, locale: me.locale, canMessage: me.canMessage, blocked: false },
      vendors: options.roles?.vendors ?? [],
      staff: options.roles?.staff ?? null,
    },
    session: { kind: "account", app: "web" },
  });
  const demoSession = () => ({
    token: "demo-session-token",
    expiresAt: new Date(now() + 7 * 24 * HOUR).toISOString(),
  });
  const phoneOf = (raw: string) => {
    const phone = normalizeUzPhone(raw);
    if (phone === null) throw new ApiError(400, "invalid_phone");
    return phone;
  };
  const checkCode = (phone: string, code: string) => {
    if (!codesSent.includes(phone)) throw new ApiError(400, "otp_expired");
    if (code !== DEMO_OTP_CODE) throw new ApiError(400, "otp_invalid");
  };
  // После удаления аккаунта запросы с сессией — как у настоящего API после auth.end()
  const signedIn = () => {
    if (deleted) throw new ApiError(401, "account_deleted");
  };

  async function respond<T>(
    method: keyof ClientApi,
    signal: AbortSignal | undefined,
    produce: () => T,
  ): Promise<T> {
    if (latency > 0) await new Promise((resolve) => setTimeout(resolve, latency));
    else await Promise.resolve();
    if (signal?.aborted) throw abortError();
    const failure = options.failWith?.(method);
    if (failure) throw failure;
    return produce();
  }

  const findRequest = (id: string) => {
    const index = requests.findIndex((request) => request.id === id);
    if (index < 0) throw new ApiError(404, "not_found");
    return index;
  };

  return {
    mode: "mock",
    created,
    requests,
    profile: () => me,
    deleted: () => deleted,
    hubCodes,
    codesSent,
    phoneProofs,
    favoriteIds: () => favoriteIds,
    dictionaries: (signal) => respond("dictionaries", signal, () => DEMO_DICTIONARIES),

    catalogCategories: (signal) =>
      respond(
        "catalogCategories",
        signal,
        (): CatalogCategories => ({
          items: CATEGORIES.filter((c) => c.enabled)
            .sort((a, b) => a.sort - b.sort)
            .map((c) => ({
              code: c.code,
              name: categoryTexts(c.label),
              listings: listings.filter((l) => l.categoryCode === c.code).length,
            })),
        }),
      ),

    catalog: (query: CatalogQuery, signal) =>
      respond("catalog", signal, (): CatalogPage => {
        // Без категории — залы, как у сервера; фильтры по полям витрины — по её описанию
        const category = query.category ?? "hall";
        const config = categoryConfig(category);
        const filterParams = Object.fromEntries(
          Object.entries(query.filters ?? {}).map(([name, value]) => [name, [value]]),
        );
        let filters: AttributeFilter[] = [];
        if (config) {
          const parsed = parseAttributeFilters(config, filterParams);
          if (!parsed.ok) throw invalid(parsed.errors);
          filters = parsed.value;
        } else if (Object.keys(filterParams).length > 0) {
          throw invalid(Object.keys(filterParams));
        }
        const limit = Math.min(50, Math.max(1, query.limit ?? 20));
        const offset = Number(query.cursor ?? 0) || 0;
        const rows = listings
          .filter((l) => l.categoryCode === category)
          .filter((l) => filters.every((f) => matchesAttributeFilter(l.attributes, f)))
          .filter((l) => !query.district || l.districtCode === query.district)
          .filter((l) => !query.guests || l.capMax === null || l.capMax >= query.guests)
          .map((l) => toCard(l, query.date));
        // Без sort — по возрастанию цены, как у сервера; цены сравниваются по той же
        // формуле (за мероприятие и за гостя — на одной шкале, с гостями — сумма на них)
        const price = (card: ListingCard) => comparablePriceUzs(card, query.guests ?? null);
        const order = (a: ListingCard, b: ListingCard) => {
          if (query.sort === "price_desc") return price(b) - price(a) || a.id.localeCompare(b.id);
          if (query.sort === "capacity_desc")
            return (b.capMax ?? 0) - (a.capMax ?? 0) || a.id.localeCompare(b.id);
          return price(a) - price(b) || a.id.localeCompare(b.id);
        };
        // Занятые на дату — в конце при любом порядке; оплаты в демо нет вовсе
        rows.sort((a, b) => Number(a.busyOnDate === true) - Number(b.busyOnDate === true) || order(a, b));
        const items = rows.slice(offset, offset + limit);
        const next = offset + limit;
        return { items, nextCursor: next < rows.length ? String(next) : null };
      }),

    listing: (slug, signal) =>
      respond("listing", signal, () => {
        const listing = listings.find((l) => l.slug === slug);
        if (!listing) throw new ApiError(404, "not_found");
        return listing;
      }),

    listingCards: (ids, signal) =>
      respond("listingCards", signal, () => ({
        items: ids.flatMap((id) => {
          const listing = published(id);
          return listing ? [toCard(listing, undefined)] : [];
        }),
      })),

    favorites: (signal) =>
      respond("favorites", signal, () => {
        signedIn();
        return favoritesNow();
      }),

    addFavorite: (listingId) =>
      respond("addFavorite", undefined, () => {
        signedIn();
        if (!published(listingId)) throw new ApiError(404, "not_found");
        if (favoriteIds.includes(listingId)) return;
        if (favoriteIds.length >= FAVORITES_MAX) throw new ApiError(409, "favorites_full");
        favoriteIds = [listingId, ...favoriteIds];
      }),

    removeFavorite: (listingId) =>
      respond("removeFavorite", undefined, () => {
        signedIn();
        favoriteIds = favoriteIds.filter((id) => id !== listingId);
      }),

    mergeFavorites: (ids) =>
      respond("mergeFavorites", undefined, () => {
        signedIn();
        const fresh = [...new Set(ids)].filter((id) => published(id) && !favoriteIds.includes(id));
        favoriteIds = [...favoriteIds, ...fresh].slice(0, FAVORITES_MAX);
        return favoritesNow();
      }),

    consentTexts: (locale, signal) =>
      respond("consentTexts", signal, () => ({ items: demoConsentTexts(locale) })),

    bot: (signal) =>
      respond("bot", signal, () => ({
        username: options.botUsername ?? "bayramm_demo_bot",
        miniAppUrl: typeof window === "undefined" ? "http://localhost:5173" : window.location.origin,
      })),

    createRequest: (body) =>
      respond("createRequest", undefined, () => {
        const listing = listings.find((l) => l.id === body.listingId);
        if (!listing) throw new ApiError(404, "not_found");
        if (!body.requestTransferConsentId) throw new ApiError(422, "validation_failed");
        const { details, dayPart } = checkDetails(listing, body, tashkentToday(now()));
        const duplicate = requests.find(
          (r) =>
            r.listing.id === body.listingId && r.eventDate === body.eventDate && ACTIVE.includes(r.status),
        );
        if (duplicate) throw new ApiError(409, "duplicate_request", duplicate.id);
        // Занятый день или часть дня — как в API (requests/service.ts, assertDateFree)
        if (demoDayLoad(listing, body.eventDate) === "busy")
          throw new ApiError(409, "date_busy", undefined, undefined, ["eventDate"]);
        const takenParts = listing.busyParts.find((p) => p.date === body.eventDate)?.parts ?? [];
        if (dayPart !== null && takenParts.includes(dayPart))
          throw new ApiError(409, "date_busy", undefined, undefined, ["details.start_time"]);
        created.push(body);
        const createdAt = now();
        const request: ClientRequest = {
          id: uuid(4, created.length),
          publicNo: 2000 + created.length,
          status: "new",
          declineReason: null,
          eventDate: body.eventDate,
          guests: body.guests ?? null,
          dayPart,
          details,
          occasionCode: body.occasionCode,
          createdAt: new Date(createdAt).toISOString(),
          slaDueAt: new Date(createdAt + 12 * HOUR).toISOString(),
          firstResponseAt: null,
          slaBreached: false,
          listing: pickListing(listing),
        };
        requests.unshift(request);
        return {
          id: request.id,
          publicNo: request.publicNo,
          status: request.status,
          slaDueAt: request.slaDueAt,
        };
      }),

    myRequests: (signal) =>
      respond("myRequests", signal, () => {
        signedIn();
        return { items: [...requests] };
      }),

    withdrawRequest: (id) =>
      respond("withdrawRequest", undefined, () => {
        const index = findRequest(id);
        const current = requests[index] as ClientRequest;
        if (!ACTIVE.includes(current.status)) throw new ApiError(409, "illegal_transition");
        const next: ClientRequest = { ...current, status: "withdrawn" };
        requests[index] = next;
        return next;
      }),

    me: (signal) =>
      respond("me", signal, () => {
        signedIn();
        return account();
      }),

    updateMe: (patch) =>
      respond("updateMe", undefined, () => {
        signedIn();
        me = { ...me, locale: patch.locale };
        return account();
      }),

    exportMyData: () =>
      respond("exportMyData", undefined, (): ClientDataExport => {
        signedIn();
        return {
          version: 1,
          generatedAt: new Date(now()).toISOString(),
          account: {
            id: me.id,
            locale: me.locale,
            canMessage: me.canMessage,
            createdAt: new Date(now() - 30 * 24 * HOUR).toISOString(),
            lastSeenAt: new Date(now()).toISOString(),
          },
          profile: null,
          consents: [],
          requests: [],
          favorites: favoriteIds.map((id) => {
            const listing = published(id);
            return {
              listing: { id, slug: listing?.slug ?? null, name: listing?.name ?? null },
              savedAt: new Date(now()).toISOString(),
            };
          }),
        };
      }),

    withdrawConsent: (body) =>
      respond("withdrawConsent", undefined, () => {
        signedIn();
        if (body.purpose !== "bot_notifications") return { withdrawn: false };
        const withdrawn = me.notifications;
        me = { ...me, notifications: false };
        return { withdrawn };
      }),

    deleteAccount: () =>
      respond("deleteAccount", undefined, () => {
        signedIn();
        deleted = true;
        requests.length = 0;
        favoriteIds = [];
      }),

    authMethods: (signal) =>
      respond("authMethods", signal, () => ({
        telegram: {
          bot: options.botUsername ?? "bayramm_demo_bot",
          loginDomain: options.loginDomain ?? null,
        },
        phone: options.phone ?? true,
        turnstileSiteKey: options.turnstileSiteKey ?? null,
        apps,
      })),

    signInWidget: () => respond("signInWidget", undefined, demoSession),

    sendPhoneCode: (raw, proof = {}) =>
      respond("sendPhoneCode", undefined, () => {
        if (options.phone === false) throw new ApiError(503, "phone_unavailable");
        const phone = phoneOf(raw);
        if (options.turnstileSiteKey && !proof.turnstileToken && !proof.initData)
          throw new ApiError(400, "turnstile_required");
        phoneProofs.push(proof);
        codesSent.push(phone);
        return { resendAfter: 60, expiresIn: 600 };
      }),

    verifyPhoneCode: (raw, code) =>
      respond("verifyPhoneCode", undefined, () => {
        checkCode(phoneOf(raw), code);
        deleted = false;
        return demoSession();
      }),

    hubCode: (request) =>
      respond("hubCode", undefined, () => {
        signedIn();
        hubCodes.push(request);
        const url = new URL("/auth/callback", apps[request.app]);
        url.searchParams.set("code", `demo-code-${hubCodes.length}`.padEnd(43, "x"));
        url.searchParams.set("state", request.state);
        return { redirectUrl: url.href };
      }),

    linkPhone: (raw, code) =>
      respond("linkPhone", undefined, () => {
        signedIn();
        checkCode(phoneOf(raw), code);
        if (identities.some((i) => i.kind === "phone")) throw new ApiError(409, "identity_kind_taken");
        identities = [...identities, { kind: "phone", verifiedAt: new Date(now()).toISOString() }];
        return account();
      }),

    linkTelegram: () =>
      respond("linkTelegram", undefined, () => {
        signedIn();
        if (identities.some((i) => i.kind === "telegram")) throw new ApiError(409, "identity_kind_taken");
        identities = [...identities, { kind: "telegram", verifiedAt: new Date(now()).toISOString() }];
        return account();
      }),

    signOut: () => respond("signOut", undefined, () => undefined),
    forgetSession: () => {},
  };
}
