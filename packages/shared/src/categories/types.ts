/* Типы конфигурации категорий. Описание — в config.ts; что из него следует для базы,
   API и интерфейсов — в index.ts. Подписи — ключи словаря категорий (i18n/categories),
   поэтому опечатка в ключе не скомпилируется. */

import type { CategoryTextKey } from "../i18n/categories";

/** Коды категорий. Тот же набор — в app.categories (сид миграции; тест сверяет) */
export const CATEGORY_CODES = [
  "hall",
  "car",
  "studio",
  "flowers",
  "photo",
  "cake",
  "gifts",
  "decor",
  "food",
  "restaurant",
  "attire",
  "music",
  "kids",
  "zags",
] as const;
export type CategoryCode = (typeof CATEGORY_CODES)[number];

/** Единицы цены — как перечисление app.price_unit */
export const PRICE_UNITS = [
  "per_guest",
  "per_event",
  "per_hour",
  "per_item",
  "per_kg",
  "per_set",
  "per_table",
] as const;
export type PriceUnit = (typeof PRICE_UNITS)[number];

/**
 * Модель занятости:
 *   day   — календарь «день занят / свободен» (залы);
 *   parts — день делится на части (утро, день, вечер), у карточки — сколько заказов она
 *           берёт одновременно (parallelCapacity: экипажи, машины). Часть занята, когда
 *           договорённостей на неё столько же, сколько мест, или вендор отметил её занятой;
 *           день занят, когда заняты все части или вендор отметил весь день;
 *   slot  — тот же календарь, что day; время и часы приходят в заявке (студия);
 *   lead  — календаря нет, заказ не позже чем за N дней (цветы, торты, подарки)
 */
export const AVAILABILITY_MODES = ["day", "parts", "slot", "lead"] as const;
export type AvailabilityMode = (typeof AVAILABILITY_MODES)[number];

/** Части дня — для модели parts. Тот же набор — в app.day_part */
export const DAY_PARTS = ["morning", "day", "evening"] as const;
export type DayPart = (typeof DAY_PARTS)[number];

/** Окно части дня по Ташкенту: [from, to), «ЧЧ:ММ»; to = "24:00" — до полуночи */
export interface DayPartWindow {
  readonly from: string;
  readonly to: string;
}

export type DayPartWindows = Readonly<Record<DayPart, DayPartWindow>>;

/**
 * Правило фото: no_people — на фото нет людей (подтверждение «без лиц», X-No-Faces);
 * portfolio — люди допустимы, загрузивший подтверждает согласие людей на снимке
 * (X-Photo-Consent)
 */
export const PHOTO_POLICIES = ["no_people", "portfolio"] as const;
export type PhotoPolicy = (typeof PHOTO_POLICIES)[number];

/** Уровень типа услуги: base | extra — точка для будущей проверки тарифа (app.service_allowed) */
export const SERVICE_TIERS = ["base", "extra"] as const;
export type ServiceTier = (typeof SERVICE_TIERS)[number];

/**
 * Обязательные для публикации поля карточки (столбцы app.listings), кроме общих:
 * guest_capacity — вместимость в гостях (cap_min, cap_max), district — район
 */
export const LISTING_FIELDS = ["guest_capacity", "district"] as const;
export type ListingField = (typeof LISTING_FIELDS)[number];

/** Вариант выбора: код хранится, подпись — ключ словаря */
export interface Choice {
  readonly code: string;
  readonly label: CategoryTextKey;
}

// ── поля витрины (app.listings.attributes) ──────────────────────────────────

interface FieldBase {
  /** Ключ в JSON: [a-z][a-z0-9_]* */
  readonly key: string;
  readonly label: CategoryTextKey;
  /** Без значения карточку не опубликовать (блокер attributes) */
  readonly required: boolean;
}

/** Целое в границах. filter: min — «не меньше запроса» (площадь), max — «не больше» (срок) */
export interface IntField extends FieldBase {
  readonly type: "int";
  readonly min: number;
  readonly max: number;
  readonly filter?: "min" | "max";
}

/** Да / нет. filter: eq — «только где да» */
export interface BoolField extends FieldBase {
  readonly type: "bool";
  readonly filter?: "eq";
}

/** Один вариант. filter: any — любой из выбранных */
export interface EnumField extends FieldBase {
  readonly type: "enum";
  readonly options: readonly Choice[];
  readonly filter?: "any";
}

/** Несколько вариантов. filter: any — есть хоть один из выбранных, all — есть все */
export interface MultiField extends FieldBase {
  readonly type: "multi";
  readonly options: readonly Choice[];
  readonly filter?: "any" | "all";
}

/**
 * Текст. localized — на двух языках ({ ru, uz }, обязательный — оба), иначе одна строка
 * (марка машины, часы работы). Фильтра по тексту нет
 */
export interface TextField extends FieldBase {
  readonly type: "text";
  readonly maxLength: number;
  readonly localized: boolean;
}

/** Поле элемента списка: без вложенных списков и без текста на двух языках */
export type ListItemField = IntField | BoolField | EnumField | (TextField & { readonly localized: false });

/** Список однотипных записей (автопарк). Фильтры — по полям записей: «есть хоть одна запись, где…» */
export interface ListField extends FieldBase {
  readonly type: "list";
  readonly maxItems: number;
  readonly fields: readonly ListItemField[];
}

export type AttributeField = IntField | BoolField | EnumField | MultiField | TextField | ListField;
export type AttributeType = AttributeField["type"];

// ── форма заявки (app.requests.details) ─────────────────────────────────────

/** Время «ЧЧ:ММ» по Ташкенту */
export interface TimeField extends FieldBase {
  readonly type: "time";
}

/** Район Ташкента — код из справочника районов */
export interface DistrictField extends FieldBase {
  readonly type: "district";
}

/**
 * Выбор услуг витрины: id активных услуг этой карточки, к каждой — количество и опции.
 * Названия и цены сервер берёт из базы и сохраняет в заявке как были в момент подачи
 */
export interface ServicesField extends FieldBase {
  readonly type: "services";
  /** Сколько услуг выбрать минимум (если поле обязательно) */
  readonly minItems: number;
}

export type RequestField =
  | IntField
  | BoolField
  | EnumField
  | MultiField
  | TimeField
  | DistrictField
  | ServicesField;

/**
 * Форма заявки категории. Общие поля — дата, повод, бюджет, имя, телефон, комментарий —
 * у всех; guests — число гостей: обязательно, можно не указывать или не спрашивается.
 * fields — поля категории (app.requests.details). Свободного текста в details нет: всё,
 * что клиент пишет словами (адрес, маршрут, пожелания), — в комментарии, который вендор
 * видит только по согласию
 */
export interface RequestForm {
  readonly guests: "required" | "optional" | "hidden";
  readonly fields: readonly RequestField[];
}

// ── каталог услуг (app.service_types) ───────────────────────────────────────

/** Шаблон опции: форма услуги подсказывает её вендору; цену пишет вендор */
export interface OptionTemplate {
  readonly code: string;
  readonly label: CategoryTextKey;
  readonly unit: PriceUnit;
}

export interface ServiceType {
  /** Код в категории: [a-z][a-z0-9_]* (other — «другая услуга», есть в каждой категории) */
  readonly code: string;
  readonly label: CategoryTextKey;
  /** Единицы цены, которые можно выбрать; первая — по умолчанию */
  readonly units: readonly PriceUnit[];
  readonly tier: ServiceTier;
  /**
   * Входит ли в цену «от» карточки. Мелкие дополнения (бутоньерка, дегустация) не входят:
   * иначе «от» обманывало бы. Если таких услуг у карточки нет, «от» — по всем активным
   */
  readonly inPriceFrom: boolean;
  /** Название пишет вендор (на двух языках) — у «другой услуги» */
  readonly freeName: boolean;
  readonly options: readonly OptionTemplate[];
}

// ── категория ───────────────────────────────────────────────────────────────

export interface CategoryConfig {
  readonly code: CategoryCode;
  readonly label: CategoryTextKey;
  /** Категория в каталоге. Пустую (без опубликованных карточек) клиент не показывает */
  readonly enabled: boolean;
  /** Порядок показа */
  readonly sort: number;
  readonly availability: AvailabilityMode;
  /**
   * Окна частей дня (модель parts): по ним время начала из заявки переводится в часть
   * дня. Нет — DEFAULT_DAY_PARTS
   */
  readonly dayParts?: DayPartWindows;
  readonly photoPolicy: PhotoPolicy;
  /** Минимум одобренных фото для публикации — не меньше 3 (правило продукта) */
  readonly minPhotos: number;
  /** Сколько фото советовать (форма загрузки) — не меньше minPhotos */
  readonly recommendedPhotos: number;
  /** Сколько ссылок на видео (YouTube, Instagram) можно указать; 0 — нельзя */
  readonly maxVideoLinks: number;
  /** Обязательные столбцы карточки сверх общих (описания, телефон, цена, фото) */
  readonly listingFields: readonly ListingField[];
  readonly attributes: readonly AttributeField[];
  readonly requestForm: RequestForm;
  readonly services: readonly ServiceType[];
  /** Типы услуг, без которых карточку не опубликовать (блокер packages; у зала — банкеты) */
  readonly requiredServices: readonly string[];
}
