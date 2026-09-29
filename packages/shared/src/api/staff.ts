/* Контракт API панели оператора: общий для apps/api (маршруты /staff/*) и apps/admin.

   Все маршруты — за сессией сотрудника (Authorization: Bearer <token> из
   POST /auth/staff/telegram), права по ролям проверяет сервер на каждом запросе.
   Суммы — целые сумы. Дни — "YYYY-MM-DD". Моменты — ISO 8601 в UTC.
   Ошибки — { error: { code, message, details? } }: для invalid_input в details — имена
   неверных полей, для publish_blocked — коды недостающих пунктов (PublishBlocker).
   Телефоны в ответах не отдаются: только отдельным запросом «показать», который
   база пишет в журнал доступа к ПДн. */

import type { DeclineReason, PriceUnit, RequestStatus } from "./client";

export type { DeclineReason, PriceUnit, RequestStatus };

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
  | "client_phones.read";

/** GET /staff/me */
export interface StaffMe {
  readonly id: string;
  readonly role: StaffRole;
  readonly displayName: string;
  readonly username: string | null;
  readonly permissions: readonly StaffPermission[];
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

/** Коды из app.listing_publish_blockers: чего не хватает для проверки или публикации */
export type PublishBlocker =
  | "price"
  | "capacity"
  | "district"
  | "descriptions"
  | "phone"
  | "packages"
  | "photos"
  | "contract"
  | "stir"
  | "contacts"
  | "pd_consent";

export interface ListingRef {
  readonly id: string;
  readonly name: string;
  readonly status: ListingStatus;
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
 * GET /staff/vendors?q=&listingStatus=&limit=&offset= — поиск по названию, коду,
 * юрназванию, контактному лицу, названию или адресу карточки, СТИР (9 цифр) и
 * телефону пользователя кабинета
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

export interface VendorUser {
  readonly id: string;
  readonly fullName: string | null;
  readonly role: "owner" | "member";
  readonly locale: "ru" | "uz";
  /** Вендор поделился контактом в боте — вход через Telegram работает */
  readonly telegramLinked: boolean;
  readonly telegramLinkedAt: string | null;
  readonly lastLoginAt: string | null;
  readonly disabledAt: string | null;
  readonly createdAt: string;
}

/** Карточка в составе вендора */
export interface ListingBrief extends ListingRef {
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
 */
export interface VendorInput {
  readonly name?: string;
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

/** POST /staff/vendors/:id/users → 201 VendorUser; 409 phone_taken */
export interface VendorUserInput {
  readonly phone: string;
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

// ── карточки (листинги) ────────────────────────────────────────────────────

export interface ListingListItem extends ListingBrief {
  readonly statusReason: string | null;
  readonly capMin: number | null;
  readonly submittedAt: string | null;
  readonly vendor: { readonly id: string; readonly code: string; readonly name: string | null };
  /** Готовые фото и из них одобренные */
  readonly photos: { readonly ready: number; readonly approved: number };
}

/** GET /staff/listings?status=&q=&vendorId=&limit=&offset= */
export interface ListingList {
  readonly total: number;
  readonly items: readonly ListingListItem[];
  /** Сколько карточек в каждом статусе (без учёта фильтров) */
  readonly counts: Readonly<Record<ListingStatus, number>>;
}

export interface StaffListingPackage {
  readonly kind: "weekday" | "weekend" | "custom";
  readonly nameRu: string;
  readonly nameUz: string;
  readonly priceUzs: number;
  readonly priceUnit: PriceUnit;
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
  readonly priceFromUzs: number | null;
  readonly priceUnit: PriceUnit;
  readonly capMin: number | null;
  readonly capMax: number | null;
  readonly submittedAt: string | null;
  readonly publishedAt: string | null;
  /** Оптимистичная блокировка: передаётся обратно в каждой правке и смене статуса */
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Телефон для заявок вписан (сам номер — только через «показать») */
  readonly hasPhone: boolean;
  readonly packages: readonly StaffListingPackage[];
  readonly photos: readonly StaffPhoto[];
  /** Чего не хватает: для отправки на проверку и для публикации */
  readonly blockers: {
    readonly review: readonly PublishBlocker[];
    readonly active: readonly PublishBlocker[];
  };
  readonly vendor: { readonly id: string; readonly code: string; readonly name: string | null };
  /** История статусов, новые сверху */
  readonly history: readonly ListingHistoryEntry[];
}

/**
 * POST /staff/listings (vendorId и name обязательны; status — lead или draft, по
 * умолчанию draft; slug — из названия, если не задан) и PATCH /staff/listings/:id
 * (version обязателен). packages заменяет набор целиком. phone: строка — записать,
 * null — убрать. 409 version_conflict — карточку изменили, перечитать; 409 slug_taken
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
  readonly priceFromUzs?: number | null;
  readonly priceUnit?: PriceUnit;
  readonly capMin?: number | null;
  readonly capMax?: number | null;
  readonly packages?: readonly StaffListingPackage[];
  readonly phone?: string | null;
}

/** Действия со статусом: POST /staff/listings/:id/<действие> → ListingDetail */
export type ListingAction = "submit" | "publish" | "suspend" | "reject" | "draft";

/**
 * Тело действия. reason обязателен для suspend и reject; для остальных — комментарий в
 * историю. 422 publish_blocked (details — PublishBlocker[]), 409 illegal_transition.
 * publish одобряет готовые фото карточки, ещё ждущие решения
 */
export interface ListingActionInput {
  readonly version: number;
  readonly reason?: string;
}

// ── фото ───────────────────────────────────────────────────────────────────

/**
 * POST /staff/listings/:id/photos — тело: файл (image/webp|jpeg|png, ≤ 10 МБ) после
 * compressForUpload; заголовок X-No-Faces: 1 — сотрудник подтвердил, что лиц на фото нет.
 * → 201 StaffPhoto. 409 too_many_photos, duplicate_photo; 413; 422 invalid_image (details — код)
 *
 * PUT    /staff/listings/:id/photos/order { ids }          → StaffPhoto[]
 * POST   /staff/listings/:id/photos/:photoId/cover         → StaffPhoto[]
 * POST   /staff/listings/:id/photos/:photoId/moderation { decision } → StaffPhoto[]
 * DELETE /staff/listings/:id/photos/:photoId               → StaffPhoto[]
 */
export interface PhotoOrderInput {
  readonly ids: readonly string[];
}

export interface PhotoModerationInput {
  readonly decision: "approved" | "declined";
}

// ── занятость ──────────────────────────────────────────────────────────────

export interface BusyDay {
  readonly day: string;
  /** vendor — отметил вендор, staff — сотрудник, request_decline — отказ по заявке «занято» */
  readonly source: "vendor" | "staff" | "request_decline";
}

/**
 * GET /staff/listings/:id/availability?from=YYYY-MM-DD&to=YYYY-MM-DD (не больше 400 дней)
 * PUT /staff/listings/:id/availability { busy: [дни], free: [дни] } — отметить и снять
 */
export interface Availability {
  readonly from: string;
  readonly to: string;
  readonly busy: readonly BusyDay[];
}

export interface AvailabilityInput {
  readonly busy?: readonly string[];
  readonly free?: readonly string[];
}

// ── заявки ─────────────────────────────────────────────────────────────────

/**
 * Состояние срока ответа (SLA):
 *   waiting       — ответа нет, срок не вышел
 *   overdue       — ответа нет, срок вышел
 *   breached      — ответа нет, срок вышел и система уже отметила нарушение (эскалация)
 *   answered      — ответ в срок
 *   answered_late — ответ после срока
 *   closed        — заявка закрыта без ответа вендора (отозвана клиентом, истекла)
 */
export type SlaState = "waiting" | "overdue" | "breached" | "answered" | "answered_late" | "closed";

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
  readonly guests: number;
  readonly createdAt: string;
  readonly listing: { readonly id: string; readonly name: string };
  readonly vendor: { readonly id: string; readonly code: string; readonly name: string | null };
}

/** GET /staff/requests?status=&sla=&q=&limit=&offset= — сначала без ответа и просроченные */
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
  /** Имя и комментарий клиента из заявки; null — удалены по сроку хранения */
  readonly contactName: string | null;
  readonly comment: string | null;
  readonly contactPurged: boolean;
  readonly history: readonly RequestHistoryEntry[];
}

/**
 * POST /staff/requests/:id/client-phone { reason } → RevealedPhone — только администратор,
 * причина обязательна (422 reason_required), чтение пишется в журнал доступа к ПДн.
 * POST /staff/requests/:id/vendor-phone { reason? } → VendorPhones & { listingPhone }
 */
export interface RequestVendorPhones extends VendorPhones {
  readonly listingPhone: string | null;
}
