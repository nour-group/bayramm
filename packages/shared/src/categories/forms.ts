/* Формы по конфигурации категории — общие для панели и кабинета: поля витрины (attributes),
   ссылки на видео, услуга с опциями, показ полей заявки и предложения правки услуги.

   Чистые функции без React. Значения в форме — как их держат поля ввода: числа — строками
   (человек стирает и набирает заново), галочки — да/нет, несколько вариантов — коды. Из них
   собирается тело запроса API; проверка — те же validate*, что на сервере, поэтому форма
   подсвечивает те же поля, что потом назвал бы ответ 422. Число, которое не разобралось,
   уходит строкой как есть: проверка назовёт поле, а не очистит его молча. */

import type { ListingService, ServiceChanges, ServiceInput, ServiceOptionInput } from "../api/services";
import { type CategoryTextKey, categoryText, categoryTexts } from "../i18n/categories";
import type { Lang } from "../i18n/dict";
import type { ChosenServiceSnapshot, RequestDetails } from "./details";
import type {
  AttributeField,
  CategoryConfig,
  Choice,
  ListField,
  ListItemField,
  PriceUnit,
  RequestField,
} from "./types";
import {
  type ListingAttributes,
  readAttributes,
  serviceType,
  validateAttributePatch,
  validateServiceInput,
  validateVideoLinks,
} from "./validate";

// ── числа ───────────────────────────────────────────────────────────────────

/** «150 000» → 150000; пусто — null; не целое неотрицательное — NaN */
export function parseAmount(value: string): number | null {
  const compact = value.replace(/[\s _  ]/g, "");
  if (compact === "") return null;
  return /^\d{1,15}$/.test(compact) ? Number(compact) : Number.NaN;
}

/** Число из поля для тела запроса: пусто — null, не число — строка как есть (её назовёт проверка) */
function amountOrRaw(value: string): number | string | null {
  const n = parseAmount(value);
  return n === null ? null : Number.isNaN(n) ? value.trim() : n;
}

/** Подпись единицы цены: «за час» */
export function priceUnitLabel(lang: Lang, unit: PriceUnit): string {
  return categoryText(lang, `unit_${unit}` as CategoryTextKey);
}

/** Подпись варианта по коду; неизвестный — код как есть */
export function choiceLabel(lang: Lang, options: readonly Choice[], code: string): string {
  const option = options.find((o) => o.code === code);
  return option === undefined ? code : categoryText(lang, option.label);
}

// ── поля витрины ────────────────────────────────────────────────────────────

/** Значение поля записи списка в форме: число и текст — строкой, да/нет — галочкой */
export type ListItemDraft = Readonly<Record<string, string | boolean>>;

/**
 * Значение поля витрины в форме: int, enum, text — строка ("" — пусто); bool — да/нет;
 * multi — коды; text на двух языках — { ru, uz }; list — записи
 */
export type AttributeDraft =
  | string
  | boolean
  | readonly string[]
  | { readonly ru: string; readonly uz: string }
  | readonly ListItemDraft[];

export type AttributeDrafts = Readonly<Record<string, AttributeDraft>>;

/** Пустая запись списка (новая машина в автопарке) */
export function emptyListItem(field: ListField): ListItemDraft {
  return Object.fromEntries(field.fields.map((sub) => [sub.key, sub.type === "bool" ? false : ""]));
}

function emptyDraft(field: AttributeField): AttributeDraft {
  switch (field.type) {
    case "bool":
      return false;
    case "multi":
      return [];
    case "list":
      return [];
    case "text":
      return field.localized ? { ru: "", uz: "" } : "";
    default:
      return "";
  }
}

function itemDraft(field: ListField, item: Readonly<Record<string, unknown>>): ListItemDraft {
  return Object.fromEntries(
    field.fields.map((sub) => {
      const value = item[sub.key];
      if (sub.type === "bool") return [sub.key, value === true];
      return [sub.key, value === undefined || value === null ? "" : String(value)];
    }),
  );
}

/** Значение в форму из сохранённого (readAttributes — только известные и правильные) */
function draftOf(field: AttributeField, value: unknown): AttributeDraft {
  if (value === undefined || value === null) return emptyDraft(field);
  switch (field.type) {
    case "int":
      return typeof value === "number" ? String(value) : "";
    case "bool":
      return value === true;
    case "enum":
      return typeof value === "string" ? value : "";
    case "multi":
      return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
    case "text":
      if (!field.localized) return typeof value === "string" ? value : "";
      if (typeof value === "object" && !Array.isArray(value)) {
        const text = value as { ru?: unknown; uz?: unknown };
        return {
          ru: typeof text.ru === "string" ? text.ru : "",
          uz: typeof text.uz === "string" ? text.uz : "",
        };
      }
      return { ru: "", uz: "" };
    case "list":
      return Array.isArray(value)
        ? value
            .filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
            .map((item) => itemDraft(field, item))
        : [];
  }
}

/** Поля витрины в форму: каждое поле категории — значением или пустым */
export function attributeDrafts(category: CategoryConfig, stored: ListingAttributes): AttributeDrafts {
  const present = readAttributes(category, stored);
  return Object.fromEntries(
    category.attributes.map((field) => [field.key, draftOf(field, present[field.key])]),
  );
}

function scalarValue(field: ListItemField, draft: string | boolean): unknown {
  if (field.type === "bool") return draft === true ? true : null;
  const text = typeof draft === "string" ? draft.trim() : "";
  if (text === "") return null;
  return field.type === "int" ? amountOrRaw(text) : text;
}

/**
 * Значение поля для тела запроса: null — пусто (убрать поле). Галочка «нет» — тоже null:
 * у фильтров «только где да» нет разницы между «нет» и «не указано»
 */
export function draftValue(field: AttributeField, draft: AttributeDraft | undefined): unknown {
  if (draft === undefined) return null;
  switch (field.type) {
    case "int":
      return typeof draft === "string" ? amountOrRaw(draft) : null;
    case "bool":
      return draft === true ? true : null;
    case "enum":
      return typeof draft === "string" && draft !== "" ? draft : null;
    case "multi": {
      if (!Array.isArray(draft)) return null;
      // Порядок — как в конфигурации: одинаковый набор сравнивается одинаково
      const chosen = new Set(draft as readonly string[]);
      const codes = field.options.map((o) => o.code).filter((code) => chosen.has(code));
      return codes.length === 0 ? null : codes;
    }
    case "text": {
      if (!field.localized) {
        const text = typeof draft === "string" ? draft.trim() : "";
        return text === "" ? null : text;
      }
      if (typeof draft !== "object" || Array.isArray(draft)) return null;
      const { ru, uz } = draft as { ru: string; uz: string };
      const out: { ru?: string; uz?: string } = {};
      if (ru.trim() !== "") out.ru = ru.trim();
      if (uz.trim() !== "") out.uz = uz.trim();
      return out.ru === undefined && out.uz === undefined ? null : out;
    }
    case "list": {
      if (!Array.isArray(draft)) return null;
      const items = (draft as readonly ListItemDraft[])
        .map((item) => {
          const out: Record<string, unknown> = {};
          for (const sub of field.fields) {
            const value = scalarValue(sub, item[sub.key] ?? "");
            if (value !== null) out[sub.key] = value;
          }
          return out;
        })
        // Строка, где ничего не вписано, — не запись: её просто не было
        .filter((item) => Object.keys(item).length > 0);
      return items.length === 0 ? null : items;
    }
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Правка полей витрины: только изменённые поля { ключ: значение | null } (null — убрать).
 * before — форма как была загружена (attributeDrafts от карточки)
 */
export function attributePatch(
  category: CategoryConfig,
  drafts: AttributeDrafts,
  before: AttributeDrafts,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const field of category.attributes) {
    const now = draftValue(field, drafts[field.key]);
    if (!same(now, draftValue(field, before[field.key]))) patch[field.key] = now;
  }
  return patch;
}

/**
 * Ошибки полей витрины — пути, как в ответе API: «attributes.fleet.0.class». Проверяется всё,
 * что вписано; обязательное пустое — не ошибка формы (сохранить черновик можно), его
 * показывает «чего не хватает» (missingAttributes)
 */
export function attributeErrors(category: CategoryConfig, drafts: AttributeDrafts): string[] {
  const values: Record<string, unknown> = {};
  for (const field of category.attributes) {
    const value = draftValue(field, drafts[field.key]);
    if (value !== null) values[field.key] = value;
  }
  const result = validateAttributePatch(category, values);
  return result.ok ? [] : result.errors;
}

/** Поля витрины из формы — как сохранятся (для «чего не хватает» до сохранения) */
export function attributesOf(category: CategoryConfig, drafts: AttributeDrafts): ListingAttributes {
  const values: Record<string, unknown> = {};
  for (const field of category.attributes) {
    const value = draftValue(field, drafts[field.key]);
    if (value !== null) values[field.key] = value;
  }
  return readAttributes(category, values);
}

/**
 * Значение поля витрины словами — для правок, списков и «сейчас → предлагает». yes — слово
 * «да» на языке; пусто — null
 */
export function attributeText(lang: Lang, field: AttributeField, value: unknown, yes: string): string | null {
  if (value === undefined || value === null) return null;
  switch (field.type) {
    case "int":
      return typeof value === "number" || typeof value === "string" ? String(value) : null;
    case "bool":
      return value === true ? yes : null;
    case "enum":
      return typeof value === "string" ? choiceLabel(lang, field.options, value) : null;
    case "multi":
      return Array.isArray(value)
        ? (value as readonly unknown[])
            .filter((v): v is string => typeof v === "string")
            .map((code) => choiceLabel(lang, field.options, code))
            .join(", ")
        : null;
    case "text": {
      if (typeof value === "string") return value;
      if (typeof value !== "object" || Array.isArray(value)) return null;
      const text = value as { ru?: unknown; uz?: unknown };
      const parts = [text.ru, text.uz].filter((v): v is string => typeof v === "string" && v !== "");
      return parts.length === 0 ? null : parts.join(" / ");
    }
    case "list": {
      if (!Array.isArray(value)) return null;
      const items = (value as readonly unknown[])
        .filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
        .map((item) =>
          field.fields
            .map((sub) =>
              sub.type === "enum" && typeof item[sub.key] === "string"
                ? choiceLabel(lang, sub.options, item[sub.key] as string)
                : sub.type === "bool"
                  ? item[sub.key] === true
                    ? categoryText(lang, sub.label)
                    : null
                  : item[sub.key] === undefined || item[sub.key] === null
                    ? null
                    : String(item[sub.key]),
            )
            .filter((part): part is string => part !== null && part !== "")
            .join(" · "),
        );
      return items.length === 0 ? null : items.join("; ");
    }
  }
}

/** Подпись поля витрины по ключу; неизвестный ключ — сам ключ */
export function attributeLabel(lang: Lang, category: CategoryConfig, key: string): string {
  const field = category.attributes.find((a) => a.key === key);
  return field === undefined ? key : categoryText(lang, field.label);
}

// ── ссылки на видео ─────────────────────────────────────────────────────────

/** Ссылки для тела запроса: без пустых строк, края обрезаны */
export function videoLinksValue(drafts: readonly string[]): string[] {
  return drafts.map((link) => link.trim()).filter((link) => link !== "");
}

/** Номера полей формы (как в drafts, с пустыми), где ссылка не принята */
export function videoLinkErrors(category: CategoryConfig, drafts: readonly string[]): number[] {
  const filled = drafts.map((link, index) => ({ link: link.trim(), index })).filter((x) => x.link !== "");
  const result = validateVideoLinks(
    category,
    filled.map((x) => x.link),
  );
  if (result.ok) return [];
  if (result.errors.includes("videoLinks")) return filled.map((x) => x.index);
  return result.errors.flatMap((path) => {
    const at = Number(path.split(".")[1]);
    const found = filled[at];
    return found === undefined ? [] : [found.index];
  });
}

// ── услуги ──────────────────────────────────────────────────────────────────

/** Опция услуги в форме. key — для списка в интерфейсе; id — у сохранённой опции */
export interface OptionDraft {
  readonly key: string;
  readonly id?: string;
  /** Шаблон опции категории, из которого она */
  readonly code?: string;
  readonly nameRu: string;
  readonly nameUz: string;
  readonly price: string;
  readonly priceUnit: PriceUnit;
}

/** Услуга в форме */
export interface ServiceDraft {
  readonly type: string;
  /** Название — только у «другой услуги» */
  readonly nameRu: string;
  readonly nameUz: string;
  readonly price: string;
  readonly priceUnit: PriceUnit;
  readonly minQty: string;
  readonly leadDays: string;
  readonly includesRu: string;
  readonly includesUz: string;
  readonly options: readonly OptionDraft[];
}

let optionKey = 0;
const nextKey = () => `o${++optionKey}`;

/** Новая услуга типа из каталога категории; неизвестный тип — undefined */
export function newServiceDraft(category: CategoryConfig, typeCode: string): ServiceDraft | undefined {
  const type = serviceType(category, typeCode);
  if (type === undefined) return undefined;
  return {
    type: type.code,
    nameRu: "",
    nameUz: "",
    price: "",
    priceUnit: type.units[0] ?? "per_event",
    minQty: "",
    leadDays: "",
    includesRu: "",
    includesUz: "",
    options: [],
  };
}

/**
 * Услуга в форму. Есть предложение правки, которое ждёт решения, — форма показывает его
 * (правят то, что предложено; клиент пока видит одобренное)
 */
export function serviceDraftOf(service: ListingService): ServiceDraft {
  const changes: ServiceChanges = service.proposal?.changes ?? {};
  const name = changes.name ?? service.name;
  const includes = changes.includes === undefined ? service.includes : changes.includes;
  const minQty = changes.minQty === undefined ? service.minQty : changes.minQty;
  const leadDays = changes.leadDays === undefined ? service.leadDays : changes.leadDays;
  return {
    type: service.type,
    nameRu: service.customName ? name.ru : "",
    nameUz: service.customName ? name.uz : "",
    price: String(changes.priceUzs ?? service.priceUzs),
    priceUnit: changes.priceUnit ?? service.priceUnit,
    minQty: minQty === null ? "" : String(minQty),
    leadDays: leadDays === null ? "" : String(leadDays),
    includesRu: includes?.ru ?? "",
    includesUz: includes?.uz ?? "",
    options: (changes.options ?? service.options).map((o) => ({
      key: nextKey(),
      id: o.id,
      ...(o.code === null ? {} : { code: o.code }),
      nameRu: o.name.ru,
      nameUz: o.name.uz,
      price: String(o.priceUzs),
      priceUnit: o.priceUnit,
    })),
  };
}

/** Новая опция: из шаблона категории (название — из каталога) или своя (пустая) */
export function newOptionDraft(
  category: CategoryConfig,
  typeCode: string,
  templateCode?: string,
): OptionDraft {
  const type = serviceType(category, typeCode);
  const template = type?.options.find((o) => o.code === templateCode);
  if (template === undefined) {
    return { key: nextKey(), nameRu: "", nameUz: "", price: "", priceUnit: type?.units[0] ?? "per_event" };
  }
  const name = categoryTexts(template.label);
  return {
    key: nextKey(),
    code: template.code,
    nameRu: name.ru,
    nameUz: name.uz,
    price: "",
    priceUnit: template.unit,
  };
}

/**
 * Тело запроса услуги. Новая — с type; правка — без него (тип не меняется). Поля — все:
 * у активной услуги сервер сам выделит изменённые в предложение. Пустые minQty, leadDays и
 * «что входит» при правке — null (очистить)
 */
export function serviceInput(
  category: CategoryConfig,
  draft: ServiceDraft,
  mode: { readonly create: boolean },
): ServiceInput {
  const type = serviceType(category, draft.type);
  const includesRu = draft.includesRu.trim();
  const includesUz = draft.includesUz.trim();
  const options: ServiceOptionInput[] = draft.options.map((o) => ({
    ...(o.id === undefined ? {} : { id: o.id }),
    ...(o.code === undefined ? {} : { code: o.code }),
    name: { ru: o.nameRu.trim(), uz: o.nameUz.trim() },
    priceUzs: amountOrRaw(o.price) as number,
    priceUnit: o.priceUnit,
  }));
  const minQty = amountOrRaw(draft.minQty) as number | null;
  const leadDays = amountOrRaw(draft.leadDays) as number | null;
  const body: Record<string, unknown> = {
    ...(mode.create ? { type: draft.type } : {}),
    ...(type?.freeName ? { name: { ru: draft.nameRu.trim(), uz: draft.nameUz.trim() } } : {}),
    priceUzs: amountOrRaw(draft.price),
    priceUnit: draft.priceUnit,
    options,
  };
  if (!mode.create || minQty !== null) body.minQty = minQty;
  if (!mode.create || leadDays !== null) body.leadDays = leadDays;
  if (includesRu !== "" || includesUz !== "") {
    body.includes = { ...(includesRu ? { ru: includesRu } : {}), ...(includesUz ? { uz: includesUz } : {}) };
  } else if (!mode.create) {
    body.includes = null;
  }
  return body as ServiceInput;
}

/** Ошибки полей услуги — те же пути, что ответ 422: priceUzs, options.2.priceUzs, name… */
export function serviceErrors(
  category: CategoryConfig,
  draft: ServiceDraft,
  mode: { readonly create: boolean },
): string[] {
  const body = serviceInput(category, draft, mode);
  const result = validateServiceInput(
    category,
    body,
    mode.create ? { create: true } : { create: false, typeCode: draft.type },
  );
  return result.ok ? [] : result.errors;
}

/** Есть ли в форме изменения против исходной (то же тело запроса) */
export function serviceDirty(category: CategoryConfig, draft: ServiceDraft, before: ServiceDraft): boolean {
  return !same(
    serviceInput(category, draft, { create: false }),
    serviceInput(category, before, { create: false }),
  );
}

/** Название типа услуги категории на языке; «другая услуга» — «Другая услуга» */
export function serviceTypeLabel(lang: Lang, category: CategoryConfig, typeCode: string): string {
  const type = serviceType(category, typeCode);
  return type === undefined ? typeCode : categoryText(lang, type.label);
}

/** Поле предложения правки услуги — для «сейчас → предлагает» */
export type ServiceChangeField = keyof ServiceChanges;

export interface ServiceChangeRow {
  readonly field: ServiceChangeField;
  readonly before: unknown;
  readonly after: unknown;
}

const CHANGE_ORDER: readonly ServiceChangeField[] = [
  "name",
  "priceUzs",
  "priceUnit",
  "minQty",
  "leadDays",
  "includes",
  "options",
];

/** Предложение правки услуги по полям: было (одобрено) → предлагают. Нет предложения — пусто */
export function serviceChangeRows(service: ListingService): ServiceChangeRow[] {
  const changes = service.proposal?.changes;
  if (!changes) return [];
  const current: Readonly<Record<ServiceChangeField, unknown>> = {
    name: service.name,
    priceUzs: service.priceUzs,
    priceUnit: service.priceUnit,
    minQty: service.minQty,
    leadDays: service.leadDays,
    includes: service.includes,
    options: service.options,
  };
  return CHANGE_ORDER.filter((field) => changes[field] !== undefined).map((field) => ({
    field,
    before: current[field],
    after: changes[field],
  }));
}

// ── поля заявки ─────────────────────────────────────────────────────────────

/** Поле заявки категории для показа: подпись и значение словами (у «да» — null: только подпись) */
export interface DetailRow {
  readonly key: string;
  readonly label: string;
  readonly value: string | null;
}

const isSnapshots = (value: unknown): value is readonly ChosenServiceSnapshot[] =>
  Array.isArray(value) && value.every((v) => typeof v === "object" && v !== null && "name" in v);

function detailText(
  lang: Lang,
  field: Exclude<RequestField, { type: "services" }>,
  value: unknown,
  district?: (code: string) => string | undefined,
): string | null | undefined {
  switch (field.type) {
    case "bool":
      return value === true ? null : undefined;
    case "enum":
      return typeof value === "string" ? choiceLabel(lang, field.options, value) : undefined;
    case "multi":
      return Array.isArray(value)
        ? (value as readonly unknown[])
            .filter((v): v is string => typeof v === "string")
            .map((code) => choiceLabel(lang, field.options, code))
            .join(", ")
        : undefined;
    case "district":
      return typeof value === "string" ? (district?.(value) ?? value) : undefined;
    case "int":
    case "time":
      return typeof value === "number" || typeof value === "string" ? String(value) : undefined;
  }
}

/**
 * Поля заявки категории по порядку формы — кроме выбранных услуг (их — chosenServices).
 * Неизвестная категория или пустые details — пусто
 */
export function detailRows(
  lang: Lang,
  category: CategoryConfig | undefined,
  details: RequestDetails,
  district?: (code: string) => string | undefined,
): DetailRow[] {
  if (category === undefined) return [];
  const rows: DetailRow[] = [];
  for (const field of category.requestForm.fields) {
    if (field.type === "services") continue;
    const value = details[field.key];
    if (value === undefined || value === null) continue;
    const text = detailText(lang, field, value, district);
    if (text === undefined) continue;
    rows.push({ key: field.key, label: categoryText(lang, field.label), value: text });
  }
  return rows;
}

/** Услуги, выбранные в заявке (названия и цены — как были при подаче) */
export function chosenServices(
  category: CategoryConfig | undefined,
  details: RequestDetails,
): readonly ChosenServiceSnapshot[] {
  const field = category?.requestForm.fields.find((f) => f.type === "services");
  const value = details[field?.key ?? "services"];
  return isSnapshots(value) ? value : [];
}
