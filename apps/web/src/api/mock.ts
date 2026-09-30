import { normalizeUzPhone } from "@bayramm/shared";
import {
  type CatalogPage,
  type CatalogQuery,
  type ClientConsentPurpose,
  type ClientRequest,
  type ConsentText,
  type CreateRequest,
  comparablePriceUzs,
  type Dictionaries,
  FAVORITES_MAX,
  type ListingCard,
  type ListingDetail,
  type Locale,
  type RequestStatus,
} from "@bayramm/shared/api";
import type { AccountIdentity, AppCode, VendorMembership } from "@bayramm/shared/api/account";
import type { ClientDataExport, ClientMe, Favorites, Me } from "@bayramm/shared/api/me";
import { addDays, tashkentToday } from "../format";
import { ApiError } from "./errors";
import type { ClientApi, PhoneProof } from "./types";

/* Демо-реализация API в памяти: для тестов и для `pnpm dev:web` без сервера.
   Ведёт себя по контракту @bayramm/shared/api: занятые на дату — в конце выдачи при
   любом порядке, гости отсекают по вместимости, курсор, 404, 409 на повторную заявку.
   Площадки вымышленные, телефоны в несуществующем коде +998 00 — живых людей тут нет.
   В сборку для staging и production не попадает (api/index.ts, проверка в тесте). */

export const DEMO_DICTIONARIES: Dictionaries = {
  categories: [{ code: "hall", name: { ru: "Площадка / Тойхона", uz: "Maydon / Toʻyxona" } }],
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
const uuid = (kind: number, n: number) => `00000000-0000-4000-8${kind}00-${n.toString(16).padStart(12, "0")}`;

/** Демо-площадки; занятые даты считаются от today, чтобы календарь всегда был живой */
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
      description: {
        ru: `Демо-площадка для разработки: зал на ${capMax} гостей, своя кухня и парковка.\nНастоящие описания приходят из API.`,
        uz: `Ishlab chiqish uchun demo maydon: ${capMax} mehmonga zal, oshxona va avtoturargoh bor.\nHaqiqiy tavsiflar API dan keladi.`,
      },
      address: {
        ru: `Ташкент, ${district?.name.ru ?? ""}, демо-адрес ${i + 1}`,
        uz: `Toshkent, ${district?.name.uz ?? ""}, demo manzil ${i + 1}`,
      },
      packages: [
        {
          kind: "weekday",
          name: { ru: "Будни", uz: "Ish kunlari" },
          priceUzs: priceFromUzs,
          priceUnit: perGuest ? "per_guest" : "per_event",
        },
        {
          kind: "weekend",
          name: { ru: "Выходные", uz: "Dam olish kunlari" },
          priceUzs: weekend,
          priceUnit: perGuest ? "per_guest" : "per_event",
        },
      ],
      photos,
      phone: `+998000000${String(i + 1).padStart(3, "0")}`,
      busyDates: [...new Set(busyDates)].sort(),
    } satisfies ListingDetail;
  });
}

const PURPOSES: readonly ClientConsentPurpose[] = ["client_service", "request_transfer", "bot_notifications"];

const CONSENT_BODY: Readonly<Record<Locale, Record<ClientConsentPurpose, string>>> = {
  ru: {
    client_service: "Демо-текст согласия на обслуживание.\nНастоящий текст приходит из API.",
    request_transfer:
      "Демо-текст согласия на передачу заявки вендору: имя, телефон, дата, гости, бюджет и комментарий.\nНастоящий текст приходит из API.",
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

/** Заявки для показа статусов в `pnpm dev:web`: ждём, просрочено, ответили, отказ */
export function demoRequests(listings: readonly ListingDetail[], now: number): ClientRequest[] {
  const today = tashkentToday(now);
  const at = (hoursAgo: number) => new Date(now - hoursAgo * HOUR).toISOString();
  const seeds: [number, RequestStatus, number, number | null, ClientRequest["declineReason"]][] = [
    [0, "new", 3, null, null],
    [1, "viewed", 14, null, null],
    [2, "contacted", 26, 2.25, null],
    [3, "declined", 50, 5, "busy"],
  ];
  return seeds.flatMap(([index, status, hoursAgo, answeredAfter, declineReason], n) => {
    const listing = listings[index];
    if (!listing) return [];
    const createdAt = now - hoursAgo * HOUR;
    return [
      {
        id: uuid(3, n + 1),
        publicNo: 1040 + n,
        status,
        declineReason,
        eventDate: addDays(today, 30 + n * 9),
        guests: Math.min(200, listing.capMax),
        occasionCode: "toy",
        createdAt: at(hoursAgo),
        slaDueAt: new Date(createdAt + 12 * HOUR).toISOString(),
        firstResponseAt:
          answeredAfter === null ? null : new Date(createdAt + answeredAfter * HOUR).toISOString(),
        slaBreached: answeredAfter === null && hoursAgo > 12,
        listing: pickListing(listing),
      },
    ];
  });
}

function pickListing(listing: ListingDetail): ClientRequest["listing"] {
  return {
    id: listing.id,
    slug: listing.slug,
    name: listing.name,
    cover: listing.cover,
    districtCode: listing.districtCode,
  };
}

function toCard(listing: ListingDetail, date: string | undefined): ListingCard {
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
    busyOnDate: date ? listing.busyDates.includes(date) : null,
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
  const listings = (options.listings ?? demoListings(tashkentToday(now()))).filter((l) => !hidden.has(l.id));
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

    catalog: (query: CatalogQuery, signal) =>
      respond("catalog", signal, (): CatalogPage => {
        const limit = Math.min(50, Math.max(1, query.limit ?? 20));
        const offset = Number(query.cursor ?? 0) || 0;
        const rows = listings
          .filter((l) => !query.category || l.categoryCode === query.category)
          .filter((l) => !query.district || l.districtCode === query.district)
          .filter((l) => !query.guests || l.capMax >= query.guests)
          .map((l) => toCard(l, query.date));
        // Без sort — по возрастанию цены, как у сервера; цены сравниваются по той же
        // формуле (за мероприятие и за гостя — на одной шкале, с гостями — сумма на них)
        const price = (card: ListingCard) => comparablePriceUzs(card, query.guests ?? null);
        const order = (a: ListingCard, b: ListingCard) => {
          if (query.sort === "price_desc") return price(b) - price(a) || a.id.localeCompare(b.id);
          if (query.sort === "capacity_desc") return b.capMax - a.capMax || a.id.localeCompare(b.id);
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
        const duplicate = requests.find(
          (r) =>
            r.listing.id === body.listingId && r.eventDate === body.eventDate && ACTIVE.includes(r.status),
        );
        if (duplicate) throw new ApiError(409, "duplicate_request", duplicate.id);
        created.push(body);
        const createdAt = now();
        const request: ClientRequest = {
          id: uuid(4, created.length),
          publicNo: 2000 + created.length,
          status: "new",
          declineReason: null,
          eventDate: body.eventDate,
          guests: body.guests,
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
