/* Контракт API панели оператора: общий для apps/api (маршруты /staff/*) и apps/admin.

   Все маршруты — за сессией сотрудника (Authorization: Bearer <token> из
   POST /auth/staff/elevate или /auth/staff/webapp — @bayramm/shared/api/account), права
   по ролям проверяет сервер на каждом запросе.
   Суммы — целые сумы. Дни — "YYYY-MM-DD". Моменты — ISO 8601 в UTC.
   Ошибки — { error: { code, message, details? } }: для invalid_input в details — имена
   неверных полей, для publish_blocked — коды недостающих пунктов (PublishBlocker).
   Телефоны в ответах не отдаются: только отдельным запросом «показать», который
   база пишет в журнал доступа к ПДн. */

import type { AvailabilityMode, DayPart } from "../categories/types";
import type { AttributeValue } from "../categories/validate";
import type { DeclineReason, ListingAttributes, PriceUnit, RequestDetails, RequestStatus } from "./client";
import type { ListingService } from "./services";
import type { ListingRevisionPayload, RevisionStatus } from "./vendor";

export * from "./services";
export type {
  AvailabilityMode,
  DayPart,
  DeclineReason,
  ListingAttributes,
  ListingRevisionPayload,
  PriceUnit,
  RequestDetails,
  RequestStatus,
  RevisionStatus,
};

export type StaffRole = "admin" | "manager" | "moderator";

export type StaffPermission =
  | "catalog.read"
  | "vendors.write"
  | "vendor_users.write"
  | "listings.write"
  | "listings.submit"
  | "listings.publish"
  | "listings.moderate"
  | "listings.draft"
  | "photos.moderate"
  | "vendor_phones.read"
  | "requests.read"
  | "requests.write"
  | "client_phones.read"
  | "clients.read"
  | "clients.block"
  | "outbox.read"
  | "outbox.retry"
  | "audit.read"
  | "settings.write"
  | "team.manage"
  | "revisions.moderate"
  | "metrics.read";

/** GET /staff/me */
export interface StaffMe {
  readonly id: string;
  readonly role: StaffRole;
  readonly displayName: string;
  readonly username: string | null;
  readonly permissions: readonly StaffPermission[];
  /**
   * Бот знает чат сотрудника (написал боту /start): только тогда приходят оповещения команды.
   * false — панель просит написать боту
   */
  readonly botLinked: boolean;
}

// ── справочники ────────────────────────────────────────────────────────────

export interface StaffDictItem {
  readonly code: string;
  readonly nameRu: string;
  readonly nameUz: string;
}

/** GET /staff/dictionaries */
export interface StaffDictionaries {
  /** Все категории; создать карточку можно только во включённой */
  readonly categories: readonly (StaffDictItem & { readonly enabled: boolean })[];
  readonly districts: readonly StaffDictItem[];
  readonly occasions: readonly StaffDictItem[];
  /** Действующие сотрудники — для выбора менеджера */
  readonly staff: readonly { readonly id: string; readonly displayName: string; readonly role: StaffRole }[];
  readonly settings: { readonly minPhotos: number; readonly maxPhotos: number; readonly slaHours: number };
}

// ── вендоры ────────────────────────────────────────────────────────────────

export type LegalForm = "ooo" | "yatt" | "self_employed";
export type ListingStatus = "lead" | "draft" | "review" | "active" | "suspended" | "rejected";
export type ChecklistItem = "contract" | "stir" | "contacts" | "pdConsent";

/**
 * Коды из app.listing_publish_blockers: чего не хватает для проверки или публикации.
 *   price      — нет услуги с ценой (для проверки — хоть одной отправленной, для публикации —
 *                одобренной);
 *   capacity, district — вместимость в гостях и район, если их требует категория (зал);
 *   packages   — нет обязательных услуг категории (у зала — банкеты будни и выходные);
 *   attributes — не заполнены обязательные поля витрины (какие — missingAttributes);
 *   photos     — меньше минимума фото категории (не меньше 3)
 */
export type PublishBlocker =
  | "price"
  | "capacity"
  | "district"
  | "descriptions"
  | "phone"
  | "packages"
  | "attributes"
  | "photos"
  | "contract"
  | "stir"
  | "contacts"
  | "pd_consent";

export interface ListingRef {
  readonly id: string;
  readonly name: string;
  readonly status: ListingStatus;
  /** Категория витрины */
  readonly categoryCode: string;
}

/** Строка списка GET /staff/vendors */
export interface VendorListItem {
  readonly id: string;
  /** V101 — показывается в интерфейсе */
  readonly code: string;
  readonly name: string | null;
  readonly legalForm: LegalForm | null;
  readonly legalName: string | null;
  readonly contactPerson: string | null;
  readonly managerName: string | null;
  readonly createdAt: string;
  readonly checklist: Readonly<Record<ChecklistItem, boolean>>;
  readonly listings: readonly ListingRef[];
  /** Действующие пользователи кабинета и сколько из них привязали Telegram */
  readonly users: number;
  readonly linkedUsers: number;
}

/**
 * GET /staff/vendors?q=&listingStatus=&category=&limit=&offset= — поиск по названию, коду,
 * юрназванию, контактному лицу, названию или адресу карточки, СТИР (9 цифр) и
 * телефону пользователя кабинета; category — есть витрина этой категории
 */
export interface VendorList {
  readonly total: number;
  readonly items: readonly VendorListItem[];
}

export interface ChecklistMark {
  readonly done: boolean;
  readonly at: string | null;
  /** Имя сотрудника, поставившего отметку */
  readonly by: string | null;
}

/**
 * Пользователь кабинета: pending — приглашение ждёт входа (номер ещё никто не подтвердил),
 * accepted — партнёр вошёл: кабинет открыт его аккаунту, disabled — отключён сотрудником
 */
export type VendorUserStatus = "pending" | "accepted" | "disabled";

export interface VendorUser {
  readonly id: string;
  readonly fullName: string | null;
  readonly role: "owner" | "member";
  /** Язык кабинета и уведомлений партнёра */
  readonly locale: "ru" | "uz";
  readonly status: VendorUserStatus;
  /** Уведомления о заявках привязаны к Telegram партнёра */
  readonly telegramLinked: boolean;
  readonly telegramLinkedAt: string | null;
  /**
   * Уведомления до партнёра доходят: Telegram привязан и бот знает его чат (партнёр писал боту
   * или бот уже пишет ему по другой роли). Привязан, но false — пусть откроет бота
   */
  readonly notifiable: boolean;
  /** Партнёр доказал этот номер (контакт в боте или код из сообщения) — кабинет открыт его аккаунту */
  readonly accountLinked: boolean;
  /** Последний вход в кабинет: Mini App или через хаб на сайте */
  readonly lastLoginAt: string | null;
  readonly disabledAt: string | null;
  readonly createdAt: string;
}

/** Карточка (витрина) в составе вендора. У вендора бывают витрины в нескольких категориях */
export interface ListingBrief extends ListingRef {
  readonly categoryCode: string;
  readonly slug: string;
  readonly districtCode: string | null;
  readonly priceFromUzs: number | null;
  readonly priceUnit: PriceUnit;
  readonly capMax: number | null;
  readonly updatedAt: string;
  /** Чего не хватает для публикации */
  readonly blockers: readonly PublishBlocker[];
}

/** GET /staff/vendors/:id (и ответ на все правки вендора) */
export interface VendorDetail {
  readonly id: string;
  readonly code: string;
  readonly name: string | null;
  readonly legalForm: LegalForm | null;
  readonly contractNo: string | null;
  readonly manager: { readonly id: string; readonly name: string | null } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly contacts: {
    readonly legalName: string | null;
    readonly stir: string | null;
    readonly legalAddress: string | null;
    readonly contactPerson: string | null;
    readonly contactRole: string | null;
    readonly telegramUsername: string | null;
  };
  readonly checklist: Readonly<Record<ChecklistItem, ChecklistMark>>;
  readonly users: readonly VendorUser[];
  readonly listings: readonly ListingBrief[];
}

/**
 * POST /staff/vendors (name обязателен) и PATCH /staff/vendors/:id.
 * Нет поля — не менять, null или "" — очистить. Телефоны только пишутся.
 * categoryCode — только при создании: заодно заводится первая витрина вендора в этой
 * категории (черновик с названием вендора). Витрина в другой категории — POST
 * /staff/vendors/:id/listings
 */
export interface VendorInput {
  readonly name?: string;
  readonly categoryCode?: string;
  readonly legalForm?: LegalForm | null;
  readonly contractNo?: string | null;
  readonly managerId?: string | null;
  readonly legalName?: string | null;
  /** 9 цифр */
  readonly stir?: string | null;
  readonly legalAddress?: string | null;
  readonly contactPerson?: string | null;
  readonly contactRole?: string | null;
  /** +998XXXXXXXXX (принимается и с пробелами, скобками) */
  readonly phone?: string | null;
  readonly phoneAlt?: string | null;
  readonly telegramUsername?: string | null;
}

/**
 * POST /staff/vendors/:id/checklist → VendorDetail.
 * 409 stir_missing — СТИР не вписан; 409 consent_text_missing — нет действующего
 * текста согласия; 409 checklist_locked — снять отметку нельзя, пока карточки опубликованы
 */
export interface ChecklistInput {
  readonly item: ChecklistItem;
  readonly done: boolean;
}

/**
 * POST /staff/vendors/:id/users — приглашение → 201 VendorUser (status accepted — номер уже
 * подтверждён у аккаунта, доступ открыт сразу); 409 phone_taken — номер уже у этого вендора;
 * 409 vendor_user_exists — человек с этим номером уже в кабинете под другим номером;
 * 409 vendor_last_owner — сотрудника площадки без действующего владельца не пригласить.
 * PATCH …/users/:userId (409 user_linked — номер привязанного не сменить; 409 vendor_last_owner —
 * последний действующий владелец остаётся владельцем),
 * POST …/users/:userId/disable | enable | unlink (снять привязку входа и Telegram) → VendorUser,
 * DELETE …/users/:userId — убрать из кабинета → 204 (409 vendor_last_owner)
 */
export interface VendorUserInput {
  readonly phone: string;
  readonly fullName?: string | null;
  /** По умолчанию owner (так заводили до приглашений); панель выбирает явно */
  readonly role?: "owner" | "member";
  /** Язык кабинета и уведомлений; по умолчанию uz */
  readonly locale?: "ru" | "uz";
}

/** PATCH /staff/vendors/:id/users/:userId — нет поля — не менять */
export interface VendorUserPatch {
  readonly phone?: string;
  readonly fullName?: string | null;
  readonly role?: "owner" | "member";
  readonly locale?: "ru" | "uz";
}

/** Раскрытие телефонов: POST …/phones, …/phone — тело { reason? } */
export interface RevealInput {
  readonly reason?: string;
}

/** POST /staff/vendors/:id/phones */
export interface VendorPhones {
  readonly phone: string | null;
  readonly phoneAlt: string | null;
}

/** POST /staff/vendors/:id/users/:userId/phone, /staff/listings/:id/phone, … */
export interface RevealedPhone {
  readonly phone: string | null;
}

/**
 * POST /staff/listings/:id/phone { reason? } → контакты витрины для клиентов: телефон и Telegram
 * (имя без @). Чтение — в журнал доступа к ПДн, как у телефона
 */
export interface RevealedListingContacts extends RevealedPhone {
  readonly telegram: string | null;
}

// ── карточки (листинги) ────────────────────────────────────────────────────

export interface ListingListItem extends ListingBrief {
  readonly statusReason: string | null;
  readonly capMin: number | null;
  readonly submittedAt: string | null;
  readonly vendor: { readonly id: string; readonly code: string; readonly name: string | null };
  /** Готовые фото, из них одобренные и ждущие решения модератора */
  readonly photos: { readonly ready: number; readonly approved: number; readonly pending: number };
}

/**
 * GET /staff/listings?status=&q=&vendorId=&category=&photos=pending&limit=&offset=
 * photos=pending — карточки (любые, кроме отклонённых: фото черновика тоже можно одобрить до
 * публикации) с фото, которые ждут решения (очередь «Новые фото» в модерации: их загрузил
 * партнёр или менеджер), старые загрузки первыми.
 * category — только витрины этой категории
 */
export interface ListingList {
  readonly total: number;
  readonly items: readonly ListingListItem[];
  /** Сколько карточек в каждом статусе (без учёта фильтров) */
  readonly counts: Readonly<Record<ListingStatus, number>>;
}

export type PhotoModeration = "pending" | "approved" | "declined";

/** Фото карточки: адреса вариантов — mediaUrl / mediaSrcSet из @bayramm/media по key */
export interface StaffPhoto {
  readonly id: string;
  readonly key: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly sort: number;
  readonly isCover: boolean;
  readonly moderation: PhotoModeration;
  /** Причина отказа — у отклонённого (её видит партнёр в кабинете); иначе null */
  readonly declineReason: string | null;
  readonly createdAt: string;
}

export interface ListingHistoryEntry {
  readonly from: ListingStatus | null;
  readonly to: ListingStatus;
  readonly reason: string | null;
  readonly actorKind: "client" | "vendor_user" | "staff" | "system";
  /** Имя сотрудника; для вендора и системы — null */
  readonly actorName: string | null;
  readonly at: string;
}

/** GET /staff/listings/:id (и ответ на все правки и действия со статусом) */
export interface ListingDetail {
  readonly id: string;
  readonly slug: string;
  readonly categoryCode: string;
  readonly status: ListingStatus;
  readonly statusReason: string | null;
  readonly statusChangedAt: string | null;
  readonly name: string;
  readonly districtCode: string | null;
  readonly addressRu: string | null;
  readonly addressUz: string | null;
  readonly descriptionRu: string | null;
  readonly descriptionUz: string | null;
  /** Цена «от» — из услуг (до публикации — и из отправленных на проверку); пишет только база */
  readonly priceFromUzs: number | null;
  readonly priceUnit: PriceUnit;
  readonly capMin: number | null;
  readonly capMax: number | null;
  /** Поля витрины категории */
  readonly attributes: ListingAttributes;
  /** Обязательные поля витрины без значения (для подсветки формы) */
  readonly missingAttributes: readonly string[];
  /** Ссылки на видео (YouTube, Instagram) */
  readonly videoLinks: readonly string[];
  /** Сколько заказов витрина берёт одновременно (режим parts) */
  readonly parallelCapacity: number;
  /** Услуги витрины по порядку — все статусы */
  readonly services: readonly ListingService[];
  readonly submittedAt: string | null;
  readonly publishedAt: string | null;
  /** Оптимистичная блокировка: передаётся обратно в каждой правке и смене статуса */
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Телефон для заявок вписан (сам номер — только через «показать») */
  readonly hasPhone: boolean;
  /** Telegram для клиентов вписан (имя — только через «показать», вместе с телефоном) */
  readonly hasTelegram: boolean;
  readonly photos: readonly StaffPhoto[];
  /** Чего не хватает: для отправки на проверку и для публикации */
  readonly blockers: {
    readonly review: readonly PublishBlocker[];
    readonly active: readonly PublishBlocker[];
  };
  readonly vendor: { readonly id: string; readonly code: string; readonly name: string | null };
  /** История статусов, новые сверху */
  readonly history: readonly ListingHistoryEntry[];
  /** Правка карточки, которая ждёт решения модератора (от партнёра или менеджера) */
  readonly pendingRevision: PendingRevision | null;
}

export interface PendingRevision {
  readonly id: string;
  readonly fields: readonly RevisionField[];
  readonly submittedAt: string;
  readonly proposedBy: RevisionAuthor;
}

/**
 * PATCH /staff/listings/:id → 200. У опубликованной карточки название и описания сотрудник
 * без права модерации (менеджер) не меняет сразу: изменённые поля уходят правкой на модерацию
 * (app.listing_revisions, решает модератор или администратор), а остальные поля сохраняются.
 * Цены — только в услугах (/staff/listings/:id/services), цену «от» считает база.
 * sentForModeration — какие поля ушли правкой (пусто — всё сохранено). Открытая правка уже
 * есть — 409 revision_pending: сначала решение по ней
 */
export interface ListingSaveResult extends ListingDetail {
  readonly sentForModeration: readonly RevisionField[];
}

/**
 * POST /staff/listings (vendorId и name обязательны; status — lead или draft, по
 * умолчанию draft; slug — из названия, если не задан) и PATCH /staff/listings/:id
 * (version обязателен). phone: строка — записать, null — убрать. 409 version_conflict —
 * карточку изменили, перечитать; 409 slug_taken.
 * attributes — правка полей витрины: { ключ: значение | null } (null — убрать), проверка —
 * по конфигурации категории (422 invalid_input, details — attributes.<ключ>…); videoLinks —
 * целиком; parallelCapacity — 1–50 (растёт версия календаря). Цен здесь нет — они в услугах.
 * Категорию витрины меняет POST /staff/listings/:id/category (не PATCH)
 */
export interface ListingInput {
  readonly vendorId?: string;
  readonly version?: number;
  readonly status?: "lead" | "draft";
  readonly categoryCode?: string;
  readonly name?: string;
  readonly slug?: string;
  readonly districtCode?: string | null;
  readonly addressRu?: string | null;
  readonly addressUz?: string | null;
  readonly descriptionRu?: string | null;
  readonly descriptionUz?: string | null;
  readonly capMin?: number | null;
  readonly capMax?: number | null;
  readonly phone?: string | null;
  /**
   * Telegram витрины для клиентов: имя пользователя или канала (5–32 знака, латиница, цифры, _;
   * с @ или ссылкой t.me/… — тоже понимаем), null — убрать. 422 invalid_input ["telegram"]
   */
  readonly telegram?: string | null;
  readonly attributes?: Readonly<Record<string, AttributeValue | null>>;
  readonly videoLinks?: readonly string[];
  readonly parallelCapacity?: number;
}

/**
 * POST /staff/vendors/:id/listings { categoryCode, name?, slug? } → 201 ListingDetail:
 * новая витрина существующему вендору — в другой (или той же) категории, черновиком; name —
 * по умолчанию название вендора. Право listings.write; запись в журнал (vendor.listing_add).
 * Пользователи, контакты, согласия и чек-лист — у вендора общие; у витрины — свои поля,
 * услуги, фото, занятость и заявки. 422 invalid_input ["categoryCode"] — категория выключена
 */
export interface VendorListingInput {
  readonly categoryCode: string;
  readonly name?: string;
  readonly slug?: string;
}

/**
 * POST /staff/listings/:id/category { categoryCode, version } → ListingDetail. Только пока по
 * витрине нет заявок (иначе 409 category_locked — заведите новую витрину). Услуги прежней
 * категории удаляются (у опубликованной — нельзя: 422 publish_blocked, сначала приостановить),
 * поля витрины очищаются; фото с людьми в категорию «без людей» — 409 photo_ack_required
 */
export interface ListingCategoryInput {
  readonly categoryCode: string;
  readonly version: number;
}

/** Действия со статусом: POST /staff/listings/:id/<действие> → ListingDetail */
export type ListingAction = "submit" | "publish" | "suspend" | "reject" | "draft";

/**
 * Тело действия. reason обязателен для suspend и reject; для остальных — комментарий в
 * историю. 422 publish_blocked (details — PublishBlocker[]), 409 illegal_transition.
 * publish одобряет готовые фото и услуги карточки, ещё ждущие решения
 */
export interface ListingActionInput {
  readonly version: number;
  readonly reason?: string;
}

// ── фото ───────────────────────────────────────────────────────────────────

/**
 * POST /staff/listings/:id/photos — тело: файл (image/webp|jpeg|png, ≤ 10 МБ) после
 * compressForUpload; заголовок X-No-Faces: 1 — сотрудник подтвердил, что лиц на фото нет, или
 * (только у категорий с правилом portfolio) X-Photo-Consent: 1 — люди на фото согласны на
 * публикацию (без подтверждения — 422 no_faces_ack_required | photo_consent_required).
 * → 201 StaffPhoto. 409 too_many_photos, duplicate_photo; 413; 422 invalid_image (details — код)
 *
 * PUT    /staff/listings/:id/photos/order { ids }          → StaffPhoto[]
 * POST   /staff/listings/:id/photos/:photoId/cover         → StaffPhoto[]
 * POST   /staff/listings/:id/photos/:photoId/moderation { decision, reason? } → StaffPhoto[] —
 *         отказ (declined) только с причиной, 1–500 знаков; без неё 422 invalid_input ["reason"]
 * DELETE /staff/listings/:id/photos/:photoId               → StaffPhoto[]
 */
export interface PhotoOrderInput {
  readonly ids: readonly string[];
}

export interface PhotoModerationInput {
  readonly decision: "approved" | "declined";
  /** Причина отказа: обязательна при declined, её видит партнёр в кабинете; у approved не нужна */
  readonly reason?: string;
}

// ── занятость ──────────────────────────────────────────────────────────────

export interface BusyDay {
  readonly day: string;
  /** vendor — отметил вендор, staff — сотрудник, request_decline — отказ по заявке «занято» */
  readonly source: "vendor" | "staff" | "request_decline";
}

/** Занятая часть дня (режим parts) */
export interface BusyPart extends BusyDay {
  readonly part: DayPart;
}

/** Договорённости (заявки deal) на часть дня */
export interface PartBookings {
  readonly day: string;
  readonly part: DayPart;
  readonly count: number;
}

/** День и часть дня — для правки занятости по частям */
export interface DayPartRef {
  readonly day: string;
  readonly part: DayPart;
}

/**
 * GET /staff/listings/:id/availability?from=YYYY-MM-DD&to=YYYY-MM-DD (не больше 400 дней)
 * PUT /staff/listings/:id/availability { version, busy: [дни], free: [дни], busyParts, freeParts }
 * — отметить и снять (весь день или часть дня — только у режима parts, иначе 422 invalid_input
 * ["busyParts"]); ответ — изменённые дни и новая версия. version — из последнего ответа:
 * календарь с тех пор изменили (партнёр, другой сотрудник, отказ «занято») — 409
 * calendar_conflict, перечитать. Прошедший день по Ташкенту — 422 date_out_of_range
 * (details — busy/free/busyParts/freeParts)
 */
export interface Availability {
  readonly from: string;
  readonly to: string;
  readonly mode: AvailabilityMode;
  readonly parallelCapacity: number;
  readonly busy: readonly BusyDay[];
  /** Занятые части дня (режим parts) */
  readonly parts: readonly BusyPart[];
  /** Договорённости по частям дня (режим parts) */
  readonly bookings: readonly PartBookings[];
  /** Версия календаря карточки (всех дней) — для следующей правки */
  readonly version: number;
}

export interface AvailabilityInput {
  readonly version: number;
  readonly busy?: readonly string[];
  readonly free?: readonly string[];
  readonly busyParts?: readonly DayPartRef[];
  readonly freeParts?: readonly DayPartRef[];
}

// ── услуги витрин ──────────────────────────────────────────────────────────

/*
 * Услуги витрины в панели (поля — ServiceInput, ответ — ListingService, @bayramm/shared/api/services):
 *
 * GET    /staff/listings/:id/services                       → ListingServices (catalog.read)
 * POST   /staff/listings/:id/services      ServiceInput     → 201 ListingService (listings.write).
 *        Модератор и администратор заводят услугу сразу одобренной; менеджер — на проверку
 *        (у неопубликованной витрины её одобрит публикация).
 * PATCH  /staff/listings/:id/services/:sid ServiceInput     → ListingService (listings.write).
 *        Менеджер у активной услуги опубликованной витрины — предложением (proposal), как партнёр.
 * POST   /staff/listings/:id/services/:sid/pause            → снять с витрины (listings.write)
 * POST   /staff/listings/:id/services/:sid/resume           → вернуть: модератор — сразу, менеджер —
 *        на проверку
 * DELETE /staff/listings/:id/services/:sid                  → 204 (listings.write; активную
 *        опубликованной витрины менеджер не удаляет — 409 moderated_field_requires_revision)
 * Последнюю услугу с ценой опубликованной витрины не снять и не удалить — 422 publish_blocked.
 *
 * Модерация (право revisions.moderate — администратор, модератор):
 * GET    /staff/services?status=pending|review|proposal&limit=&offset= → ServiceQueue: новые услуги
 *        на проверке и предложения правок у любых витрин, кроме отклонённых (и у черновика: партнёр
 *        видит «на проверке»), старые первыми; total — сколько всего, items — не больше limit
 * POST   /staff/services/:sid/approve                       → ListingService: одобрить услугу или
 *        применить предложение (422 service_invalid — не проходит проверку полей)
 * POST   /staff/services/:sid/decline { reason }            → ListingService: отклонить услугу или
 *        предложение; причину увидит партнёр
 * Решение по услуге — уведомление владельцам кабинета (vendor.service_decided): одобрение — у
 * опубликованной витрины, отказ — у любой
 */

/** Что ждёт решения: новая услуга (review) или предложение правки активной (proposal) */
export type ServiceQueueKind = "review" | "proposal";

export interface ServiceQueueItem {
  readonly kind: ServiceQueueKind;
  readonly service: ListingService;
  readonly listing: {
    readonly id: string;
    readonly name: string;
    readonly status: ListingStatus;
    readonly categoryCode: string;
  };
  readonly vendor: { readonly id: string; readonly code: string; readonly name: string | null };
  /** Кто отправил: партнёр из кабинета или сотрудник (менеджер) из панели */
  readonly proposedBy: RevisionAuthor;
  readonly submittedAt: string;
}

export interface ServiceQueue {
  readonly total: number;
  readonly items: readonly ServiceQueueItem[];
}

export interface ServiceDeclineInput {
  readonly reason: string;
}

// ── заявки ─────────────────────────────────────────────────────────────────

/**
 * Состояние срока ответа (SLA):
 *   waiting       — ответа нет, срок не вышел
 *   overdue       — ответа нет, срок вышел
 *   breached      — ответа нет, срок вышел и система уже отметила нарушение (эскалация)
 *   answered      — ответ в срок
 *   answered_late — ответ после срока
 *   ops_contacted — первым отметил «связались» сотрудник: ответом вендора не считается
 *   closed        — заявка закрыта без ответа вендора (отозвана клиентом, истекла)
 */
export type SlaState =
  | "waiting"
  | "overdue"
  | "breached"
  | "answered"
  | "answered_late"
  | "ops_contacted"
  | "closed";

/** Фильтр списка заявок: состояние срока или late — просроченные и нарушенные (очередь) */
export type SlaFilter = SlaState | "late";

export interface StaffRequestItem {
  readonly id: string;
  readonly publicNo: number;
  readonly status: RequestStatus;
  readonly sla: SlaState;
  readonly slaDueAt: string;
  readonly firstResponseAt: string | null;
  readonly firstResponseBy: "vendor_user" | "staff" | "system" | "client" | null;
  readonly occasionCode: string;
  readonly eventDate: string;
  /** Число гостей; null — категория его не спрашивает или клиент не указал */
  readonly guests: number | null;
  /** Часть дня (режим parts); null — у категории её нет */
  readonly dayPart: DayPart | null;
  readonly createdAt: string;
  /** Имя, которое клиент вписал в заявку — чья она; null — удалено по сроку хранения или не вписано */
  readonly contactName: string | null;
  readonly listing: { readonly id: string; readonly name: string; readonly categoryCode: string };
  readonly vendor: { readonly id: string; readonly code: string; readonly name: string | null };
  /** Сколько раз вендору напоминали (автоматически и сотрудники) */
  readonly reminders: number;
}

/**
 * GET /staff/requests?status=&sla=&category=&q=&limit=&offset= — сначала без ответа: ближайший
 * (или самый давний) срок первым. sla=late — очередь просроченных и нарушенных; category —
 * заявки витрин этой категории
 */
export interface StaffRequestList {
  readonly total: number;
  readonly items: readonly StaffRequestItem[];
  /** Сколько заявок в каждом состоянии SLA (без учёта фильтров) */
  readonly counts: Readonly<Record<SlaState, number>>;
}

export interface RequestHistoryEntry {
  readonly from: RequestStatus | null;
  readonly to: RequestStatus;
  readonly actorKind: "client" | "vendor_user" | "staff" | "system";
  readonly source: string;
  readonly reason: string | null;
  readonly at: string;
}

/** GET /staff/requests/:id */
export interface StaffRequestDetail extends StaffRequestItem {
  readonly budgetMinUzs: number | null;
  readonly budgetMaxUzs: number | null;
  readonly declineReason: DeclineReason | null;
  readonly declineNote: string | null;
  readonly firstViewedAt: string | null;
  readonly slaBreachedAt: string | null;
  readonly source: string;
  /** Комментарий клиента из заявки; null — удалён по сроку хранения (имя — contactName) */
  readonly comment: string | null;
  readonly contactPurged: boolean;
  /** Поля заявки категории (выбранные услуги — как были при подаче) */
  readonly details: RequestDetails;
  readonly history: readonly RequestHistoryEntry[];
  /** Срок ответа по порядку: создана, просмотрена, напоминания, срок, нарушение, первый ответ */
  readonly timeline: readonly SlaEvent[];
  /** Заметки сотрудников, старые сверху */
  readonly notes: readonly RequestNote[];
  /** Заявка ждёт первого ответа вендора: напомнить и отметить «связались» можно */
  readonly awaiting: boolean;
  /** Сколько пользователей вендора получат напоминание (привязали Telegram) */
  readonly vendorReachable: number;
  /** Раньше этого момента напоминание сотрудника снова не отправить; null — можно */
  readonly nextReminderAt: string | null;
}

/**
 * Событие срока ответа. reminder: auto — этап SLA (stage 1, 2), ops — сотрудник (by — имя);
 * recipients — сколько пользователям вендора, delivered и failed — чем кончилось.
 * due — срок ответа (passed — уже прошёл); response — первый ответ (by — кто: вендор или сотрудник)
 */
export type SlaEvent =
  | { readonly kind: "created"; readonly at: string }
  | { readonly kind: "viewed"; readonly at: string }
  | {
      readonly kind: "reminder";
      readonly at: string;
      readonly source: "auto" | "ops";
      readonly stage: number | null;
      readonly by: string | null;
      readonly recipients: number;
      readonly delivered: number;
      readonly failed: number;
    }
  | { readonly kind: "due"; readonly at: string; readonly passed: boolean }
  | { readonly kind: "breached"; readonly at: string }
  | {
      readonly kind: "response";
      readonly at: string;
      readonly by: "vendor_user" | "staff" | "system" | "client";
    };

export interface RequestNote {
  readonly id: string;
  readonly text: string;
  readonly authorName: string | null;
  readonly at: string;
}

/**
 * Действия с заявкой (право requests.write) → StaffRequestDetail:
 *   POST /staff/requests/:id/remind                   напомнить вендору сейчас: 409 request_not_awaiting,
 *        vendor_unreachable (никто не привязал Telegram — звонить); 429 reminder_too_soon (пауза —
 *        настройка ops_reminder_pause_minutes, когда можно снова — nextReminderAt)
 *   POST /staff/requests/:id/contacted { comment? }  «связались» — отметка сотрудника (в метрику
 *        вендора не идёт); 409 illegal_transition — заявка уже не ждёт ответа
 *   POST /staff/requests/:id/notes { text }          заметка (только добавить)
 */
export interface RequestContactedInput {
  readonly comment?: string;
}

export interface RequestNoteInput {
  readonly text: string;
}

// ── клиенты ────────────────────────────────────────────────────────────────
// Клиент — псевдоним: id (и короткая ссылка C-xxxxxxxx). Поиск — по id или номеру
// заявки; по телефону и имени не ищем. Выгрузки базы клиентов нет ни в каком виде

export interface ClientListItem {
  readonly id: string;
  /** Короткая ссылка: C- и первые 8 символов id — для поиска и переписки, не для глаз */
  readonly ref: string;
  /**
   * Как показать клиента в списке: имя из Telegram и первая буква фамилии («Азиза К.»);
   * null — имени нет (аккаунт удалён или вход без Telegram)
   */
  readonly displayName: string | null;
  /** Чем входил: Telegram и/или телефон (без самих значений) */
  readonly signIn: readonly ("telegram" | "phone")[];
  /** Последняя заявка: номер, витрина и статус; null — заявок нет */
  readonly lastRequest: {
    readonly publicNo: number;
    readonly listingName: string;
    readonly status: RequestStatus;
  } | null;
  readonly createdAt: string;
  readonly lastSeenAt: string | null;
  readonly locale: "ru" | "uz";
  readonly blocked: boolean;
  /** Клиент удалил аккаунт: профиля с ПДн нет, псевдоним и заявки остались */
  readonly deleted: boolean;
  readonly requests: number;
  readonly lastRequestAt: string | null;
}

/** GET /staff/clients?q=&blocked=1&limit=&offset= — q: id, его начало (от 8 знаков), C-…, номер заявки */
export interface ClientList {
  readonly total: number;
  readonly items: readonly ClientListItem[];
}

export interface ClientRequest {
  readonly id: string;
  readonly publicNo: number;
  readonly status: RequestStatus;
  readonly sla: SlaState;
  readonly eventDate: string;
  readonly createdAt: string;
  readonly listing: { readonly id: string; readonly name: string };
}

export type ConsentPurpose =
  | "client_service"
  | "request_transfer"
  | "bot_notifications"
  | "vendor_contact"
  | "vendor_phone_public"
  | "vendor_offer";

export interface ClientConsent {
  readonly purpose: ConsentPurpose;
  readonly action: "grant" | "withdraw";
  readonly textVersion: number;
  readonly source: string;
  readonly at: string;
  readonly listing: { readonly id: string; readonly name: string } | null;
}

/** GET /staff/clients/:id (и ответ на блокировку) */
export interface ClientDetail extends ClientListItem {
  readonly canMessage: boolean;
  readonly deletedAt: string | null;
  readonly blockedInfo: {
    readonly at: string;
    readonly reason: string;
    readonly by: string | null;
  } | null;
  /** Имя из Telegram; null — аккаунт удалён */
  readonly profile: {
    readonly firstName: string | null;
    readonly lastName: string | null;
    readonly username: string | null;
  } | null;
  /** Заявки клиента, новые сверху */
  readonly requestList: readonly ClientRequest[];
  /** Журнал согласий, новые сверху */
  readonly consents: readonly ClientConsent[];
}

/**
 * POST /staff/clients/:id/block { reason } → ClientDetail (право clients.block; 422 reason_required)
 * POST /staff/clients/:id/unblock          → ClientDetail
 * POST /staff/clients/:id/phone { reason } → RevealedPhone — только администратор, с причиной,
 *      чтение пишется в журнал доступа к ПДн
 */
export interface ClientBlockInput {
  readonly reason: string;
}

// ── уведомления ────────────────────────────────────────────────────────────

export type OutboxStatus = "pending" | "sending" | "sent" | "failed" | "dead";

export interface OutboxDeadItem {
  readonly id: string;
  /** vendor.request_new, client.request_status, ops.sla_breach … */
  readonly kind: string;
  readonly recipientKind: "client" | "vendor_user" | "staff" | "system";
  /** Первые 8 символов id получателя — найти, не раскрывая лишнего */
  readonly recipientRef: string | null;
  /**
   * Кто получатель словами: пользователь кабинета — его имя или название вендора, сотрудник —
   * имя, клиент — код C-…; null — получателя нет или он удалён. Телефонов здесь не бывает
   */
  readonly recipientLabel: string | null;
  readonly attempts: number;
  /** Причина последней неудачи: код и ответ Telegram, без ПДн */
  readonly error: string | null;
  readonly createdAt: string;
  readonly lastAttemptAt: string | null;
  readonly request: { readonly id: string; readonly publicNo: number } | null;
}

/**
 * GET /staff/outbox → здоровье очереди уведомлений (право outbox.read).
 * POST /staff/outbox/:id/retry → OutboxHealth — только администратор; 409 illegal_transition,
 * если строка уже не dead
 */
export interface OutboxHealth {
  /** Сколько строк в каждом состоянии; sent — за последние 24 часа */
  readonly counts: Readonly<Record<OutboxStatus, number>>;
  /** Самое давнее ожидающее отправки — если давно, отправитель не работает */
  readonly oldestPendingAt: string | null;
  readonly deadTotal: number;
  /** Недоставленные, новые сверху (не больше 100) */
  readonly dead: readonly OutboxDeadItem[];
}

// ── журнал действий ────────────────────────────────────────────────────────

/** Кто действовал: account — человек над своим аккаунтом (способы входа, удаление) */
export type ActorKind = "account" | "client" | "vendor_user" | "staff" | "system";

export interface AuditEntry {
  readonly id: string;
  readonly at: string;
  readonly actorKind: ActorKind;
  /**
   * Кто действовал. name: сотрудник — его имя, пользователь кабинета — его имя или название
   * вендора, клиент — код C-…; null — имени нет или актора уже нет. null — система
   */
  readonly actor: { readonly id: string; readonly name: string | null } | null;
  /** listing.update, request.remind, staff.invite … */
  readonly action: string;
  readonly objectType: string;
  readonly objectId: string;
  /**
   * Объект словами: название витрины или вендора, «№1051» заявки, код клиента C-…, имя
   * сотрудника или пользователя кабинета; null — у вида объекта нет названия (настройка,
   * уведомление) или объекта уже нет: тогда показывают короткий id
   */
  readonly objectLabel: string | null;
  /** Как записано: коды, id и имена полей — без значений ПДн */
  readonly detail: Readonly<Record<string, unknown>>;
  readonly source: string | null;
}

/**
 * GET /staff/audit?actor=&actorKind=&type=&object=&action=&from=&to=&limit=&offset= (право audit.read).
 * actor — id сотрудника, type — вид объекта, object — его id, action — начало кода действия,
 * from / to — дни по Ташкенту ("YYYY-MM-DD", включительно). Новые сверху
 */
export interface AuditList {
  readonly total: number;
  readonly items: readonly AuditEntry[];
}

export interface PiiAccessEntry {
  readonly id: string;
  readonly at: string;
  readonly actorKind: ActorKind;
  /** Как в AuditEntry: сотрудник, пользователь кабинета или клиент — с подписью */
  readonly actor: { readonly id: string; readonly name: string | null } | null;
  /** client, request_contact, vendor_contact, vendor_user, listing_contact */
  readonly subjectKind: string;
  readonly subjectId: string;
  /**
   * Чей телефон словами: код клиента C-…, «№1051» заявки, название вендора или витрины, имя
   * пользователя кабинета; null — субъекта уже нет. Самого номера здесь нет
   */
  readonly subjectLabel: string | null;
  readonly field: string;
  /** staff_reveal, request_inbox, self … */
  readonly purpose: string;
  readonly reason: string | null;
}

/** GET /staff/audit/pii?actor=&actorKind=&type=&object=&from=&to=&limit=&offset= — кто читал телефоны */
export interface PiiAccessList {
  readonly total: number;
  readonly items: readonly PiiAccessEntry[];
}

// ── настройки ──────────────────────────────────────────────────────────────

export type SettingKey =
  | "sla_hours"
  | "sla_reminder_hours"
  | "quiet_hours"
  | "min_photos"
  | "max_photos"
  | "client_requests_per_day"
  | "request_contact_retention_days"
  | "otp_retention_hours"
  | "session_retention_days"
  | "ops_reminder_pause_minutes";

/** Значение: число; sla_reminder_hours — [часы, часы]; quiet_hours — { from: "22:00", to: "08:00" } */
export type SettingValue = number | readonly number[] | { readonly from: string; readonly to: string };

export interface StaffSetting {
  readonly key: SettingKey;
  readonly value: SettingValue;
  readonly updatedAt: string;
  readonly updatedBy: string | null;
}

/**
 * GET /staff/settings → StaffSettings; PUT /staff/settings/:key { value } → StaffSettings
 * (право settings.write — только администратор). 422 invalid_input (details — [key]): вне
 * границ или не согласуется с другими настройками (напоминания раньше срока ответа,
 * минимум фото не больше максимума). Срок ответа фиксируется в заявке при создании —
 * новое значение действует на новые заявки
 */
export interface StaffSettings {
  readonly items: readonly StaffSetting[];
}

export interface SettingInput {
  readonly value: SettingValue;
}

// ── команда ────────────────────────────────────────────────────────────────

export interface TeamMember {
  readonly id: string;
  readonly displayName: string;
  /** Имя пользователя Telegram, по которому пригласили (без «@»); null — по телефону */
  readonly username: string | null;
  /** Как пригласили: по имени в Telegram или по телефону (номер не хранится и не отдаётся) */
  readonly invitedBy: "telegram" | "phone";
  readonly role: StaffRole;
  readonly active: boolean;
  /** Приглашение принято: роль привязана к аккаунту Bayramm */
  readonly accepted: boolean;
  /** Telegram привязан (оповещения команды): первый вход через Telegram был */
  readonly linked: boolean;
  readonly linkedAt: string | null;
  /** Бот знает чат (написал боту /start): оповещения команды приходят только тогда */
  readonly botLinked: boolean;
  readonly createdAt: string;
  /** Это вы: себя не отключить и роль не сменить */
  readonly self: boolean;
}

/**
 * GET /staff/team → TeamList (право team.manage — только администратор).
 * POST /staff/team TeamInviteInput → 201 TeamList; 409 username_taken — имя у действующего
 *   сотрудника, 409 staff_phone_taken — номер у действующего сотрудника или у аккаунта с
 *   этим номером уже есть роль сотрудника; 422 invalid_input — поле phone не номер
 *   Узбекистана (+998 и 9 цифр).
 * POST /staff/team/:id/role { role } | /deactivate | /activate → TeamList;
 * 409 staff_self — себя нельзя, staff_last_admin — должен остаться администратор
 */
export interface TeamList {
  readonly items: readonly TeamMember[];
}

/**
 * Приглашение: по имени пользователя Telegram или по номеру телефона — одно из двух.
 * По телефону приглашение принимает первый вход кодом на этот номер (или сразу, если
 * номер уже подтверждён у аккаунта Bayramm)
 */
export type TeamInviteInput = {
  readonly displayName: string;
  readonly role: StaffRole;
} & (
  | { readonly username: string; readonly phone?: never }
  | { readonly phone: string; readonly username?: never }
);

// ── правки карточек (ревизии) ──────────────────────────────────────────────

// RevisionStatus и ListingRevisionPayload — в контракте кабинета (@bayramm/shared/api/vendor):
// правку подаёт партнёр

export type RevisionField = "name" | "descriptionRu" | "descriptionUz" | "attributes" | "videoLinks";

/** attributes — изменённые поля витрины { ключ: значение | null }, videoLinks — ссылки целиком */
export type RevisionValue =
  | string
  | number
  | null
  | readonly string[]
  | Readonly<Record<string, AttributeValue | null>>;

export interface RevisionChange {
  readonly field: RevisionField;
  /** Сейчас в карточке */
  readonly before: RevisionValue;
  /** Предлагает вендор */
  readonly after: RevisionValue;
}

/** Кто предложил правку: партнёр из кабинета или сотрудник (менеджер) из панели */
export interface RevisionAuthor {
  readonly kind: "partner" | "staff";
  /** Имя сотрудника; у партнёра — null (контакт — в карточке вендора) */
  readonly name: string | null;
}

export interface RevisionListItem {
  readonly id: string;
  readonly status: RevisionStatus;
  readonly submittedAt: string;
  readonly decidedAt: string | null;
  /** categoryCode — подписи полей витрины в правке */
  readonly listing: {
    readonly id: string;
    readonly name: string;
    readonly status: ListingStatus;
    readonly categoryCode: string;
  };
  readonly vendor: { readonly id: string; readonly code: string; readonly name: string | null };
  readonly proposedBy: RevisionAuthor;
  readonly fields: readonly RevisionField[];
  /** Карточку меняли после того, как вендор начал правку: сравните внимательно */
  readonly stale: boolean;
}

/** GET /staff/revisions?status=pending|approved|declined|withdrawn — очередь: старые сверху */
export interface RevisionList {
  readonly total: number;
  readonly items: readonly RevisionListItem[];
}

/**
 * GET /staff/revisions/:id. Решение (право revisions.moderate):
 *   POST /staff/revisions/:id/approve             → применить к карточке (422 revision_invalid —
 *        правка не проходит проверку полей, publish_blocked — карточка перестала бы быть готовой)
 *   POST /staff/revisions/:id/decline { reason } → отклонить; причину увидит вендор.
 * 409 illegal_transition — по правке уже решили
 */
export interface RevisionDetail extends RevisionListItem {
  readonly changes: readonly RevisionChange[];
  /** Правка проходит проверку полей — её можно одобрить */
  readonly valid: boolean;
  readonly decisionReason: string | null;
  readonly decidedBy: string | null;
}

export interface RevisionDeclineInput {
  readonly reason: string;
}

/**
 * POST /staff/requests/:id/client-phone { reason } → RevealedPhone — только администратор,
 * причина обязательна (422 reason_required), чтение пишется в журнал доступа к ПДн.
 * POST /staff/requests/:id/vendor-phone { reason? } → VendorPhones & { listingPhone }
 */
export interface RequestVendorPhones extends VendorPhones {
  readonly listingPhone: string | null;
}

// ── метрики запуска ────────────────────────────────────────────────────────
// Только числа, без ПДн (право metrics.read — все роли). Определения — одни для панели и
// отчётов бота, в базе (миграция 20260930220000_launch_metrics.sql):
//   · ответ площадки — её первый переход заявки в contacted, deal или declined; просмотр,
//     нажатие на телефон и «связались» от сотрудника — не ответ площадки;
//   · в срок — не позже срока ответа заявки (sla_hours при создании, 12 часов);
//   · measurable — исход известен: ответила в срок или срок прошёл; отозванные клиентом до
//     срока без ответа — не в расчёте. answeredRate = answeredInTime / measurable;
//   · время ответа — от создания до ответа площадки (медиана, 90-й перцентиль — по
//     заявкам с ответом); agreedRate — сейчас в статусе «договорились» / все заявки;
//   · неделя — ISO, с понедельника по Ташкенту; заявка — в периоде своего создания;
//   · категория заявки — категория витрины (её не сменить, пока у витрины есть заявки);
//     фильтр category — код из @bayramm/shared/categories, неизвестный — 422 ["category"].
// Доли — проценты с одним знаком (50.5); null — не из чего считать.

/** Метрики заявок за период */
export interface PeriodMetrics {
  readonly requests: number;
  /** Разных клиентов среди авторов заявок */
  readonly clients: number;
  readonly measurable: number;
  readonly answeredInTime: number;
  readonly answeredRate: number | null;
  /** Заявок, на которые площадка ответила (выборка для времени ответа) */
  readonly responded: number;
  readonly medianResponseMinutes: number | null;
  readonly p90ResponseMinutes: number | null;
  readonly agreed: number;
  readonly agreedRate: number | null;
  /** Срок ответа вышел без ответа (нарушение SLA) */
  readonly slaBreaches: number;
  /** Уведомления, которые бот не доставил (dead) */
  readonly deadNotifications: number;
}

export interface WeeklyMetrics extends PeriodMetrics {
  /** Понедельник недели, "YYYY-MM-DD" */
  readonly weekStart: string;
  /** ISO-неделя: "2026-W40" */
  readonly weekLabel: string;
  /** Текущая неделя — ещё идёт */
  readonly partial: boolean;
}

/** Что ждёт команду сейчас */
export interface OpsQueues {
  /** Заявки ждут первого ответа */
  readonly awaiting: number;
  /** Из них срок ответа уже вышел */
  readonly overdue: number;
  /** Недоставленные уведомления (повтор — в «Уведомлениях») */
  readonly deadTotal: number;
  readonly listingsReview: number;
  readonly revisionsPending: number;
  /** Новые фото ждут решения (у любых витрин, кроме отклонённых) */
  readonly photosPending: number;
  /** Новые услуги и предложения правок услуг ждут решения — как очередь GET /staff/services */
  readonly servicesPending: number;
}

/**
 * GET /staff/metrics?weeks=8&category= (1–52): по неделям, текущая — первой; category — только
 * заявки витрин этой категории (и недоставленные уведомления по ним). Очереди — всегда все.
 * 422 invalid_input ["weeks"] | ["category"]
 */
export interface MetricsOverview {
  /** Срок ответа для новых заявок (sla_hours), часов */
  readonly slaHours: number;
  /** Фильтр категории; null — все */
  readonly category: string | null;
  readonly weeks: readonly WeeklyMetrics[];
  readonly queues: OpsQueues;
}

/** Сводка категории за последние N дней */
export interface CategoryMetrics extends ResponseStats {
  readonly categoryCode: string;
  /** Опубликованные витрины категории сейчас */
  readonly activeListings: number;
  /** Вендоры с опубликованной витриной в категории сейчас */
  readonly activeVendors: number;
  readonly clients: number;
  readonly p90ResponseMinutes: number | null;
  readonly agreedRate: number | null;
}

/**
 * GET /staff/metrics/categories?days=30 (1–366): включённые категории и те, где были заявки,
 * по порядку категорий; 422 invalid_input ["days"]
 */
export interface CategoryMetricsList {
  readonly days: number;
  readonly items: readonly CategoryMetrics[];
}

/** Ответы площадки за последние N дней */
export interface ResponseStats {
  readonly requests: number;
  readonly measurable: number;
  readonly answeredInTime: number;
  readonly answeredRate: number | null;
  readonly responded: number;
  readonly medianResponseMinutes: number | null;
  readonly slaBreaches: number;
  readonly agreed: number;
  readonly lastRequestAt: string | null;
}

export interface VendorMetrics extends ResponseStats {
  readonly vendor: { readonly id: string; readonly code: string; readonly name: string | null };
  /** Опубликованные витрины (с фильтром — этой категории) */
  readonly activeListings: number;
  /**
   * Категории витрин вендора — опубликованных, приостановленных и с заявками за период, по
   * порядку категорий
   */
  readonly categories: readonly string[];
}

/**
 * GET /staff/metrics/vendors?days=30&category= (1–366): вендоры с заявками за период или с
 * опубликованной площадкой; category — только заявки и витрины этой категории.
 * 422 invalid_input ["days"] | ["category"]
 */
export interface VendorMetricsList {
  readonly days: number;
  /** Фильтр категории; null — все */
  readonly category: string | null;
  readonly items: readonly VendorMetrics[];
}

export interface ListingMetrics extends ResponseStats {
  readonly listing: {
    readonly id: string;
    readonly name: string;
    readonly status: ListingStatus;
    readonly categoryCode: string;
  };
}

/**
 * GET /staff/metrics/contacts?days=30&category= (1–366): у каких витрин чаще открывают контакты
 * («Связаться» на витрине и после заявки) — без клиентов, только числа. opens — открыли окно
 * контактов, phone / telegram — нажали «Позвонить» / «Написать в Telegram». Сверху — больше
 * открытий; не больше 50 витрин. 422 invalid_input ["days"] | ["category"]
 */
export interface ContactMetrics {
  readonly days: number;
  readonly category: string | null;
  readonly items: readonly {
    readonly listing: {
      readonly id: string;
      readonly name: string;
      readonly status: ListingStatus;
      readonly categoryCode: string;
    };
    readonly vendor: { readonly id: string; readonly name: string };
    readonly opens: number;
    readonly phone: number;
    readonly telegram: number;
    /** Открытия за предыдущий такой же период — растёт интерес или падает */
    readonly opensPrev: number;
  }[];
}

/** GET /staff/metrics/vendors/:id?days=30 — вендор и его площадки; 404 — нет такого вендора */
export interface VendorResponseStats {
  readonly days: number;
  readonly vendor: VendorMetrics;
  readonly listings: readonly ListingMetrics[];
}
