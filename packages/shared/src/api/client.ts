/* Контракт API клиента (Mini App и сайт): общий для apps/api и apps/web.

   Адреса — от корня API; web ходит через свой /api (прокси отрезает префикс).
   Суммы — целые сумы. Даты событий — "YYYY-MM-DD" по Ташкенту. Моменты — ISO 8601 в UTC.
   Ошибки — { error: { code, message } } (apps/api/src/errors.ts); code стабилен, message — для лога.
   Персональных данных вендоров, кроме публичного телефона площадки, здесь нет. */

export type Locale = "ru" | "uz";

export interface Localized {
  readonly ru: string;
  readonly uz: string;
}

export type PriceUnit = "per_guest" | "per_event";

// ── справочники ────────────────────────────────────────────────────────────

export interface DictItem {
  readonly code: string;
  readonly name: Localized;
}

/** GET /dictionaries — только включённые категории; районы и поводы по порядку sort */
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

/** GET /catalog/listings → 200 */
export interface CatalogPage {
  readonly items: readonly ListingCard[];
  readonly nextCursor: string | null;
}

export interface ListingPackage {
  readonly kind: "weekday" | "weekend" | "custom";
  readonly name: Localized;
  readonly priceUzs: number;
  readonly priceUnit: PriceUnit;
}

/** GET /catalog/listings/:slug → 200; неактивный или несуществующий — 404 */
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

/** GET /consent-texts?locale=uz → 200: действующие версии для клиента */
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

/** GET /requests → 200: свои заявки, новые сверху */
export interface ClientRequests {
  readonly items: readonly ClientRequest[];
}

/** POST /requests/:id/withdraw → 200 ClientRequest */
