/* Контракт API кабинета вендора: общий для apps/api и apps/vendor.

   Адреса — от корня API; кабинет ходит через свой /api (прокси отрезает префикс).
   Всё под /vendor/* — только с сессией кабинета: Authorization: Bearer <token> из
   POST /auth/vendor/telegram. Чужая заявка или листинг — 404, а не 403: по ответу не
   узнать, существует ли чужое.
   Суммы — целые сумы. Даты — "YYYY-MM-DD" по Ташкенту. Моменты — ISO 8601 в UTC.
   Ошибки — { error: { code, message } } (apps/api/src/errors.ts); code стабилен.

   Вендор видит о клиенте ровно то, на что клиент дал согласие: имя, телефон и
   комментарий — пока согласие действует и заявка не отозвана. Телефон клиента
   отдаётся только в карточке заявки, и каждое такое чтение записывается в журнал. */

import type { DeclineReason, Locale, Localized, PriceUnit, RequestStatus } from "./client";

export type { DeclineReason, Locale, Localized, PriceUnit, RequestStatus };

// ── вход ───────────────────────────────────────────────────────────────────

/** POST /auth/vendor/telegram — initData Mini App, открытого из бота */
export interface VendorSignIn {
  readonly initData: string;
}

/** → 200. Сессия — 12 часов; после — снова вход по свежей initData */
export interface VendorSession {
  readonly token: string;
  readonly expiresAt: string;
}

/**
 * Коды 403 входа в кабинет:
 *   vendor_not_linked — этот Telegram не привязан ни к одному пользователю вендора:
 *                       привязка — в боте («Я партнёр» → поделиться контактом);
 *   vendor_disabled   — доступ пользователя отключён сотрудником.
 * 401 — initData не прошла проверку или устарела (открыть кабинет из бота заново).
 */
export const VENDOR_SIGN_IN_ERRORS = ["vendor_not_linked", "vendor_disabled"] as const;
export type VendorSignInError = (typeof VENDOR_SIGN_IN_ERRORS)[number];

// ── профиль ────────────────────────────────────────────────────────────────

export type ListingStatus = "lead" | "draft" | "review" | "active" | "suspended" | "rejected";

export interface VendorListingRef {
  readonly id: string;
  readonly name: string;
  readonly status: ListingStatus;
}

/** GET /vendor/me → 200; PATCH /vendor/me { locale } → 200 VendorMe */
export interface VendorMe {
  readonly user: {
    readonly id: string;
    readonly locale: Locale;
    readonly fullName: string | null;
  };
  readonly vendor: {
    readonly id: string;
    /** Публичный код вендора, например V101 — для разговора с менеджером */
    readonly code: string;
    readonly name: string | null;
  };
  /** Листинги вендора, старые первыми */
  readonly listings: readonly VendorListingRef[];
}

export interface VendorMePatch {
  readonly locale: Locale;
}

// ── заявки ─────────────────────────────────────────────────────────────────

/** Вкладки входящих: новые · в работе · закрытые */
export const REQUEST_TABS = ["new", "active", "closed"] as const;
export type RequestTab = (typeof REQUEST_TABS)[number];

export const TAB_STATUSES: Readonly<Record<RequestTab, readonly RequestStatus[]>> = {
  new: ["new"],
  active: ["viewed", "contacted"],
  closed: ["deal", "declined", "withdrawn", "expired"],
};

export interface RequestSla {
  /** Срок ответа: время создания + 12 часов, фиксируется при создании */
  readonly dueAt: string;
  /** Первый ответ вендора (связался, отказал, договорился); null — ещё не ответил */
  readonly firstResponseAt: string | null;
  /** Срок прошёл без ответа или ответ пришёл после срока */
  readonly breached: boolean;
}

/** Заявка в списке входящих */
export interface VendorRequestItem {
  readonly id: string;
  readonly publicNo: number;
  readonly status: RequestStatus;
  readonly declineReason: DeclineReason | null;
  readonly listing: { readonly id: string; readonly name: string };
  readonly occasionCode: string;
  readonly eventDate: string;
  readonly guests: number;
  readonly budgetMinUzs: number | null;
  readonly budgetMaxUzs: number | null;
  readonly createdAt: string;
  readonly sla: RequestSla;
  /** Имя клиента — только пока действует согласие; иначе null */
  readonly contactName: string | null;
}

/**
 * GET /vendor/requests?tab=new&cursor=…&limit=… → 200.
 * Порядок: «Новые» и «В работе» — сначала ждущие ответа, по сроку ответа (ближайший и
 * просроченный сверху), затем ответившие; «Закрытые» — новые сверху.
 * cursor — непрозрачная строка из nextCursor той же вкладки.
 * counts — сколько заявок в каждой вкладке (для подписей вкладок).
 */
export interface VendorRequestPage {
  readonly items: readonly VendorRequestItem[];
  readonly nextCursor: string | null;
  readonly counts: Readonly<Record<RequestTab, number>>;
}

export type HistoryActor = "client" | "vendor_user" | "staff" | "system";

export interface RequestHistoryEntry {
  readonly status: RequestStatus;
  readonly at: string;
  readonly by: HistoryActor;
}

export interface RequestContact {
  readonly name: string;
  /** +998XXXXXXXXX; null — контакт удалён по сроку хранения */
  readonly phone: string | null;
  readonly comment: string | null;
}

/**
 * GET /vendor/requests/:id → 200. Открытие новой заявки отмечает её просмотренной
 * (new → viewed). contact — null, если клиент отозвал заявку или согласие.
 */
export interface VendorRequestDetail extends VendorRequestItem {
  readonly declineNote: string | null;
  readonly contact: RequestContact | null;
  /** Переходы статусов, старые первыми */
  readonly history: readonly RequestHistoryEntry[];
}

/** Куда вендор может перевести заявку; допустимость перехода проверяет база */
export const VENDOR_TARGET_STATUSES = ["contacted", "deal", "declined"] as const;
export type VendorTargetStatus = (typeof VENDOR_TARGET_STATUSES)[number];

export const DECLINE_REASONS: readonly DeclineReason[] = ["busy", "format", "price", "other"];

export const DECLINE_NOTE_MAX = 500;

/**
 * PATCH /vendor/requests/:id → 200 VendorRequestItem.
 *   contacted — «связались» (из new/viewed) или «вернуть в активные» (из deal/declined);
 *   deal      — «договорились» (из contacted);
 *   declined  — отказ, declineReason обязателен. busy занимает дату в календаре.
 * Недопустимый переход — 409 illegal_transition.
 */
export interface VendorRequestPatch {
  readonly status: VendorTargetStatus;
  readonly declineReason?: DeclineReason;
  readonly declineNote?: string;
}

/* POST /vendor/requests/:id/call → 204: вендор нажал на телефон клиента.
   Пишется в журнал действий, статус не меняет. */

// ── календарь ──────────────────────────────────────────────────────────────

/** vendor — отметил вендор; request_decline — отказ «занято»; staff — закрыл сотрудник */
export type BusySource = "vendor" | "request_decline" | "staff";

export interface BusyDay {
  readonly day: string;
  readonly source: BusySource;
  readonly requestId: string | null;
}

/**
 * GET /vendor/listings/:id/calendar?month=YYYY-MM → 200 (по умолчанию — текущий месяц).
 * requestDays — даты событий открытых заявок и сделок этого листинга в месяце.
 */
export interface VendorCalendar {
  readonly listingId: string;
  readonly month: string;
  /** Сегодня по Ташкенту: прошедшие дни не меняются */
  readonly today: string;
  /** Последний день, который можно отметить */
  readonly maxDay: string;
  readonly busy: readonly BusyDay[];
  readonly requestDays: readonly string[];
}

/* PUT    /vendor/listings/:id/calendar/:day → 200 BusyDay: день занят (уже занятый — как есть).
   DELETE /vendor/listings/:id/calendar/:day → 204: день свободен. День, закрытый
          сотрудником, — 403 forbidden_for_actor.
   Прошедший день или дальше maxDay — 422 date_out_of_range. */

// ── площадка ───────────────────────────────────────────────────────────────

export interface VendorPhoto {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly moderation: "pending" | "approved" | "declined";
  readonly isCover: boolean;
  /** Вариант 640 px с воркера media */
  readonly src: string;
  readonly srcSet: string;
}

export interface VendorPackage {
  readonly kind: "weekday" | "weekend" | "custom";
  readonly name: Localized;
  readonly priceUzs: number;
  readonly priceUnit: PriceUnit;
}

/**
 * GET /vendor/listings/:id → 200: карточка площадки как есть в базе, только чтение.
 * Изменения вносит менеджер (модерация) — в кабинете v0.1 правки нет.
 * blockers — чего не хватает для публикации (коды из базы: price, photos, …).
 */
export interface VendorListing {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: ListingStatus;
  readonly statusReason: string | null;
  readonly categoryCode: string;
  readonly districtCode: string | null;
  readonly address: Localized;
  readonly description: Localized;
  readonly priceFromUzs: number | null;
  readonly priceUnit: PriceUnit;
  readonly capMin: number | null;
  readonly capMax: number | null;
  readonly packages: readonly VendorPackage[];
  readonly photos: readonly VendorPhoto[];
  /** Телефон для заявок, который клиент видит сразу */
  readonly phone: string | null;
  readonly blockers: readonly string[];
}
