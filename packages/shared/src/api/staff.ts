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
  | "requests.write"
  | "client_phones.read"
  | "clients.read"
  | "clients.block"
  | "outbox.read"
  | "outbox.retry"
  | "audit.read"
  | "settings.write"
  | "team.manage"
  | "revisions.moderate";

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

/**
 * POST /staff/vendors/:id/users → 201 VendorUser; 409 phone_taken.
 * PATCH …/users/:userId (409 user_linked — номер привязанного не сменить),
 * POST …/users/:userId/disable | enable | unlink (снять привязку Telegram) → VendorUser
 */
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
  readonly guests: number;
  readonly createdAt: string;
  readonly listing: { readonly id: string; readonly name: string };
  readonly vendor: { readonly id: string; readonly code: string; readonly name: string | null };
  /** Сколько раз вендору напоминали (автоматически и сотрудники) */
  readonly reminders: number;
}

/**
 * GET /staff/requests?status=&sla=&q=&limit=&offset= — сначала без ответа: ближайший (или
 * самый давний) срок первым. sla=late — очередь просроченных и нарушенных
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
  /** Имя и комментарий клиента из заявки; null — удалены по сроку хранения */
  readonly contactName: string | null;
  readonly comment: string | null;
  readonly contactPurged: boolean;
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
 *        vendor_unreachable (никто не привязал Telegram — звонить); 429 reminder_too_soon (30 минут)
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
  /** Короткая ссылка: C- и первые 8 символов id */
  readonly ref: string;
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

export type ActorKind = "client" | "vendor_user" | "staff" | "system";

export interface AuditEntry {
  readonly id: string;
  readonly at: string;
  readonly actorKind: ActorKind;
  /** Сотрудник — с именем; остальные — только id (или null — система) */
  readonly actor: { readonly id: string; readonly name: string | null } | null;
  /** listing.update, request.remind, staff.invite … */
  readonly action: string;
  readonly objectType: string;
  readonly objectId: string;
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
  readonly actor: { readonly id: string; readonly name: string | null } | null;
  /** client, request_contact, vendor_contact, vendor_user, listing_contact */
  readonly subjectKind: string;
  readonly subjectId: string;
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
  | "session_retention_days";

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
  /** Имя пользователя Telegram, по которому пригласили (без «@») */
  readonly username: string | null;
  readonly role: StaffRole;
  readonly active: boolean;
  /** Приглашение принято: первый вход через Telegram был */
  readonly linked: boolean;
  readonly linkedAt: string | null;
  readonly createdAt: string;
  /** Это вы: себя не отключить и роль не сменить */
  readonly self: boolean;
}

/**
 * GET /staff/team → TeamList (право team.manage — только администратор).
 * POST /staff/team { username, displayName, role } → 201 TeamList; 409 username_taken.
 * POST /staff/team/:id/role { role } | /deactivate | /activate → TeamList;
 * 409 staff_self — себя нельзя, staff_last_admin — должен остаться администратор
 */
export interface TeamList {
  readonly items: readonly TeamMember[];
}

export interface TeamInviteInput {
  readonly username: string;
  readonly displayName: string;
  readonly role: StaffRole;
}

// ── правки карточек (ревизии) ──────────────────────────────────────────────

export type RevisionStatus = "pending" | "approved" | "declined" | "withdrawn";

/**
 * Правка опубликованной карточки от вендора (app.listing_revisions.payload): только эти
 * ключи, как столбцы базы; нет ключа — поле не меняется. packages заменяет набор целиком
 */
export interface ListingRevisionPayload {
  readonly name?: string;
  readonly price_from_uzs?: number;
  readonly price_unit?: PriceUnit;
  readonly description_ru?: string;
  readonly description_uz?: string;
  readonly packages?: readonly {
    readonly kind: "weekday" | "weekend" | "custom";
    readonly name_ru: string;
    readonly name_uz: string;
    readonly price_uzs: number;
    readonly price_unit?: PriceUnit;
  }[];
}

export type RevisionField =
  | "name"
  | "priceFromUzs"
  | "priceUnit"
  | "descriptionRu"
  | "descriptionUz"
  | "packages";

export type RevisionValue = string | number | null | readonly StaffListingPackage[];

export interface RevisionChange {
  readonly field: RevisionField;
  /** Сейчас в карточке */
  readonly before: RevisionValue;
  /** Предлагает вендор */
  readonly after: RevisionValue;
}

export interface RevisionListItem {
  readonly id: string;
  readonly status: RevisionStatus;
  readonly submittedAt: string;
  readonly decidedAt: string | null;
  readonly listing: { readonly id: string; readonly name: string; readonly status: ListingStatus };
  readonly vendor: { readonly id: string; readonly code: string; readonly name: string | null };
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
