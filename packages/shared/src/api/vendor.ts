/* Контракт API кабинета вендора: общий для apps/api и apps/vendor.

   Адреса — от корня API; кабинет ходит через свой /api (прокси отрезает префикс).
   Всё под /vendor/* — только с сессией аккаунта партнёра: Authorization: Bearer <token>
   из POST /auth/telegram { initData, app: "vendor" } (Mini App) или из хаба входа
   (@bayramm/shared/api/account). Чужая заявка или листинг — 404, а не 403: по ответу не
   узнать, существует ли чужое.
   Суммы — целые сумы. Даты — "YYYY-MM-DD" по Ташкенту. Моменты — ISO 8601 в UTC.
   Ошибки — { error: { code, message } } (apps/api/src/errors.ts); code стабилен.

   Вендор видит о клиенте ровно то, на что клиент дал согласие: имя, телефон и
   комментарий — пока согласие действует и заявка не отозвана. Телефон клиента
   отдаётся только в карточке заявки, и каждое такое чтение записывается в журнал. */

import type { AvailabilityMode, DayPart } from "../categories/types";
import type { AttributeValue } from "../categories/validate";
import type {
  DeclineReason,
  ListingAttributes,
  Locale,
  Localized,
  PriceUnit,
  RequestDetails,
  RequestStatus,
} from "./client";
import type { ListingService } from "./services";

export * from "./services";
export type {
  AvailabilityMode,
  DayPart,
  DeclineReason,
  ListingAttributes,
  Locale,
  Localized,
  PriceUnit,
  RequestDetails,
  RequestStatus,
};

// ── вход ───────────────────────────────────────────────────────────────────

/**
 * POST /auth/telegram { initData, app: "vendor" } — initData Mini App, открытого из бота.
 * Прежний адрес POST /auth/vendor/telegram { initData } устарел: он остаётся только для
 * старых сборок кабинета
 */
export interface VendorSignIn {
  readonly initData: string;
  readonly app: "vendor";
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

/**
 * Роль в кабинете вендора: owner — владелец кабинета, member — сотрудник площадки.
 * Заявки и календарь ведут оба; карточку (фото, предложения правок) меняет только
 * владелец — у сотрудника площадки эти кнопки скрыты, API ответит 403 vendor_owner_required
 */
export type VendorRole = "owner" | "member";

/**
 * Витрина вендора. У одного вендора бывают витрины в нескольких категориях (студия и
 * фото-видео, торты и подарки): у каждой — свои поля, услуги, фото, занятость и заявки.
 * Категорию витрины выбирает команда; партнёр её не меняет
 */
export interface VendorListingRef {
  readonly id: string;
  readonly name: string;
  readonly status: ListingStatus;
  readonly categoryCode: string;
  /** Что здесь ждёт действия партнёра — числа для значков разделов кабинета */
  readonly attention: VendorAttention;
}

/**
 * Что на витрине ждёт действия партнёра. Считает база по тому, что уже решила команда, и
 * пересчитывается на каждый GET /vendor/me: партнёр исправил — число уменьшилось.
 *   · services  — отклонённые услуги (status rejected): исправить и отправить снова или удалить;
 *                 предложение правки активной услуги, которое отклонили, не считается — услуга
 *                 на витрине как была;
 *   · photos    — отклонённые фото, которые ещё в кабинете: удалить и загрузить новые;
 *   · proposals — 1, если последнее предложение изменений витрины (подал партнёр) отклонено и
 *                 нового открытого нет; иначе 0.
 * Исправляет всё это только владелец кабинета (vendor/access.ts), поэтому у сотрудника
 * площадки (role member) везде нули — значков, которые он не может убрать, у него нет
 */
export interface VendorAttention {
  readonly services: number;
  readonly photos: number;
  readonly proposals: number;
}

/** GET /vendor/me → 200; PATCH /vendor/me { locale } → 200 VendorMe */
export interface VendorMe {
  readonly user: {
    readonly id: string;
    readonly locale: Locale;
    readonly fullName: string | null;
    readonly role: VendorRole;
  };
  readonly vendor: {
    readonly id: string;
    /** Публичный код вендора, например V101 — для разговора с менеджером */
    readonly code: string;
    readonly name: string | null;
  };
  /** Витрины вендора, старые первыми — для переключателя витрин и значков разделов в кабинете */
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
  readonly listing: { readonly id: string; readonly name: string; readonly categoryCode: string };
  readonly occasionCode: string;
  readonly eventDate: string;
  /** Число гостей; null — категория его не спрашивает или клиент не указал */
  readonly guests: number | null;
  /** Часть дня (режим parts); null — у категории её нет */
  readonly dayPart: DayPart | null;
  /**
   * Поля заявки категории: часы, машины, кг, выбранные услуги и опции (как были при подаче).
   * Без персональных данных; краткая запись строками — detailsSummary из @bayramm/shared/categories
   */
  readonly details: RequestDetails;
  readonly budgetMinUzs: number | null;
  readonly budgetMaxUzs: number | null;
  readonly createdAt: string;
  readonly sla: RequestSla;
  /**
   * Кто ответил первым (первый переход в «связались», «договорились» или отказ):
   * vendor_user — партнёр, staff — менеджер Bayramm (отметил «связались» вместо партнёра),
   * system, client — как в истории; null — ответа ещё нет. Совпадает с sla.firstResponseAt:
   * оба null или оба заполнены
   */
  readonly firstResponseBy: HistoryActor | null;
  /** Имя клиента — только пока действует согласие; иначе null */
  readonly contactName: string | null;
}

/**
 * GET /vendor/requests?tab=new&cursor=…&limit=…&listingId=… → 200. listingId — только заявки
 * этой витрины (чужая или несуществующая — пустой список).
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

/** Отметка «часть дня занята» (режим parts) */
export interface BusyPart {
  readonly day: string;
  readonly part: DayPart;
  readonly source: BusySource;
  readonly requestId: string | null;
}

/** Договорённости (заявки deal) на часть дня — сколько мест из parallelCapacity занято */
export interface PartBookings {
  readonly day: string;
  readonly part: DayPart;
  readonly count: number;
}

/**
 * GET /vendor/listings/:id/calendar?month=YYYY-MM → 200 (по умолчанию — текущий месяц).
 * requestDays — даты событий открытых заявок и сделок этого листинга в месяце.
 * Режим parts (фото и видео, кортеж, декор): день — утро, день, вечер. Часть занята, если
 * она в parts или договорённостей на неё (bookings) не меньше parallelCapacity; день занят,
 * если он в busy (весь день) или заняты все три части. У остальных режимов parts и bookings
 * пустые; у режима lead (цветы, торты, подарки) календарь клиенту не показывается.
 */
export interface VendorCalendar {
  readonly listingId: string;
  readonly mode: AvailabilityMode;
  /** Сколько заказов витрина берёт одновременно (экипажи, машины) */
  readonly parallelCapacity: number;
  readonly parts: readonly BusyPart[];
  readonly bookings: readonly PartBookings[];
  readonly month: string;
  /** Сегодня по Ташкенту: прошедшие дни не меняются */
  readonly today: string;
  /** Последний день, который можно отметить */
  readonly maxDay: string;
  readonly busy: readonly BusyDay[];
  readonly requestDays: readonly string[];
  /**
   * Версия календаря площадки (всех месяцев): растёт на каждой правке, кто бы её ни
   * сделал — партнёр, менеджер или отказ «занято». Правка передаёт её в If-Match
   */
  readonly version: number;
}

/** Заголовок правки календаря: версия, от которой правит человек */
export const CALENDAR_VERSION_HEADER = "If-Match";

/**
 * PUT    /vendor/listings/:id/calendar/:day[?part=morning|day|evening] → 200: день (или часть
 *        дня) занят (уже занятый — как есть).
 * DELETE /vendor/listings/:id/calendar/:day[?part=…] → 200: свободен (busy — null).
 * part — только у режима parts (иначе 422 invalid_input ["part"]); без part — весь день.
 * Обе — с заголовком If-Match: <version> из календаря или прошлой правки; без него —
 * 428 version_required. Календарь с тех пор изменили — 409 calendar_conflict: перечитать
 * и показать человеку, что изменилось. День, закрытый сотрудником, — 403
 * forbidden_for_actor. Прошедший день или дальше maxDay — 422 date_out_of_range.
 */
export interface VendorCalendarChange {
  readonly day: string;
  /** Часть дня правки; null — весь день */
  readonly part: DayPart | null;
  /** Отметка после правки: BusyDay (весь день) или BusyPart; null — свободно */
  readonly busy: BusyDay | BusyPart | null;
  /** Новая версия календаря — для следующей правки */
  readonly version: number;
}

/**
 * PUT /vendor/listings/:id/calendar/capacity { parallelCapacity } (1–50), If-Match: <version>
 * → 200 VendorCapacityChange. Сколько заказов витрина берёт одновременно — часть календаря:
 * менять может любой пользователь вендора, версия календаря растёт
 */
export interface VendorCapacityInput {
  readonly parallelCapacity: number;
}

export interface VendorCapacityChange {
  readonly parallelCapacity: number;
  readonly version: number;
}

// ── площадка ───────────────────────────────────────────────────────────────

/**
 * Фото площадки. pending — ждёт решения модератора: клиенты его не видят, пока его не
 * одобрят (или пока не опубликуют карточку целиком); declined — отклонено, клиенты его
 * не видят, его можно удалить
 */
export interface VendorPhoto {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly moderation: "pending" | "approved" | "declined";
  /** Почему модератор отклонил фото; null — не отклонено или причина не записана */
  readonly declineReason: string | null;
  readonly isCover: boolean;
  /** Вариант 640 px с воркера media */
  readonly src: string;
  readonly srcSet: string;
}

/**
 * Фото из кабинета — только владелец кабинета (иначе 403 vendor_owner_required):
 *
 * POST   /vendor/listings/:id/photos — тело: файл (image/webp|jpeg|png, ≤ 10 МБ) после
 *        compressForUpload (@bayramm/media/browser: перекодирование, без EXIF и GPS);
 *        подтверждение по правилу фото категории (photoPolicy в @bayramm/shared/categories):
 *          · no_people — заголовок X-No-Faces: 1: лиц на фото нет (без него — 422
 *            no_faces_ack_required);
 *          · portfolio (фото и видео, студия) — X-Photo-Consent: 1: люди на фото согласны на
 *            публикацию, или X-No-Faces: 1 (без обоих — 422 photo_consent_required).
 *        → 201 VendorPhoto (moderation: pending).
 *        409 too_many_photos, duplicate_photo; 413 payload_too_large; 422 invalid_image
 *        (details — код проверки файла); 503 storage_unavailable.
 * DELETE /vendor/listings/:id/photos/:photoId → 204. Опубликованная площадка не останется
 *        без минимума одобренных фото — 422 publish_blocked (details: photos).
 *
 * Порядок и обложку выбирает команда при модерации. Чужая площадка или фото — 404.
 */
export const NO_FACES_HEADER = "X-No-Faces";

/** Подтверждение согласия людей на фото — у категорий с правилом portfolio */
export const PHOTO_CONSENT_HEADER = "X-Photo-Consent";

/**
 * GET /vendor/listings/:id → 200: витрина как есть в базе — то, что видит клиент (плюс фото
 * и услуги, которые ждут решения или отклонены, — с отметкой статуса).
 * Название, описания, поля витрины и ссылки на видео партнёр меняет предложением правки
 * (ниже), услуги — своими маршрутами (ниже), фото — загрузкой (выше): их проверяет команда.
 * Цена «от» — из одобренных услуг (до публикации — и из отправленных на проверку). Адрес,
 * вместимость и телефон меняет менеджер. blockers — чего не хватает для публикации (коды из
 * базы: price, attributes, photos, …), missingAttributes — какие поля витрины не заполнены.
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
  /** Поля витрины категории */
  readonly attributes: ListingAttributes;
  /** Обязательные поля витрины без значения */
  readonly missingAttributes: readonly string[];
  /** Ссылки на видео (YouTube, Instagram) */
  readonly videoLinks: readonly string[];
  /** Сколько заказов витрина берёт одновременно (режим parts) */
  readonly parallelCapacity: number;
  /** Услуги витрины по порядку — все статусы */
  readonly services: readonly ListingService[];
  readonly photos: readonly VendorPhoto[];
  /** Телефон для заявок, который клиент видит сразу */
  readonly phone: string | null;
  readonly blockers: readonly string[];
  /** Сколько фото нужно для публикации (по категории) и сколько можно загрузить всего */
  readonly photoLimits: { readonly min: number; readonly max: number };
}

/*
 * Услуги витрины — только владелец кабинета (403 vendor_owner_required). Контракт полей —
 * ServiceInput, ответ — ListingService (@bayramm/shared/api/services):
 *
 * GET    /vendor/listings/:id/services                        → 200 ListingServices
 * POST   /vendor/listings/:id/services       ServiceInput     → 201 ListingService — на проверку
 *        (review) или черновиком (submit: false). 422 invalid_input — поля; 409 too_many_services.
 * PATCH  /vendor/listings/:id/services/:sid  ServiceInput     → 200 ListingService:
 *          · черновик, на проверке, отклонённая — правится сразу (и уходит на проверку, если
 *            submit не false);
 *          · активная или снятая у опубликованной витрины — изменённые поля уходят предложением
 *            (proposal), клиент видит прежнее; ничего не изменилось — 422 no_changes.
 * POST   /vendor/listings/:id/services/:sid/submit            → 200: черновик, отклонённая или
 *        снятая — на проверку.
 * POST   /vendor/listings/:id/services/:sid/withdraw          → 200: на проверке — обратно в
 *        черновик; с предложением правки — предложение отозвано; активная — снята с витрины
 *        (последнюю услугу с ценой опубликованной витрины снять нельзя — 422 publish_blocked).
 * DELETE /vendor/listings/:id/services/:sid                   → 204: только не активная.
 * Недопустимый шаг — 409 illegal_transition; правка активной не предложением — 409
 * moderated_field_requires_revision. Чужая витрина или услуга — 404.
 */

// ── правки карточки ────────────────────────────────────────────────────────

export type RevisionStatus = "pending" | "approved" | "declined" | "withdrawn";

/**
 * Правка карточки от партнёра (app.listing_revisions.payload): только эти ключи, как
 * столбцы базы; нет ключа — поле не меняется. Цен в правке нет — они в услугах.
 *   · attributes — изменённые поля витрины: { ключ: значение | null } (null — убрать);
 *   · video_links — ссылки на видео целиком (YouTube, Instagram; не больше maxVideoLinks).
 */
export interface ListingRevisionPayload {
  readonly name?: string;
  readonly description_ru?: string;
  readonly description_uz?: string;
  readonly attributes?: Readonly<Record<string, AttributeValue | null>>;
  readonly video_links?: readonly string[];
}

/** Ключи правки в порядке показа */
export const REVISION_KEYS = [
  "name",
  "description_ru",
  "description_uz",
  "attributes",
  "video_links",
] as const satisfies readonly (keyof ListingRevisionPayload)[];

/** Предложение правки глазами партнёра */
export interface VendorRevision {
  readonly id: string;
  /** pending — ждёт решения команды; approved — применено к карточке; withdrawn — отозвано */
  readonly status: RevisionStatus;
  readonly submittedAt: string;
  readonly decidedAt: string | null;
  /** Почему отклонили — пишет сотрудник для партнёра; только у declined */
  readonly decisionReason: string | null;
  /** Что предложено: только изменённые поля */
  readonly payload: ListingRevisionPayload;
  /** Предложила команда Bayramm (менеджер), а не партнёр: отозвать его нельзя, решает модератор */
  readonly byTeam: boolean;
}

/**
 * GET /vendor/listings/:id/revisions → 200: последние 10 предложений, новые первыми. Решённые
 *   (approved, declined — с причиной отказа) — история решений: кабинет показывает последние пять.
 * POST /vendor/listings/:id/revisions ListingRevisionPayload → 201 VendorRevision.
 *   В правку попадают только поля, которые отличаются от карточки; ничего не
 *   изменилось — 422 no_changes; неверные поля — 422 invalid_input (details — ключи,
 *   у полей витрины — attributes.<поле>…). Открытое предложение уже есть — 409
 *   revision_pending: одно на площадку, его можно отозвать.
 * POST /vendor/listings/:id/revisions/:revisionId/withdraw → 200 VendorRevision;
 *   по предложению уже решили — 409 illegal_transition; его предложила команда — 403
 *   forbidden_for_actor.
 * Подать и отозвать предложение может только владелец кабинета (403 vendor_owner_required).
 */
export interface VendorRevisionList {
  readonly items: readonly VendorRevision[];
}

/** Длина описания на одном языке */
export const DESCRIPTION_MAX = 4000;
