/* Контракт API клиента (Mini App и сайт): общий для apps/api и apps/web.

   Адреса — от корня API; web ходит через свой /api (прокси отрезает префикс).
   Суммы — целые сумы. Даты событий — "YYYY-MM-DD" по Ташкенту. Моменты — ISO 8601 в UTC.
   Ошибки — { error: { code, message, details? } } (apps/api/src/errors.ts); code стабилен,
   message — для лога, details — имена неверных полей или параметров (400 invalid_request).
   Откуда пришла заявка — заголовок CLIENT_SOURCE_HEADER: Mini App внутри Telegram шлёт "tma",
   без заголовка (или с другим значением) — "web".
   Персональных данных вендоров, кроме публичного телефона площадки, здесь нет. */

export type Locale = "ru" | "uz";

export interface Localized {
  readonly ru: string;
  readonly uz: string;
}

export type PriceUnit = "per_guest" | "per_event";

/** Заголовок запроса: "tma" — Mini App в Telegram; иначе заявка и согласия пишутся как "web" */
export const CLIENT_SOURCE_HEADER = "X-Bayramm-Source";

export type ClientSource = "tma" | "web";

// ── ошибки ─────────────────────────────────────────────────────────────────

/**
 * Коды ошибок, которые видит клиент:
 *   400 invalid_request (details — поля), invalid_cursor · 401 unauthorized ·
 *   403 forbidden (сессия не клиента), client_blocked · 404 not_found ·
 *   409 duplicate_request (+ existingId), listing_not_active, consent_text_not_current,
 *       illegal_transition (отозвать можно только new/viewed/contacted) ·
 *   413 payload_too_large · 422 consent_required (details — поле), guests_over_capacity,
 *       invalid_input · 429 daily_request_limit, rate_limited (Retry-After, секунды) ·
 *   503 service_unavailable · 500 internal_error ·
 *   избранное: 409 favorites_full (уже FAVORITES_MAX площадок)
 */
export type ClientErrorCode =
  | "invalid_request"
  | "invalid_cursor"
  | "unauthorized"
  | "forbidden"
  | "client_blocked"
  | "not_found"
  | "duplicate_request"
  | "listing_not_active"
  | "consent_text_not_current"
  | "illegal_transition"
  | "payload_too_large"
  | "consent_required"
  | "guests_over_capacity"
  | "invalid_input"
  | "daily_request_limit"
  | "rate_limited"
  | "service_unavailable"
  | "internal_error"
  | "favorites_full";

export interface ApiErrorBody {
  readonly error: {
    readonly code: ClientErrorCode | (string & {});
    readonly message: string;
    readonly details?: readonly string[];
  };
  /** Только у 409 duplicate_request: id уже поданной заявки */
  readonly existingId?: string;
}

// ── справочники ────────────────────────────────────────────────────────────

export interface DictItem {
  readonly code: string;
  readonly name: Localized;
}

/** GET /dictionaries — только включённые категории; всё по порядку sort. Кэшируется (ETag) */
export interface Dictionaries {
  readonly categories: readonly DictItem[];
  readonly districts: readonly DictItem[];
  readonly occasions: readonly DictItem[];
}

// ── каталог ────────────────────────────────────────────────────────────────

/** Фото площадки: адреса вариантов — mediaUrl / mediaSrcSet из @bayramm/media */
export interface Photo {
  readonly key: string;
  readonly width: number;
  readonly height: number;
}

export type CatalogSort = "price_asc" | "price_desc" | "capacity_desc";

/**
 * GET /catalog/listings — параметры строки запроса. Всё необязательно.
 * guests — отсекает площадки, где cap_max меньше. date — не отсекает, а опускает
 * занятые в конец выдачи (при любой сортировке). Оплата на порядок не влияет.
 * sort по умолчанию — price_asc; цены сравниваются по comparablePriceUzs, а не как есть:
 * у одних залов цена за гостя, у других — за мероприятие. Неверный параметр — 400
 * invalid_request (details — имена параметров); курсор от другой сортировки, даты или
 * числа гостей — 400 invalid_cursor.
 */
export interface CatalogQuery {
  readonly category?: string;
  readonly district?: string;
  readonly date?: string;
  readonly guests?: number;
  readonly sort?: CatalogSort;
  /** Непрозрачный курсор из nextCursor */
  readonly cursor?: string;
  /** 1–50, по умолчанию 20 */
  readonly limit?: number;
}

/** Карточка в выдаче. Только активные листинги с ценой и фото */
export interface ListingCard {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly categoryCode: string;
  readonly districtCode: string | null;
  readonly priceFromUzs: number;
  readonly priceUnit: PriceUnit;
  readonly capMin: number | null;
  readonly capMax: number;
  readonly cover: Photo | null;
  readonly photoCount: number;
  /** Занята ли площадка на дату из запроса; null — дата не задана */
  readonly busyOnDate: boolean | null;
}

type PricedCard = Pick<ListingCard, "priceFromUzs" | "priceUnit" | "capMax">;

/**
 * Примерная сумма за мероприятие на guests гостей: цена за гостя × гости, цена за
 * мероприятие — как есть. Столько показывает карточка при заданном числе гостей
 */
export function estimatedTotalUzs(card: PricedCard, guests: number): number {
  return card.priceUnit === "per_guest" ? card.priceFromUzs * guests : card.priceFromUzs;
}

/**
 * Цена для сортировки price_asc / price_desc — одна шкала для обеих единиц цены:
 *   · задано число гостей — примерная сумма на это число (estimatedTotalUzs);
 *   · не задано — цена за гостя: цена за мероприятие делится на вместимость зала (cap_max)
 *     с округлением вверх, то есть «от» на гостя, если зал заполнен.
 * Ту же формулу считает SQL каталога (apps/api/src/catalog/service.ts) и демо-API.
 * Оплата, премиум и продвижение в ней не участвуют — правило продукта
 */
export function comparablePriceUzs(card: PricedCard, guests: number | null): number {
  if (guests !== null) return estimatedTotalUzs(card, guests);
  return card.priceUnit === "per_guest" ? card.priceFromUzs : Math.ceil(card.priceFromUzs / card.capMax);
}

/** GET /catalog/listings → 200 */
export interface CatalogPage {
  readonly items: readonly ListingCard[];
  readonly nextCursor: string | null;
}

/** Сколько площадок помещается в избранное — и у гостя в браузере, и в аккаунте */
export const FAVORITES_MAX = 100;

/**
 * GET /catalog/cards?ids=<uuid>,<uuid>… (не больше FAVORITES_MAX) → 200: карточки
 * опубликованных площадок в порядке ids; неопубликованных и несуществующих в ответе нет.
 * Для избранного гостя: список id хранит браузер, карточки — отсюда
 */
export interface ListingCards {
  readonly items: readonly ListingCard[];
}

export interface ListingPackage {
  readonly kind: "weekday" | "weekend" | "custom";
  readonly name: Localized;
  readonly priceUzs: number;
  readonly priceUnit: PriceUnit;
}

/**
 * GET /catalog/listings/:slug[?date=YYYY-MM-DD] → 200; неактивный или несуществующий — 404.
 * date — только для busyOnDate; без неё busyOnDate = null
 */
export interface ListingDetail extends ListingCard {
  readonly description: Localized;
  readonly address: Localized;
  readonly packages: readonly ListingPackage[];
  /** Готовые и одобренные фото; обложка первой */
  readonly photos: readonly Photo[];
  /** Публичный телефон площадки. Отдаётся до заявки — правило продукта */
  readonly phone: string;
  /** Занятые даты на ближайшие 180 дней, по возрастанию */
  readonly busyDates: readonly string[];
}

// ── согласия ───────────────────────────────────────────────────────────────

export type ClientConsentPurpose = "client_service" | "request_transfer" | "bot_notifications";

export interface ConsentText {
  readonly id: string;
  readonly purpose: ClientConsentPurpose;
  readonly version: number;
  readonly locale: Locale;
  readonly body: string;
}

/**
 * GET /consent-texts?locale=uz → 200: действующие версии (последняя опубликованная и
 * не выведенная) для трёх целей клиента. Без locale — обе локали
 */
export interface ConsentTexts {
  readonly items: readonly ConsentText[];
}

// ── заявки (нужна сессия клиента: Authorization: Bearer <token> из POST /auth/telegram) ─

export type RequestStatus = "new" | "viewed" | "contacted" | "deal" | "declined" | "withdrawn" | "expired";

export type DeclineReason = "busy" | "format" | "price" | "other";

/**
 * POST /requests → 201 RequestCreated.
 * requestTransferConsentId — id текста request_transfer, который клиент видел и отметил
 * сам (галочка не предзаполнена): сервер пишет согласие на этот листинг вместе с заявкой.
 * notifyConsentId — если клиент отдельно разрешил уведомления в боте.
 * 409 duplicate_request — уже есть активная заявка на этот листинг и дату: { error, existingId }.
 */
export interface CreateRequest {
  readonly listingId: string;
  readonly occasionCode: string;
  readonly eventDate: string;
  readonly guests: number;
  readonly budgetMinUzs?: number;
  readonly budgetMaxUzs?: number;
  readonly contactName: string;
  /** +998XXXXXXXXX */
  readonly contactPhone: string;
  readonly comment?: string;
  readonly requestTransferConsentId: string;
  readonly notifyConsentId?: string;
}

export interface RequestCreated {
  readonly id: string;
  readonly publicNo: number;
  readonly status: RequestStatus;
  readonly slaDueAt: string;
}

/** Заявка в «Мои заявки» */
export interface ClientRequest {
  readonly id: string;
  readonly publicNo: number;
  readonly status: RequestStatus;
  readonly declineReason: DeclineReason | null;
  readonly eventDate: string;
  readonly guests: number;
  readonly occasionCode: string;
  readonly createdAt: string;
  readonly slaDueAt: string;
  readonly firstResponseAt: string | null;
  /** Срок ответа прошёл без ответа — клиенту предлагаются похожие площадки */
  readonly slaBreached: boolean;
  readonly listing: Pick<ListingCard, "id" | "slug" | "name" | "cover" | "districtCode">;
}

/** GET /requests → 200: свои заявки, новые сверху (последние 100) */
export interface ClientRequests {
  readonly items: readonly ClientRequest[];
}

// POST /requests/:id/withdraw → 200 ClientRequest. Уже отозванная — 200 без изменений;
// чужая или несуществующая — 404; в итоговом статусе (deal, declined, expired) — 409

// ── ссылки на экраны клиентского приложения ─────────────────────────────────
// Кнопки бота открывают Mini App сразу на нужном экране: адрес WEB_APP_URL + путь.
// Пути и параметры — те же, что разбирает apps/web (router.ts, catalog-feed.ts;
// сверяет тест приложения). Параметры — только маршрут, прав они не дают.

/** Строка запроса без пустых значений: ?a=1&b=2 (или пусто). Пакет без DOM — без URLSearchParams */
function queryString(params: Readonly<Record<string, string | number | null | undefined>>): string {
  const pairs = Object.entries(params)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  return pairs.length > 0 ? `?${pairs.join("&")}` : "";
}

/** «Мои заявки» с раскрытой заявкой: /requests?open=<id> */
export function clientRequestPath(requestId: string): string {
  return `/requests${queryString({ open: requestId })}`;
}

/** Фильтры каталога в адресе; пустые не пишутся */
export interface CatalogLinkFilters {
  readonly date?: string | null;
  readonly guests?: number | null;
  readonly district?: string | null;
}

/** Каталог с фильтрами — «похожие» на заявку: та же дата, столько же гостей, тот же район */
export function clientCatalogPath({ date, guests, district }: CatalogLinkFilters): string {
  return `/${queryString({ date, guests, district })}`;
}
