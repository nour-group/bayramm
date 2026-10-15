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

import type { AvailabilityMode, DayPart, DaySessions, PartMode } from "../categories/types";
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
import type { RevisionField } from "./staff";

export * from "./services";
export type {
  AvailabilityMode,
  DayPart,
  DaySessions,
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

/**
 * Вкладки входящих: ждут ответа · в работе · закрытые. «Ждут ответа» — и новые, и уже
 * открытые (просмотренные): открыть заявку — не ответить, она остаётся там, пока партнёр не
 * связался или не отказал. Прежнее имя вкладки new API ещё принимает (старые сборки кабинета)
 */
export const REQUEST_TABS = ["waiting", "active", "closed"] as const;
export type RequestTab = (typeof REQUEST_TABS)[number];

export const TAB_STATUSES: Readonly<Record<RequestTab, readonly RequestStatus[]>> = {
  waiting: ["new", "viewed"],
  active: ["contacted"],
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
  /** Части дня заявки; пусто — весь день (у категорий без календаря — не про время) */
  readonly dayParts: readonly DayPart[];
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
 * GET /vendor/requests?tab=waiting&cursor=…&limit=…&listingId=… → 200. listingId — только заявки
 * этой витрины (чужая или несуществующая — пустой список).
 * Порядок: «Ждут ответа» и «В работе» — сначала ждущие ответа, по сроку ответа (ближайший и
 * просроченный сверху), затем ответившие; «Закрытые» — новые сверху.
 * cursor — непрозрачная строка из nextCursor той же вкладки.
 * counts — сколько заявок в каждой вкладке (подписи вкладок и значок раздела «Заявки»);
 * overdue — сколько из ждущих ответа уже без ответа дольше срока: по всем вкладкам, а не по
 * открытой (плашка «больше 12 часов без ответа» над любой вкладкой).
 */
export interface VendorRequestPage {
  readonly items: readonly VendorRequestItem[];
  readonly nextCursor: string | null;
  readonly counts: Readonly<Record<RequestTab, number>>;
  readonly overdue: number;
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

/**
 * POST /vendor/requests/:id/undo → 200 VendorRequestItem: отменить «Я связался с клиентом»,
 * нажатое по ошибке. Только в первые VENDOR_UNDO_SECONDS после отметки и только тот же
 * пользователь кабинета: заявка возвращается в прежний статус (новая или просмотренная),
 * срок ответа снова идёт, сообщение клиенту (оно ждёт конца этого окна) не уходит, в метриках
 * отменённая отметка ответом не считается. Иначе — 409 undo_expired
 */
export const VENDOR_UNDO_SECONDS = 30;

// ── календарь ──────────────────────────────────────────────────────────────

/** vendor — отметил вендор; request_decline — отказ «занято»; staff — закрыл сотрудник */
export type BusySource = "vendor" | "request_decline" | "staff";

export interface BusyDay {
  readonly day: string;
  readonly source: BusySource;
  readonly requestId: string | null;
}

/** Отметка «часть дня занята» */
export interface BusyPart {
  readonly day: string;
  readonly part: DayPart;
  readonly source: BusySource;
  readonly requestId: string | null;
}

/**
 * Договорённости (заявки deal) на часть дня — сколько мест из parallelCapacity занято. Заявка на
 * весь день и любая заявка витрины с одним мероприятием в день — в каждой части
 */
export interface PartBookings {
  readonly day: string;
  readonly part: DayPart;
  readonly count: number;
}

/** Открытая заявка или договорённость на день календаря — ссылка из дня на заявку */
export interface CalendarRequest {
  readonly id: string;
  readonly publicNo: number;
  readonly day: string;
  /** Части заявки; пусто — весь день */
  readonly parts: readonly DayPart[];
  readonly status: RequestStatus;
}

/** День и часть дня — для правки нескольких дней сразу */
export interface DayPartRef {
  readonly day: string;
  readonly part: DayPart;
}

/**
 * GET /vendor/listings/:id/calendar?month=YYYY-MM → 200 (по умолчанию — текущий месяц).
 * requestDays — даты событий открытых заявок и сделок этого листинга в месяце, requests — сами
 * заявки с частями дня (без данных клиента).
 * День делится на утро, день и вечер (sessions: в каких частях витрина работает, окна, одно
 * мероприятие в день или несколько). Часть занята, если она в parts, день в busy или
 * договорённостей на неё (bookings) не меньше parallelCapacity; в режиме whole занятая часть —
 * весь день. День занят, если заняты все рабочие части. У режима lead (цветы, торты, подарки)
 * календарь клиенту не показывается, parts и bookings пустые.
 */
export interface VendorCalendar {
  readonly listingId: string;
  readonly mode: AvailabilityMode;
  /** Сколько заказов витрина берёт одновременно (то же, что sessions.parallelCapacity) */
  readonly parallelCapacity: number;
  /** Время работы витрины */
  readonly sessions: DaySessions;
  readonly parts: readonly BusyPart[];
  readonly bookings: readonly PartBookings[];
  readonly month: string;
  /** Сегодня по Ташкенту: прошедшие дни не меняются */
  readonly today: string;
  /** Последний день, который можно отметить */
  readonly maxDay: string;
  readonly busy: readonly BusyDay[];
  readonly requestDays: readonly string[];
  readonly requests: readonly CalendarRequest[];
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
 * part — только рабочая часть витрины с несколькими мероприятиями в день (иначе 422
 * invalid_input ["part"]); без part — весь день.
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
 * PUT /vendor/listings/:id/calendar { busy, free, busyParts, freeParts }, If-Match: <version> →
 * 200 VendorCalendarBatchResult: несколько дней одной правкой (не больше 400 отметок) — закрыть
 * или открыть весь день или одну часть, например все вечера суббот месяца. Части — только
 * рабочие (иначе 422 invalid_input ["busyParts"]); прошедший день или дальше maxDay — 422
 * date_out_of_range. Отметки, поставленные менеджером, «открыть» не снимает — они в skipped
 */
export interface VendorCalendarBatch {
  readonly busy?: readonly string[];
  readonly free?: readonly string[];
  readonly busyParts?: readonly DayPartRef[];
  readonly freeParts?: readonly DayPartRef[];
}

export interface VendorCalendarBatchResult {
  /** Первый и последний день правки: отметки и договорённости ниже — на этом отрезке */
  readonly from: string;
  readonly to: string;
  readonly busy: readonly BusyDay[];
  readonly parts: readonly BusyPart[];
  readonly bookings: readonly PartBookings[];
  /** Сколько отметок менеджера осталось на месте («открыть» их не снимает) */
  readonly skipped: number;
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

/**
 * PUT /vendor/listings/:id/day-sessions DaySessionsInput, If-Match: <версия календаря> → 200
 * DaySessionsChange. «Время работы» витрины: одно мероприятие в день или несколько, рабочие
 * части, свои окна и заказов одновременно — сразу, без модерации, как календарь. Меняет только
 * владелец кабинета (сотрудник площадки — 403 vendor_owner_required). Ошибки полей — 422
 * invalid_input (details — mode, parts, windows.<часть>, parallelCapacity). Убрать часть, на
 * которую есть будущие заявки (новые, в работе, договорённости), нельзя — 409 part_in_use
 * { inUse: [{ part, count }] }; перейти на одно мероприятие в день можно всегда
 */
export interface DaySessionsInput {
  readonly mode: PartMode;
  readonly parts: readonly DayPart[];
  /** Свои окна частей («ЧЧ:ММ»); null — окна категории */
  readonly windows: Readonly<Partial<Record<DayPart, { readonly from: string; readonly to: string }>>> | null;
  readonly parallelCapacity: number;
}

export interface DaySessionsChange {
  readonly sessions: DaySessions;
  /** Новая версия календаря */
  readonly version: number;
}

/** Тело 409 part_in_use: сколько будущих заявок в каждой убираемой части */
export interface PartInUse {
  readonly part: DayPart;
  readonly count: number;
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
 * PUT    /vendor/listings/:id/photos/order { ids } → 200 VendorPhotoList: порядок одобренных фото —
 *        ids — все одобренные фото витрины (не удалённые), без лишних и пропущенных, обложка
 *        остаётся первой; ждущие решения и отклонённые фото не затрагиваются. 422 invalid_input
 *        (ids) — набор не тот.
 * POST   /vendor/listings/:id/photos/:photoId/cover → 200 VendorPhotoList: обложка — одобренное
 *        фото (первым в порядке); ждущее и отклонённое — 422 invalid_input.
 * Порядок и обложка применяются сразу, без проверки; новые фото встают в конец. Чужая площадка
 * или фото — 404.
 */
export const NO_FACES_HEADER = "X-No-Faces";

/** Подтверждение согласия людей на фото — у категорий с правилом portfolio */
export const PHOTO_CONSENT_HEADER = "X-Photo-Consent";

/** Ответ порядка и обложки: фото витрины в новом порядке (обложка первой) */
export interface VendorPhotoList {
  readonly photos: readonly VendorPhoto[];
}

/**
 * Смена публичных телефона и Telegram витрины, которая на проверке или на сайте: запрос ждёт
 * решения команды, клиенты видят прежние контакты (телефон виден сразу — «Связаться»).
 *   · pending — ждёт решения; phone и telegram — что просили (только владельцу кабинета: у
 *     сотрудника площадки null);
 *   · declined — отклонён, reason — причина от команды; прежние контакты остаются.
 * Одобренный и отозванный запросы не показываются: контакты витрины — уже новые или прежние.
 */
export interface VendorContactChange {
  readonly status: "pending" | "declined";
  readonly submittedAt: string;
  readonly decidedAt: string | null;
  readonly reason: string | null;
  readonly phone: string | null;
  readonly telegram: string | null;
}

/** Тело PUT /vendor/listings/:id/contacts: телефон обязателен (+998…), Telegram — имя, @name или t.me/name */
export interface VendorContactsInput {
  readonly phone: string;
  /** null или пусто — Telegram у витрины не нужен */
  readonly telegram?: string | null;
}

/**
 * Ответ PUT /vendor/listings/:id/contacts: sentForModeration — витрина на проверке или на сайте,
 * изменение ушло запросом (listing.contactChange — «на проверке»); иначе контакты сохранены сразу
 */
export interface VendorContactsSave {
  readonly sentForModeration: boolean;
  readonly listing: VendorListing;
}

/**
 * GET /vendor/listings/:id → 200: витрина как есть в базе — то, что видит клиент (плюс фото
 * и услуги, которые ждут решения или отклонены, — с отметкой статуса).
 * Название, описания, поля витрины и ссылки на видео партнёр меняет предложением правки
 * (ниже), услуги — своими маршрутами (ниже), фото — загрузкой (выше): их проверяет команда.
 * Цена «от» — из одобренных услуг (до публикации — и из отправленных на проверку). Адрес и
 * вместимость меняет менеджер; телефон и Telegram — владелец кабинета (контакты, ниже). blockers — чего не хватает для публикации (коды из
 * базы: price, attributes, photos, …), reviewBlockers — чего не хватает, чтобы отправить
 * витрину на проверку (услуги и фото, которые ждут решения, тут засчитываются),
 * missingAttributes — какие поля витрины не заполнены.
 *
 * POST /vendor/listings/:id/submit → 200 VendorListing (status review): владелец кабинета
 * отправляет черновик (и отклонённую — через черновик) на проверку команде, команде —
 * оповещение. Не черновик и не отклонённая — 409 illegal_transition; не всё готово — 422
 * publish_blocked (details — коды reviewBlockers); сотруднику площадки — 403
 * vendor_owner_required. Чужая витрина — 404.
 *
 * POST /vendor/listings/:id/withdraw → 200 VendorListing (status draft): владелец кабинета
 * отзывает витрину с проверки (review → draft) и снова правит её напрямую; очередь проверки у
 * команды её больше не содержит. Не на проверке — 409 illegal_transition; сотруднику площадки —
 * 403 vendor_owner_required.
 *
 * Контакты (только владелец кабинета; телефон и Telegram витрины — те, что клиент видит по
 * «Связаться»):
 * PUT  /vendor/listings/:id/contacts VendorContactsInput → 200 VendorContactsSave. Витрина вне
 *      сайта (черновик, отклонённая) — контакты сохраняются сразу; на проверке, опубликованная
 *      или приостановленная — запросом (одна ждущая строка, новый заменяет прежний), клиенты
 *      до решения команды видят прежние. Телефон у витрины обязателен, Telegram — нет. 422
 *      invalid_input (phone | telegram), no_changes — значения те же, что сейчас.
 * POST /vendor/listings/:id/contact-change/withdraw → 200 VendorListing: отозвать ждущий запрос;
 *      ждущего нет — 409 contact_change_not_pending.
 * Решение команды — уведомление владельцам кабинета; отказ с причиной — listing.contactChange.
 */
export interface VendorListing {
  readonly id: string;
  /** Версия карточки: PATCH /vendor/listings/:id сохраняет, только если её с тех пор не меняли */
  readonly version: number;
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
  /** Сколько заказов витрина берёт одновременно */
  readonly parallelCapacity: number;
  /** Время работы витрины (режим, рабочие части, окна, заказов одновременно) */
  readonly daySessions: DaySessions;
  /** Версия календаря витрины: правка времени работы идёт от неё (If-Match) */
  readonly calendarVersion: number;
  /** Услуги витрины по порядку — все статусы */
  readonly services: readonly ListingService[];
  readonly photos: readonly VendorPhoto[];
  /** Телефон для заявок, который клиент видит сразу */
  readonly phone: string | null;
  /** Telegram витрины для клиентов (имя без @); null — не указан */
  readonly telegram: string | null;
  /** Запрос на смену телефона и Telegram: ждёт решения или отклонён; null — запроса нет */
  readonly contactChange: VendorContactChange | null;
  readonly blockers: readonly string[];
  /** Чего не хватает, чтобы отправить на проверку (POST …/submit) */
  readonly reviewBlockers: readonly string[];
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
 *            submit не false; отклонённая с submit: false становится черновиком);
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
 *   · video_links — ссылки на видео целиком (YouTube, Instagram; не больше maxVideoLinks);
 *   · cap_min, cap_max — вместимость (только у категорий с guest_capacity), cap_max не меньше cap_min;
 *   · district_code — район из справочника (только у категорий с district);
 *   · address_ru, address_uz — адрес; пустая строка — убрать.
 */
export interface ListingRevisionPayload {
  readonly name?: string;
  readonly description_ru?: string;
  readonly description_uz?: string;
  readonly attributes?: Readonly<Record<string, AttributeValue | null>>;
  readonly video_links?: readonly string[];
  readonly cap_min?: number;
  readonly cap_max?: number;
  readonly district_code?: string;
  readonly address_ru?: string;
  readonly address_uz?: string;
}

/** Ключи правки в порядке показа */
export const REVISION_KEYS = [
  "name",
  "description_ru",
  "description_uz",
  "attributes",
  "video_links",
  "cap_min",
  "cap_max",
  "district_code",
  "address_ru",
  "address_uz",
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

/**
 * PATCH /vendor/listings/:id VendorListingPatch → 200 VendorListingSaved. Одно правило: пока
 * витрины нет на сайте (lead, draft, rejected) — всё сохраняется сразу; на проверке, в
 * каталоге и приостановленная (review, active, suspended) — изменённые поля уходят
 * предложением (то же, что POST …/revisions), клиенты видят прежнее до решения команды;
 * sentForModeration — какие поля ушли предложением (пусто — всё сохранено). Только владелец
 * кабинета (403 vendor_owner_required). version — из VendorListing: карточку с тех пор
 * меняли — 409 version_conflict (перечитать). Ничего не изменилось — 422 no_changes;
 * неверные поля — 422 invalid_input (details: name, descriptionRu, districtCode, addressRu,
 * capMin, capMax, attributes.<поле>…, videoLinks.<номер>); поле, которого у категории нет
 * (вместимость без guest_capacity, район без district), и неизвестные ключи — тоже.
 * Открытое предложение уже есть — 409 revision_pending. Адрес страницы, категорию и цену партнёр
 * не меняет (цена — в услугах).
 */
export interface VendorListingPatch {
  readonly version: number;
  readonly name?: string;
  /** Пустая строка — убрать (у витрины на сайте нельзя: она без описания не готова) */
  readonly descriptionRu?: string;
  readonly descriptionUz?: string;
  readonly districtCode?: string;
  /** Пустая строка — убрать */
  readonly addressRu?: string;
  readonly addressUz?: string;
  /** Гостей от (1–5000) */
  readonly capMin?: number;
  /** Гостей до (1–5000), не меньше capMin */
  readonly capMax?: number;
  /** Изменённые поля витрины: { ключ: значение | null } */
  readonly attributes?: Readonly<Record<string, AttributeValue | null>>;
  /** Ссылки на видео целиком */
  readonly videoLinks?: readonly string[];
}

export interface VendorListingSaved {
  /** Витрина как GET /vendor/listings/:id после сохранения */
  readonly listing: VendorListing;
  /** Какие поля ушли предложением на проверку (RevisionField панели); пусто — всё сохранено */
  readonly sentForModeration: readonly RevisionField[];
}

/** Длина описания на одном языке */
export const DESCRIPTION_MAX = 4000;
