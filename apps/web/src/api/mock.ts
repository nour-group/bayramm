import type {
  CatalogPage,
  CatalogQuery,
  ClientConsentPurpose,
  ClientRequest,
  ConsentText,
  CreateRequest,
  Dictionaries,
  ListingCard,
  ListingDetail,
  Locale,
  RequestStatus,
} from "@bayramm/shared/api";
import { addDays, tashkentToday } from "../format";
import { ApiError } from "./errors";
import type { ClientApi } from "./types";

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
}

export interface MockApi extends ClientApi {
  /** Тела всех принятых POST /requests — для проверок в тестах */
  readonly created: CreateRequest[];
  readonly requests: ClientRequest[];
}

export function createMockApi(options: MockOptions = {}): MockApi {
  const now = options.now ?? Date.now;
  const listings = options.listings ?? demoListings(tashkentToday(now()));
  const requests: ClientRequest[] = [...(options.requests ?? [])];
  const created: CreateRequest[] = [];
  const latency = options.latencyMs ?? 0;

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
        const order = (a: ListingCard, b: ListingCard) => {
          if (query.sort === "price_asc") return a.priceFromUzs - b.priceFromUzs;
          if (query.sort === "price_desc") return b.priceFromUzs - a.priceFromUzs;
          if (query.sort === "capacity_desc") return b.capMax - a.capMax;
          return 0;
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

    myRequests: (signal) => respond("myRequests", signal, () => ({ items: [...requests] })),

    withdrawRequest: (id) =>
      respond("withdrawRequest", undefined, () => {
        const index = findRequest(id);
        const current = requests[index] as ClientRequest;
        if (!ACTIVE.includes(current.status)) throw new ApiError(409, "illegal_transition");
        const next: ClientRequest = { ...current, status: "withdrawn" };
        requests[index] = next;
        return next;
      }),
  };
}
