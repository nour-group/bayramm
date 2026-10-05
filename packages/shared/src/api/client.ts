/* Контракт API клиента (Mini App и сайт): общий для apps/api и apps/web.

   Адреса — от корня API; web ходит через свой /api (прокси отрезает префикс).
   Суммы — целые сумы. Даты событий — "YYYY-MM-DD" по Ташкенту. Моменты — ISO 8601 в UTC.
   Ошибки — { error: { code, message, details? } } (apps/api/src/errors.ts); code стабилен,
   message — для лога, details — имена неверных полей или параметров (400 invalid_request).
   Откуда пришла заявка — заголовок CLIENT_SOURCE_HEADER: Mini App внутри Telegram шлёт "tma",
   без заголовка (или с другим значением) — "web".
   Персональных данных вендоров, кроме публичного телефона площадки, здесь нет. */

import type { RequestDetails } from "../categories/details";
import type { DayPart, PriceUnit } from "../categories/types";
import type { ListingAttributes } from "../categories/validate";

export type { DayPart, ListingAttributes, PriceUnit, RequestDetails };

export type Locale = "ru" | "uz";

export interface Localized {
  readonly ru: string;
  readonly uz: string;
}

/** Заголовок запроса: "tma" — Mini App в Telegram; иначе заявка и согласия пишутся как "web" */
export const CLIENT_SOURCE_HEADER = "X-Bayramm-Source";

export type ClientSource = "tma" | "web";

// ── ошибки ─────────────────────────────────────────────────────────────────

/**
 * Коды ошибок, которые видит клиент:
 *   400 invalid_request (details — поля; у полей категории — details.<ключ>, у выбранных
 *       услуг — details.services.<номер>.id | .options | .qty), invalid_cursor · 401 unauthorized ·
 *   403 forbidden (сессия не клиента), client_blocked · 404 not_found ·
 *   409 duplicate_request (+ existingId), listing_not_active, consent_text_not_current,
 *       illegal_transition (отозвать можно только new/viewed/contacted), date_busy (витрина
 *       занята в этот день — details eventDate — или в эту часть дня — details.start_time) ·
 *   413 payload_too_large · 422 consent_required (details — поле), guests_over_capacity,
 *       lead_time_too_short (details — eventDate: позже срока подготовки витрины или услуги),
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
  | "lead_time_too_short"
  | "date_busy"
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

/**
 * GET /dictionaries — только включённые категории; всё по порядку sort. Кэшируется (ETag).
 * Описание категорий (поля, формы, услуги) — @bayramm/shared/categories; что показывать в
 * каталоге — GET /catalog/categories (пустые категории клиент не показывает)
 */
export interface Dictionaries {
  readonly categories: readonly DictItem[];
  readonly districts: readonly DictItem[];
  readonly occasions: readonly DictItem[];
}

// ── каталог ────────────────────────────────────────────────────────────────

/** Категория в каталоге: включённая, listings — сколько опубликованных витрин в выдаче */
export interface CatalogCategory {
  readonly code: string;
  readonly name: Localized;
  readonly listings: number;
}

/**
 * GET /catalog/categories → 200: включённые категории по порядку показа, с числом витрин.
 * Категорию без витрин (listings = 0) клиент не показывает. Кэшируется, как каталог
 */
export interface CatalogCategories {
  readonly items: readonly CatalogCategory[];
}

/** Фото площадки: адреса вариантов — mediaUrl / mediaSrcSet из @bayramm/media */
export interface Photo {
  readonly key: string;
  readonly width: number;
  readonly height: number;
}

export type CatalogSort = "price_asc" | "price_desc" | "capacity_desc";

/**
 * GET /catalog/listings — параметры строки запроса. Всё необязательно.
 * category — код категории; без него — залы (hall), как в v0.1 (старые сборки клиента).
 * category=all — все включённые категории одной выдачей (раздел «Все»): фильтров полей витрины,
 * гостей и района там нет (они у каждой категории свои), «вместительнее» — тоже; цены разных
 * единиц сравниваются как есть, подпись единицы — у каждой карточки.
 * guests — отсекает витрины с вместимостью в гостях (cap_max) меньше; у категорий без
 * вместимости не отсекает. date — не отсекает, а опускает занятые в этот день целиком в конец
 * выдачи (при любой сортировке); частично занятые (режим parts: занята часть дня) — среди
 * свободных, с dateLoad = partial. Оплата на порядок не влияет.
 * Фильтры по полям витрины категории — параметры «a.<поле>» и «a.<список>.<поле>»
 * (categoryFilters в @bayramm/shared/categories): bool — 1|true, enum/multi — коды через
 * запятую, int — число. Неизвестный фильтр категории — 400 invalid_request.
 * sort по умолчанию — price_asc; цены сравниваются по comparablePriceUzs, а не как есть:
 * у одних залов цена за гостя, у других — за мероприятие. Неверный параметр — 400
 * invalid_request (details — имена параметров); курсор от другой сортировки, даты или
 * числа гостей — 400 invalid_cursor.
 */
export interface CatalogQuery {
  readonly category?: string;
  /** Фильтры по полям витрины: { "a.parking_spaces": "50", "a.fleet.class": "premium,suv" } */
  readonly filters?: Readonly<Record<string, string>>;
  readonly district?: string;
  readonly date?: string;
  readonly guests?: number;
  readonly sort?: CatalogSort;
  /** Непрозрачный курсор из nextCursor */
  readonly cursor?: string;
  /** 1–50, по умолчанию 20 */
  readonly limit?: number;
}

/** Загрузка витрины на дату: свободна, занята часть дня (режим parts) или занята целиком */
export type DateLoad = "free" | "partial" | "busy";

/**
 * Карточка в выдаче. Только активные витрины с ценой и фото (минимум — по категории).
 * priceFromUzs и priceUnit — цена «от»: самая низкая цена активных услуг витрины, входящих
 * в цену «от» (у зала — банкеты)
 */
export interface ListingCard {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly categoryCode: string;
  readonly districtCode: string | null;
  readonly priceFromUzs: number;
  readonly priceUnit: PriceUnit;
  readonly capMin: number | null;
  /** Вместимость в гостях — у категорий, где она есть (залы); иначе null */
  readonly capMax: number | null;
  readonly cover: Photo | null;
  readonly photoCount: number;
  /** Занята ли витрина на дату из запроса целиком; null — дата не задана */
  readonly busyOnDate: boolean | null;
  /** Загрузка на дату из запроса; null — дата не задана */
  readonly dateLoad: DateLoad | null;
}

type PricedCard = Pick<ListingCard, "priceFromUzs" | "priceUnit" | "capMax">;

/**
 * Примерная сумма за мероприятие на guests гостей: цена за гостя × гости, остальные
 * единицы — как есть. Столько показывает карточка при заданном числе гостей
 */
export function estimatedTotalUzs(card: PricedCard, guests: number): number {
  return card.priceUnit === "per_guest" ? card.priceFromUzs * guests : card.priceFromUzs;
}

/**
 * Цена для сортировки price_asc / price_desc — одна шкала для обеих единиц цены зала:
 *   · задано число гостей — примерная сумма на это число (estimatedTotalUzs);
 *   · не задано — цена за гостя: цена за мероприятие делится на вместимость зала (cap_max)
 *     с округлением вверх, то есть «от» на гостя, если зал заполнен.
 * Без вместимости (не залы) и у остальных единиц цены (за час, за кг…) — цена как есть.
 * Ту же формулу считает SQL каталога (apps/api/src/catalog/service.ts) и демо-API.
 * Оплата, премиум и продвижение в ней не участвуют — правило продукта
 */
export function comparablePriceUzs(card: PricedCard, guests: number | null): number {
  if (guests !== null) return estimatedTotalUzs(card, guests);
  if (card.priceUnit === "per_event" && card.capMax !== null) {
    return Math.ceil(card.priceFromUzs / card.capMax);
  }
  return card.priceFromUzs;
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

/** Опция услуги: клиент отмечает её в заявке (id — в details.services[].options) */
export interface ServiceOption {
  readonly id: string;
  /** Шаблон опции категории, из которого она (extra_hour, drone…); null — своя */
  readonly code: string | null;
  readonly name: Localized;
  readonly priceUzs: number;
  readonly priceUnit: PriceUnit;
}

/** Услуга витрины в карточке: только одобренные (active) */
export interface PublicService {
  readonly id: string;
  /** Код типа услуги категории (bride_car, photo_shoot, other…) */
  readonly type: string;
  /** У типа из каталога — его название, у «другой услуги» — название вендора */
  readonly name: Localized;
  readonly priceUzs: number;
  readonly priceUnit: PriceUnit;
  /** Минимальное количество в единице цены (например, от 3 часов) */
  readonly minQty: number | null;
  /** Заказ не позже чем за столько дней */
  readonly leadDays: number | null;
  /** Что входит; null — не указано */
  readonly includes: Localized | null;
  readonly options: readonly ServiceOption[];
}

/** Частично занятая дата (режим parts): какие части дня заняты */
export interface BusyParts {
  readonly date: string;
  readonly parts: readonly DayPart[];
}

/**
 * GET /catalog/listings/:slug[?date=YYYY-MM-DD] → 200; неактивный или несуществующий — 404.
 * date — только для busyOnDate и dateLoad; без неё оба null
 */
export interface ListingDetail extends ListingCard {
  readonly description: Localized;
  readonly address: Localized;
  /** Поля витрины категории (только известные конфигурации и прошедшие проверку) */
  readonly attributes: ListingAttributes;
  /** Ссылки на видео (YouTube, Instagram) — у категорий, где они есть */
  readonly videoLinks: readonly string[];
  /** Одобренные услуги витрины по порядку */
  readonly services: readonly PublicService[];
  /** Сколько заказов витрина берёт одновременно (режим parts) */
  readonly parallelCapacity: number;
  /** Готовые и одобренные фото; обложка первой */
  readonly photos: readonly Photo[];
  /**
   * Как связаться: телефон и/или Telegram вписаны (самих значений здесь нет). Контакты — по
   * кнопке «Связаться», до всякой заявки и без входа (правило продукта): POST …/contact
   */
  readonly contactChannels: readonly ContactChannel[];
  /** Занятые целиком даты на весь срок выбора даты (366 дней), по возрастанию */
  readonly busyDates: readonly string[];
  /** Частично занятые даты на тот же срок (режим parts), по возрастанию */
  readonly busyParts: readonly BusyParts[];
}

// ── контакты витрины ───────────────────────────────────────────────────────

export type ContactChannel = "phone" | "telegram";

/**
 * POST /catalog/listings/:slug/contact — клиент нажал «Связаться» или выбрал канал. Без входа.
 *   { action: "open" }                → 200 ListingContacts: контакты (и событие «открыли»);
 *   { action: "phone" | "telegram" }  → 204: выбрал «Позвонить» / «Написать в Telegram».
 * signedIn — вошёл ли человек (для счётчиков: клиента событие не хранит). Источник — заголовок
 * X-Bayramm-Source, как у заявок. Неопубликованная витрина — 404; чаще 30 раз в минуту с
 * одного адреса — 429 rate_limited
 */
export type ContactAction = "open" | ContactChannel;

export interface ContactEventInput {
  readonly action: ContactAction;
  readonly signedIn: boolean;
}

/** Контакты витрины: телефон +998…, Telegram — имя без @ (ссылка — https://t.me/<имя>) */
export interface ListingContacts {
  readonly phone: string | null;
  readonly telegram: string | null;
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

/** Выбор услуги в заявке: id услуги витрины, количество в её единице цены, id опций */
export interface ServiceChoiceInput {
  readonly id: string;
  readonly qty?: number | null;
  readonly options?: readonly string[];
}

/**
 * Поля формы заявки категории (requestForm.fields конфигурации): ключ поля → значение.
 * int — число, bool — да/нет, enum — код, multi — коды, time — «ЧЧ:ММ», district — код
 * района, services — ServiceChoiceInput[]. Свободного текста нет — он в comment
 */
export type RequestDetailsInput = Readonly<Record<string, unknown>>;

/**
 * POST /requests → 201 RequestCreated.
 * requestTransferConsentId — id текста request_transfer, который клиент видел и отметил
 * сам (галочка не предзаполнена): сервер пишет согласие на этот листинг вместе с заявкой.
 * notifyConsentId — если клиент отдельно разрешил уведомления в боте.
 * guests — по форме категории (requestForm.guests): required — обязательно, optional — можно
 * не указывать, hidden — не передавать (иначе 400 invalid_request ["guests"]).
 * details — поля категории; у режима parts время начала (details.start_time) обязательно:
 * по нему сервер выбирает часть дня. Выбранные услуги — только активные услуги этой витрины,
 * опции — только этих услуг; названия и цены сервер сохраняет в заявке как есть сейчас.
 * Срок подготовки (поле витрины lead_days, срок выбранных услуг) — 422 lead_time_too_short.
 * 409 duplicate_request — уже есть активная заявка на этот листинг и дату: { error, existingId }.
 */
export interface CreateRequest {
  readonly listingId: string;
  readonly occasionCode: string;
  readonly eventDate: string;
  readonly guests?: number | null;
  readonly details?: RequestDetailsInput;
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
  /** Число гостей; null — категория его не спрашивает или клиент не указал */
  readonly guests: number | null;
  /** Часть дня (режим parts); null — у категории её нет */
  readonly dayPart: DayPart | null;
  /** Поля заявки категории (выбранные услуги — как были при подаче) */
  readonly details: RequestDetails;
  readonly occasionCode: string;
  readonly createdAt: string;
  readonly slaDueAt: string;
  readonly firstResponseAt: string | null;
  /** Срок ответа прошёл без ответа — клиенту предлагаются похожие площадки */
  readonly slaBreached: boolean;
  readonly listing: Pick<ListingCard, "id" | "slug" | "name" | "cover" | "districtCode" | "categoryCode">;
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
  /** Категория (залы — тоже явно: каталог без неё — все разделы) */
  readonly category?: string | null;
  readonly date?: string | null;
  readonly guests?: number | null;
  readonly district?: string | null;
}

/** Каталог с фильтрами — «похожие» на заявку: та же категория и дата, столько же гостей, тот же район */
export function clientCatalogPath({ category, date, guests, district }: CatalogLinkFilters): string {
  return `/${queryString({ category, date, guests, district })}`;
}
