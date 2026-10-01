/* Проверки по конфигурации категорий — общие для API и интерфейсов. Ничего не знают
   о базе: что услуга принадлежит карточке, район есть в справочнике, решает API.

   Ошибки — пути полей: «attributes.fleet.0.class», «details.hours», «options.2.priceUzs».
   API отдаёт их в details ответа 422 invalid_input / 400 invalid_request, форма по ним
   подсвечивает поля. Строки обрезаются по краям; управляющие символы не принимаются. */

import type { CategoryTextKey } from "../i18n/categories";
import { CATEGORIES } from "./config";
import {
  type AttributeField,
  type CategoryCode,
  type CategoryConfig,
  type Choice,
  type IntField,
  type ListItemField,
  PRICE_UNITS,
  type PriceUnit,
  type RequestField,
  type ServiceType,
} from "./types";

// ── значения ────────────────────────────────────────────────────────────────

/** Текст на двух языках; у необязательного поля язык может отсутствовать */
export interface LocalizedText {
  readonly ru?: string;
  readonly uz?: string;
}

/** Запись списка (автопарк): ключ поля → значение */
export type ListItemValue = Readonly<Record<string, number | boolean | string>>;

/**
 * Значение поля витрины: int — число, bool — да/нет, enum — код, multi — коды, text —
 * строка или { ru, uz }, list — записи
 */
export type AttributeValue =
  | number
  | boolean
  | string
  | readonly string[]
  | LocalizedText
  | readonly ListItemValue[];

/** Поля витрины карточки (app.listings.attributes) */
export type ListingAttributes = Readonly<Record<string, AttributeValue>>;

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: string[] };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T>(errors: string[]): Result<T> => ({ ok: false, errors: [...new Set(errors)] });

// ── справка по конфигурации ─────────────────────────────────────────────────

const BY_CODE: ReadonlyMap<string, CategoryConfig> = new Map(CATEGORIES.map((c) => [c.code, c]));

export function isCategoryCode(code: unknown): code is CategoryCode {
  return typeof code === "string" && BY_CODE.has(code);
}

/** Конфигурация категории; неизвестный код — undefined */
export function categoryConfig(code: string): CategoryConfig | undefined {
  return BY_CODE.get(code);
}

/** Тип услуги категории; неизвестный — undefined */
export function serviceType(category: CategoryConfig, code: string): ServiceType | undefined {
  return category.services.find((s) => s.code === code);
}

/** Единицы цены категории — объединение единиц её услуг, в порядке PRICE_UNITS */
export function categoryPriceUnits(category: CategoryConfig): PriceUnit[] {
  const used = new Set(category.services.flatMap((s) => s.units));
  return PRICE_UNITS.filter((unit) => used.has(unit));
}

/** Ключи обязательных полей витрины — тот же набор сеет миграция в app.categories */
export function requiredAttributeKeys(category: CategoryConfig): string[] {
  return category.attributes.filter((a) => a.required).map((a) => a.key);
}

export function isPriceUnit(value: unknown): value is PriceUnit {
  return typeof value === "string" && (PRICE_UNITS as readonly string[]).includes(value);
}

// ── строки ──────────────────────────────────────────────────────────────────

// Управляющие символы: в однострочном тексте — никакие, в многострочном — кроме \n и \t
const CONTROL_RE = /\p{Cc}/u;
const CONTROL_MULTILINE_RE = /[^\P{Cc}\n\t]/u;

const charLength = (value: string) => Array.from(value).length;

/** Строка после обрезки краёв, если она не пустая, без управляющих символов и не длиннее max */
function cleanText(value: unknown, max: number, multiline = false): string | null {
  if (typeof value !== "string") return null;
  const text = multiline ? value.replace(/\r\n?/g, "\n").trim() : value.trim();
  if (text === "" || charLength(text) > max) return null;
  return (multiline ? CONTROL_MULTILINE_RE : CONTROL_RE).test(text) ? null : text;
}

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

const hasCode = (options: readonly Choice[], value: unknown): value is string =>
  typeof value === "string" && options.some((o) => o.code === value);

/** Коды без повторов, все из вариантов */
function codes(options: readonly Choice[], value: unknown, max = options.length): string[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  if (!value.every((v) => hasCode(options, v))) return null;
  if (new Set(value).size !== value.length) return null;
  // Порядок — как в конфигурации: одинаковый набор хранится одинаково
  return options.map((o) => o.code).filter((code) => value.includes(code));
}

/** Текст на двух языках: { ru, uz }; required — оба языка */
function localized(value: unknown, max: number, required: boolean): LocalizedText | null {
  if (!isObject(value)) return null;
  const out: { ru?: string; uz?: string } = {};
  for (const key of Object.keys(value)) if (key !== "ru" && key !== "uz") return null;
  for (const lang of ["ru", "uz"] as const) {
    const raw = value[lang];
    if (raw === undefined || raw === null || raw === "") {
      if (required) return null;
      continue;
    }
    const text = cleanText(raw, max, true);
    if (text === null) return null;
    out[lang] = text;
  }
  return out.ru === undefined && out.uz === undefined ? null : out;
}

// ── поля витрины ────────────────────────────────────────────────────────────

function scalar(field: ListItemField | IntField, value: unknown): number | boolean | string | null {
  switch (field.type) {
    case "int":
      return isInt(value, field.min, field.max) ? value : null;
    case "bool":
      return typeof value === "boolean" ? value : null;
    case "enum":
      return hasCode(field.options, value) ? value : null;
    case "text":
      return cleanText(value, field.maxLength);
  }
}

/** Значение поля витрины или ошибки (пути — от prefix) */
function attributeValue(field: AttributeField, value: unknown, prefix: string): Result<AttributeValue> {
  switch (field.type) {
    case "int":
    case "bool":
    case "enum": {
      const v = scalar(field, value);
      return v === null ? fail([prefix]) : ok(v);
    }
    case "multi": {
      const v = codes(field.options, value);
      return v === null || v.length === 0 ? fail([prefix]) : ok(v);
    }
    case "text": {
      const v = field.localized
        ? localized(value, field.maxLength, field.required)
        : cleanText(value, field.maxLength);
      return v === null ? fail([prefix]) : ok(v);
    }
    case "list": {
      if (!Array.isArray(value) || value.length === 0 || value.length > field.maxItems) return fail([prefix]);
      const errors: string[] = [];
      const items: ListItemValue[] = [];
      value.forEach((raw, index) => {
        const path = `${prefix}.${index}`;
        if (!isObject(raw)) {
          errors.push(path);
          return;
        }
        const item: Record<string, number | boolean | string> = {};
        for (const key of Object.keys(raw)) {
          if (!field.fields.some((f) => f.key === key)) errors.push(`${path}.${key}`);
        }
        for (const sub of field.fields) {
          const v = raw[sub.key];
          if (v === undefined || v === null || v === "") {
            if (sub.required) errors.push(`${path}.${sub.key}`);
            continue;
          }
          const parsed = scalar(sub, v);
          if (parsed === null) errors.push(`${path}.${sub.key}`);
          else item[sub.key] = parsed;
        }
        items.push(item);
      });
      return errors.length > 0 ? fail(errors) : ok(items);
    }
  }
}

/**
 * Правка полей витрины: { ключ: значение | null }. null или пустое значение — убрать поле.
 * Неизвестный ключ — ошибка. Ошибки — «attributes.<ключ>[.<номер>.<поле>]»
 */
export function validateAttributePatch(
  category: CategoryConfig,
  input: unknown,
): Result<Readonly<Record<string, AttributeValue | null>>> {
  if (!isObject(input)) return fail(["attributes"]);
  const errors: string[] = [];
  const out: Record<string, AttributeValue | null> = {};
  for (const [key, value] of Object.entries(input)) {
    const field = category.attributes.find((a) => a.key === key);
    const path = `attributes.${key}`;
    if (field === undefined) {
      errors.push(path);
      continue;
    }
    if (
      value === null ||
      value === undefined ||
      value === "" ||
      (Array.isArray(value) && value.length === 0)
    ) {
      out[key] = null;
      continue;
    }
    const parsed = attributeValue(field, value, path);
    if (parsed.ok) out[key] = parsed.value;
    else errors.push(...parsed.errors);
  }
  return errors.length > 0 ? fail(errors) : ok(out);
}

/** Поля витрины после правки: null убирает поле */
export function mergeAttributes(
  current: ListingAttributes,
  patch: Readonly<Record<string, AttributeValue | null>>,
): ListingAttributes {
  const out: Record<string, AttributeValue> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = value;
  }
  return out;
}

/**
 * Поля витрины, сохранённые в базе, глазами конфигурации: только известные ключи и
 * значения, которые проходят проверку (остальное не показывается)
 */
export function readAttributes(category: CategoryConfig, stored: unknown): ListingAttributes {
  if (!isObject(stored)) return {};
  const out: Record<string, AttributeValue> = {};
  for (const field of category.attributes) {
    const value = stored[field.key];
    if (value === undefined || value === null) continue;
    const parsed = attributeValue(field, value, field.key);
    if (parsed.ok) out[field.key] = parsed.value;
  }
  return out;
}

/** Обязательные поля витрины без значения — для экрана «чего не хватает» */
export function missingAttributes(category: CategoryConfig, attributes: ListingAttributes): string[] {
  const present = readAttributes(category, attributes);
  return category.attributes.filter((a) => a.required && present[a.key] === undefined).map((a) => a.key);
}

// ── ссылки на видео ─────────────────────────────────────────────────────────

const YOUTUBE_ID = "[A-Za-z0-9_-]{11}";
const VIDEO_PATTERNS: readonly { re: RegExp; canonical: (m: RegExpExecArray) => string }[] = [
  {
    re: new RegExp(`^https://(?:www\\.|m\\.)?youtube\\.com/watch\\?v=(${YOUTUBE_ID})$`),
    canonical: (m) => `https://www.youtube.com/watch?v=${m[1]}`,
  },
  {
    re: new RegExp(`^https://youtu\\.be/(${YOUTUBE_ID})$`),
    canonical: (m) => `https://www.youtube.com/watch?v=${m[1]}`,
  },
  {
    re: new RegExp(`^https://(?:www\\.|m\\.)?youtube\\.com/shorts/(${YOUTUBE_ID})$`),
    canonical: (m) => `https://www.youtube.com/shorts/${m[1]}`,
  },
  {
    re: /^https:\/\/(?:www\.)?instagram\.com\/(p|reel|tv)\/([A-Za-z0-9_-]{5,40})\/?$/,
    canonical: (m) => `https://www.instagram.com/${m[1]}/${m[2]}/`,
  },
];

/** Тот же шаблон проверяет база (app.video_link_ok): только канонический вид */
export const VIDEO_LINK_DB_RE =
  "^https://www\\.(youtube\\.com/(watch\\?v=|shorts/)[A-Za-z0-9_-]{11}|instagram\\.com/(p|reel|tv)/[A-Za-z0-9_-]{5,40}/)$";

/**
 * Ссылка на видео YouTube или Instagram → канонический вид; другая — null. Только https,
 * без параметров, кроме v у YouTube: никаких чужих сайтов и трекеров в карточке
 */
export function normalizeVideoLink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const url = value.trim();
  if (url.length > 200) return null;
  for (const { re, canonical } of VIDEO_PATTERNS) {
    const match = re.exec(url);
    if (match) return canonical(match);
  }
  return null;
}

/** Ссылки на видео карточки: не больше maxVideoLinks категории, без повторов */
export function validateVideoLinks(category: CategoryConfig, input: unknown): Result<string[]> {
  if (!Array.isArray(input) || input.length > category.maxVideoLinks) return fail(["videoLinks"]);
  const errors: string[] = [];
  const links: string[] = [];
  input.forEach((raw, index) => {
    const link = normalizeVideoLink(raw);
    if (link === null || links.includes(link)) errors.push(`videoLinks.${index}`);
    else links.push(link);
  });
  return errors.length > 0 ? fail(errors) : ok(links);
}

// ── услуги ──────────────────────────────────────────────────────────────────

export const SERVICE_LIMITS = {
  /** Цена в сумах — как ограничения столбцов базы */
  maxPrice: 99_999_999_999,
  maxMinQty: 100_000,
  maxLeadDays: 365,
  nameMax: 80,
  includesMax: 1000,
  maxOptions: 10,
  /** Услуг на карточке */
  maxServices: 30,
} as const;

/** Опция услуги: id ставит сервер (UUID), code — шаблон категории, если взят из него */
export interface ServiceOptionValue {
  readonly id?: string;
  readonly code?: string;
  readonly name: { readonly ru: string; readonly uz: string };
  readonly priceUzs: number;
  readonly priceUnit: PriceUnit;
}

/** Поля услуги в форме вендора и панели (контракт API — ServiceInput) */
export interface ServiceValues {
  readonly type?: string;
  /** Только у типа с freeName («другая услуга») — и там обязательно */
  readonly name?: { readonly ru: string; readonly uz: string } | null;
  readonly priceUzs?: number;
  readonly priceUnit?: PriceUnit;
  readonly minQty?: number | null;
  readonly leadDays?: number | null;
  readonly includes?: LocalizedText | null;
  readonly options?: readonly ServiceOptionValue[];
  readonly sort?: number;
}

const SERVICE_KEYS = [
  "type",
  "name",
  "priceUzs",
  "priceUnit",
  "minQty",
  "leadDays",
  "includes",
  "options",
  "sort",
] as const;

const OPTION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function bothNames(value: unknown): { ru: string; uz: string } | null {
  const v = localized(value, SERVICE_LIMITS.nameMax, true);
  if (v === null || v.ru === undefined || v.uz === undefined) return null;
  if (charLength(v.ru) < 2 || charLength(v.uz) < 2) return null;
  return { ru: v.ru, uz: v.uz };
}

function parseOption(
  type: ServiceType,
  raw: unknown,
  path: string,
  errors: string[],
): ServiceOptionValue | null {
  if (!isObject(raw)) {
    errors.push(path);
    return null;
  }
  const before = errors.length;
  for (const key of Object.keys(raw)) {
    if (!["id", "code", "name", "priceUzs", "priceUnit"].includes(key)) errors.push(`${path}.${key}`);
  }
  const id = raw.id === undefined || raw.id === null ? undefined : raw.id;
  if (id !== undefined && (typeof id !== "string" || !OPTION_ID_RE.test(id))) errors.push(`${path}.id`);
  const code = raw.code === undefined || raw.code === null ? undefined : raw.code;
  if (code !== undefined && !type.options.some((o) => o.code === code)) errors.push(`${path}.code`);
  const name = bothNames(raw.name);
  if (name === null) errors.push(`${path}.name`);
  if (!isInt(raw.priceUzs, 1, SERVICE_LIMITS.maxPrice)) errors.push(`${path}.priceUzs`);
  if (!isPriceUnit(raw.priceUnit)) errors.push(`${path}.priceUnit`);
  if (errors.length > before || name === null) return null;
  return {
    ...(typeof id === "string" ? { id } : {}),
    ...(typeof code === "string" ? { code } : {}),
    name,
    priceUzs: raw.priceUzs as number,
    priceUnit: raw.priceUnit as PriceUnit,
  };
}

/**
 * Услуга из тела запроса. create — новая: type, цена и единица обязательны; иначе —
 * правка: только переданные поля (type менять нельзя). typeCode — тип правимой услуги.
 * null у minQty, leadDays, includes — очистить
 */
export function validateServiceInput(
  category: CategoryConfig,
  input: unknown,
  mode: { readonly create: true } | { readonly create: false; readonly typeCode: string },
): Result<ServiceValues> {
  if (!isObject(input)) return fail(["body"]);
  const errors: string[] = [];
  for (const key of Object.keys(input)) {
    if (!(SERVICE_KEYS as readonly string[]).includes(key) || (!mode.create && key === "type"))
      errors.push(key);
  }
  const has = (key: string) => Object.hasOwn(input, key) && input[key] !== undefined;

  const typeCode = mode.create ? input.type : mode.typeCode;
  const type = typeof typeCode === "string" ? serviceType(category, typeCode) : undefined;
  if (type === undefined) return fail([...errors, "type"]);

  const out: {
    -readonly [K in keyof ServiceValues]: ServiceValues[K];
  } = mode.create ? { type: type.code } : {};

  // Название — только у «другой услуги», и там обязательно
  if (type.freeName) {
    if (mode.create || has("name")) {
      const name = bothNames(input.name);
      if (name === null) errors.push("name");
      else out.name = name;
    }
  } else if (has("name") && input.name !== null) {
    errors.push("name");
  }

  if (mode.create || has("priceUzs")) {
    if (isInt(input.priceUzs, 1, SERVICE_LIMITS.maxPrice)) out.priceUzs = input.priceUzs;
    else errors.push("priceUzs");
  }
  if (mode.create || has("priceUnit")) {
    const unit = input.priceUnit === undefined && mode.create ? type.units[0] : input.priceUnit;
    if (isPriceUnit(unit) && type.units.includes(unit)) out.priceUnit = unit;
    else errors.push("priceUnit");
  }

  const nullableInt = (key: "minQty" | "leadDays", max: number) => {
    if (!has(key)) return;
    const value = input[key];
    if (value === null) out[key] = null;
    else if (isInt(value, key === "minQty" ? 1 : 0, max)) out[key] = value;
    else errors.push(key);
  };
  nullableInt("minQty", SERVICE_LIMITS.maxMinQty);
  nullableInt("leadDays", SERVICE_LIMITS.maxLeadDays);

  if (has("includes")) {
    if (input.includes === null) out.includes = null;
    else {
      const includes = localized(input.includes, SERVICE_LIMITS.includesMax, false);
      if (includes === null) errors.push("includes");
      else out.includes = includes;
    }
  }

  if (has("options")) {
    const raw = input.options;
    if (!Array.isArray(raw) || raw.length > SERVICE_LIMITS.maxOptions) errors.push("options");
    else {
      const options = raw.map((item, index) => parseOption(type, item, `options.${index}`, errors));
      const ids = options.flatMap((o) => (o?.id ? [o.id] : []));
      if (new Set(ids).size !== ids.length) errors.push("options");
      if (options.every((o) => o !== null)) out.options = options as ServiceOptionValue[];
    }
  }

  if (has("sort")) {
    if (isInt(input.sort, 0, 1000)) out.sort = input.sort;
    else errors.push("sort");
  }

  return errors.length > 0 ? fail(errors) : ok(out);
}

// ── форма заявки ────────────────────────────────────────────────────────────

/** Выбранная услуга: id услуги витрины, количество (по единице цены) и id опций */
export interface ServiceChoice {
  readonly id: string;
  readonly qty: number | null;
  readonly options: readonly string[];
}

/** Значение поля формы: int — число, bool — да/нет, enum/district/time — строка, multi — коды */
export type DetailValue = number | boolean | string | readonly string[];

export interface RequestDetailsInput {
  /** Поля категории, кроме выбора услуг */
  readonly values: Readonly<Record<string, DetailValue>>;
  /** Выбор услуг — если в форме категории есть поле services и клиент что-то выбрал */
  readonly services: readonly ServiceChoice[];
}

const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const DISTRICT_RE = /^[a-z_]{2,30}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Сколько услуг можно выбрать в одной заявке */
export const MAX_CHOSEN_SERVICES = 10;
/** Количество по выбранной услуге (часы, штуки, килограммы…) */
export const MAX_CHOSEN_QTY = 100_000;

function detailValue(field: Exclude<RequestField, { type: "services" }>, value: unknown): DetailValue | null {
  switch (field.type) {
    case "int":
      return isInt(value, field.min, field.max) ? value : null;
    case "bool":
      return typeof value === "boolean" ? value : null;
    case "enum":
      return hasCode(field.options, value) ? value : null;
    case "multi": {
      const v = codes(field.options, value);
      return v === null || v.length === 0 ? null : v;
    }
    case "time":
      return typeof value === "string" && TIME_RE.test(value) ? value : null;
    case "district":
      return typeof value === "string" && DISTRICT_RE.test(value) ? value : null;
  }
}

function serviceChoices(
  field: Extract<RequestField, { type: "services" }>,
  value: unknown,
  errors: string[],
) {
  const path = `details.${field.key}`;
  if (!Array.isArray(value) || value.length > MAX_CHOSEN_SERVICES) {
    errors.push(path);
    return [];
  }
  const out: ServiceChoice[] = [];
  value.forEach((raw, index) => {
    const at = `${path}.${index}`;
    if (!isObject(raw)) {
      errors.push(at);
      return;
    }
    const before = errors.length;
    for (const key of Object.keys(raw))
      if (!["id", "qty", "options"].includes(key)) errors.push(`${at}.${key}`);
    if (typeof raw.id !== "string" || !UUID_RE.test(raw.id)) errors.push(`${at}.id`);
    const qty = raw.qty === undefined || raw.qty === null ? null : raw.qty;
    if (qty !== null && !isInt(qty, 1, MAX_CHOSEN_QTY)) errors.push(`${at}.qty`);
    const options = raw.options === undefined || raw.options === null ? [] : raw.options;
    if (
      !Array.isArray(options) ||
      options.length > SERVICE_LIMITS.maxOptions ||
      !options.every((o) => typeof o === "string" && UUID_RE.test(o)) ||
      new Set(options).size !== options.length
    ) {
      errors.push(`${at}.options`);
    }
    if (errors.length > before) return;
    out.push({
      id: (raw.id as string).toLowerCase(),
      qty: qty as number | null,
      options: (options as string[]).map((o) => o.toLowerCase()),
    });
  });
  const ids = out.map((c) => c.id);
  if (new Set(ids).size !== ids.length) errors.push(path);
  if (field.required && out.length < Math.max(1, field.minItems)) errors.push(path);
  return out;
}

/**
 * Поля категории из тела заявки (details). Неизвестное поле — ошибка; обязательное без
 * значения — ошибка. Ошибки — «details.<ключ>[.<номер>.<поле>]»
 */
export function validateRequestDetails(
  category: CategoryConfig,
  input: unknown,
): Result<RequestDetailsInput> {
  const body = input === undefined || input === null ? {} : input;
  if (!isObject(body)) return fail(["details"]);
  const errors: string[] = [];
  for (const key of Object.keys(body)) {
    if (!category.requestForm.fields.some((f) => f.key === key)) errors.push(`details.${key}`);
  }
  const values: Record<string, DetailValue> = {};
  let services: ServiceChoice[] = [];
  for (const field of category.requestForm.fields) {
    const raw = body[field.key];
    const empty = raw === undefined || raw === null || raw === "" || (Array.isArray(raw) && raw.length === 0);
    if (empty) {
      if (field.required) errors.push(`details.${field.key}`);
      continue;
    }
    if (field.type === "services") {
      services = serviceChoices(field, raw, errors);
      continue;
    }
    const value = detailValue(field, raw);
    if (value === null) errors.push(`details.${field.key}`);
    else values[field.key] = value;
  }
  return errors.length > 0 ? fail(errors) : ok({ values, services });
}

/**
 * Число гостей по правилу формы категории: required — обязательно; optional — можно не
 * указывать; hidden — не спрашивается и не принимается. null — не указано
 */
export function guestsAllowed(category: CategoryConfig, guests: number | null): boolean {
  switch (category.requestForm.guests) {
    case "required":
      return guests !== null;
    case "optional":
      return true;
    case "hidden":
      return guests === null;
  }
}

// ── фильтры каталога ────────────────────────────────────────────────────────

/** Префикс параметров фильтров по полям витрины: ?a.parking_spaces=50&a.fleet.class=premium */
export const ATTRIBUTE_FILTER_PREFIX = "a.";

/**
 * Фильтр по полю витрины. path — [поле] или [список, поле записи] («есть запись, где…»):
 *   eq  — да (bool);
 *   any — значение одно из values (enum) или среди значений есть одно из values (multi);
 *   all — среди значений есть все values (multi);
 *   min — значение не меньше value; max — не больше
 */
export type AttributeFilter =
  | { readonly kind: "eq"; readonly path: readonly string[] }
  | {
      readonly kind: "any";
      readonly path: readonly string[];
      readonly values: readonly string[];
      readonly multi: boolean;
    }
  | { readonly kind: "all"; readonly path: readonly string[]; readonly values: readonly string[] }
  | { readonly kind: "min" | "max"; readonly path: readonly string[]; readonly value: number };

/** Фильтр, который можно задать параметром: имя параметра, подпись, поле */
export interface FilterSpec {
  /** Имя параметра строки запроса: a.<поле> или a.<список>.<поле записи> */
  readonly param: string;
  readonly path: readonly string[];
  readonly label: CategoryTextKey;
  readonly field:
    | IntField
    | Exclude<AttributeField, IntField | { type: "text" } | { type: "list" }>
    | ListItemField;
}

/** Фильтры категории — для формы фильтров и разбора параметров */
export function categoryFilters(category: CategoryConfig): FilterSpec[] {
  const out: FilterSpec[] = [];
  for (const field of category.attributes) {
    if (field.type === "list") {
      for (const sub of field.fields) {
        if (sub.type !== "text" && sub.filter !== undefined) {
          out.push({
            param: `${ATTRIBUTE_FILTER_PREFIX}${field.key}.${sub.key}`,
            path: [field.key, sub.key],
            label: sub.label,
            field: sub,
          });
        }
      }
    } else if (field.type !== "text" && field.filter !== undefined) {
      out.push({
        param: `${ATTRIBUTE_FILTER_PREFIX}${field.key}`,
        path: [field.key],
        label: field.label,
        field,
      });
    }
  }
  return out;
}

const INT_PARAM_RE = /^(0|[1-9][0-9]{0,8})$/;

/**
 * Фильтры из строки запроса (имя → все значения). Параметры не с префиксом «a.»
 * пропускаются — их разбирает каталог. Неизвестный фильтр, повтор параметра, неверное
 * значение — ошибка с именем параметра. Списки кодов — через запятую
 */
export function parseAttributeFilters(
  category: CategoryConfig,
  query: Readonly<Record<string, readonly string[] | undefined>>,
): Result<AttributeFilter[]> {
  const specs = new Map(categoryFilters(category).map((spec) => [spec.param, spec]));
  const errors: string[] = [];
  const filters: AttributeFilter[] = [];
  for (const [param, values] of Object.entries(query)) {
    if (!param.startsWith(ATTRIBUTE_FILTER_PREFIX) || values === undefined || values.length === 0) continue;
    const spec = specs.get(param);
    const raw = values[0] ?? "";
    if (spec === undefined || values.length > 1) {
      errors.push(param);
      continue;
    }
    if (raw === "") continue;
    const { field, path } = spec;
    switch (field.type) {
      case "bool":
        if (raw === "true" || raw === "1") filters.push({ kind: "eq", path });
        else if (raw !== "false" && raw !== "0") errors.push(param);
        break;
      case "int": {
        const n = INT_PARAM_RE.test(raw) ? Number(raw) : Number.NaN;
        if (!(n >= field.min && n <= field.max) || field.filter === undefined) errors.push(param);
        else filters.push({ kind: field.filter, path, value: n });
        break;
      }
      case "enum":
      case "multi": {
        const list = raw.split(",");
        if (list.length > field.options.length || !list.every((code) => hasCode(field.options, code))) {
          errors.push(param);
          break;
        }
        const unique = [...new Set(list)];
        if (field.type === "multi" && field.filter === "all")
          filters.push({ kind: "all", path, values: unique });
        else filters.push({ kind: "any", path, values: unique, multi: field.type === "multi" });
        break;
      }
    }
  }
  return errors.length > 0 ? fail(errors) : ok(filters);
}
