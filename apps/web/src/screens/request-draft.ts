import type { Dict } from "@bayramm/shared";
import type { ConsentText, CreateRequest, ListingDetail, PublicService } from "@bayramm/shared/api";
import {
  type CategoryConfig,
  dayPartOf,
  hasDayParts,
  MAX_CHOSEN_SERVICES,
  type RequestField,
  validateRequestDetails,
} from "@bayramm/shared/categories";
import { addDays, formatQty, isIsoDate, isPhoneDigits, PHONE_PREFIX, phoneDigits } from "../format";
import { sessionGetJson, sessionRemove, sessionRemovePrefix, sessionSetJson } from "../storage";
import { parseGuests } from "./catalog-feed";
import { hasQty } from "./request-estimate";

/* Черновик заявки. Живёт в хранилище вкладки, пока заявка не ушла: ни одно поле, включая
   комментарий, не теряется при уходе на другой экран и возврате (в прототипе комментарий
   пропадал). Согласия в черновик не пишутся — их отмечают заново, осознанно.

   Поля формы — общие (повод, дата, гости по правилу категории, бюджет, имя, телефон,
   комментарий) и поля категории из её описания (requestForm.fields): время начала, часы,
   машины, вес, количество, доставка… и выбранные услуги витрины с количеством и опциями.
   Проверка — та же, что у сервера (validateRequestDetails), плюс то, что клиент знает
   заранее: срок заказа, занятая часть дня, минимальное количество услуги. */

/** Значение поля категории в черновике: число и время — строкой (как в поле), да/нет, коды */
export type DraftValue = string | boolean | readonly string[];

/** Выбранная услуга витрины: количество — строкой (как в поле), id опций */
export interface DraftService {
  readonly id: string;
  readonly qty: string;
  readonly options: readonly string[];
}

export interface Draft {
  readonly occasion: string | null;
  readonly date: string | null;
  readonly guests: string;
  /** Индекс диапазона из шкалы бюджета категории; null — не указан */
  readonly budget: number | null;
  readonly name: string;
  readonly phone: string;
  readonly comment: string;
  /** Поля категории, кроме выбора услуг: ключ поля → значение */
  readonly values: Readonly<Record<string, DraftValue>>;
  readonly services: readonly DraftService[];
}

export const EMPTY_DRAFT: Draft = {
  occasion: null,
  date: null,
  guests: "",
  budget: null,
  name: "",
  phone: "",
  comment: "",
  values: {},
  services: [],
};

type Budgets = readonly ({ readonly min?: number; readonly max?: number } | null)[];

/** Диапазоны бюджета зала в порядке t.budgets; последний — «пока не знаю» (без бюджета) */
export const BUDGETS: Budgets = [
  { max: 30_000_000 },
  { min: 30_000_000, max: 50_000_000 },
  { min: 50_000_000, max: 80_000_000 },
  { min: 80_000_000 },
  null,
];

/** Диапазоны бюджета остальных категорий (кортеж, фото, торт…) в порядке t.budgetsSmall */
export const BUDGETS_SMALL: Budgets = [
  { max: 3_000_000 },
  { min: 3_000_000, max: 7_000_000 },
  { min: 7_000_000, max: 15_000_000 },
  { min: 15_000_000 },
  null,
];

/** Шкала бюджета категории: у залов суммы на десятки миллионов, у остальных — меньше */
export const budgetScale = (category: CategoryConfig): Budgets =>
  category.code === "hall" ? BUDGETS : BUDGETS_SMALL;

/** Как у API (CONTACT_NAME_MAX) */
export const NAME_MAX = 80;

/** Дата события — с завтрашнего дня и не дальше двух лет (как проверяет API) */
export const EVENT_MAX_DAYS_AHEAD = 730;
export const COMMENT_MAX = 1000;

const DRAFT_PREFIX = "bayramm.web.draft.";
const draftKey = (slug: string) => `${DRAFT_PREFIX}${slug}`;

/** Все черновики вкладки (в них телефон и имя) — после удаления аккаунта */
export function clearDrafts(): void {
  sessionRemovePrefix(DRAFT_PREFIX);
}

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isDraftValue = (value: unknown): value is DraftValue =>
  typeof value === "string" || typeof value === "boolean" || isStringList(value);

const isDraftService = (value: unknown): value is DraftService => {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return typeof s.id === "string" && typeof s.qty === "string" && isStringList(s.options);
};

/** Черновик из хранилища; прежний вид (без полей категории) — тоже, поля категории пустые */
function readDraft(value: unknown): Draft | null {
  if (typeof value !== "object" || value === null) return null;
  const d = value as Record<string, unknown>;
  const optString = (v: unknown) => v === null || typeof v === "string";
  const base =
    optString(d.occasion) &&
    optString(d.date) &&
    typeof d.guests === "string" &&
    (d.budget === null || (typeof d.budget === "number" && Number.isInteger(d.budget))) &&
    typeof d.name === "string" &&
    typeof d.phone === "string" &&
    typeof d.comment === "string";
  if (!base) return null;
  const values =
    typeof d.values === "object" && d.values !== null && !Array.isArray(d.values)
      ? Object.fromEntries(Object.entries(d.values).filter(([, v]) => isDraftValue(v)))
      : {};
  const services = Array.isArray(d.services) ? d.services.filter(isDraftService) : [];
  return { ...(d as unknown as Draft), values, services };
}

const anyJson = (value: unknown): value is unknown => value !== undefined;

export const loadDraft = (slug: string): Draft | null => readDraft(sessionGetJson(draftKey(slug), anyJson));
export const saveDraft = (slug: string, draft: Draft) => sessionSetJson(draftKey(slug), draft);
export const clearDraft = (slug: string) => sessionRemove(draftKey(slug));

/** Услуги, отмеченные на витрине «в заявку»: черновик формы подхватит их */
export function draftServiceIds(slug: string): string[] {
  return (loadDraft(slug)?.services ?? []).map((s) => s.id);
}

/** Отметить или снять услугу «в заявку» прямо на витрине */
export function toggleDraftService(slug: string, service: PublicService, suggestedQty: string): string[] {
  const draft = loadDraft(slug) ?? EMPTY_DRAFT;
  const on = draft.services.some((s) => s.id === service.id);
  const services = on
    ? draft.services.filter((s) => s.id !== service.id)
    : [...draft.services, { id: service.id, qty: suggestedQty, options: [] }].slice(0, MAX_CHOSEN_SERVICES);
  saveDraft(slug, { ...draft, services });
  return services.map((s) => s.id);
}

// ── поля формы ─────────────────────────────────────────────────────────────

/** Поля категории без выбора услуг — по порядку формы */
export type DetailField = Exclude<RequestField, { type: "services" }>;

export const detailFields = (category: CategoryConfig): DetailField[] =>
  category.requestForm.fields.filter((f): f is DetailField => f.type !== "services");

export const servicesField = (category: CategoryConfig) =>
  category.requestForm.fields.find((f) => f.type === "services");

/**
 * Поле категории показывается: район доставки — только при доставке (самовывозу он не нужен)
 */
export function fieldShown(field: DetailField, values: Draft["values"]): boolean {
  if (field.key === "delivery_district") return values.fulfillment === "delivery";
  return true;
}

/**
 * Ключи ошибок формы: общие поля, «d.<ключ>» — поле категории, services — выбор услуг,
 * «svc.<id>» — количество выбранной услуги
 */
export type Field =
  | "occasion"
  | "date"
  | "guests"
  | "name"
  | "phone"
  | "consent"
  | "services"
  | `d.${string}`
  | `svc.${string}`;

/** Поля в порядке формы: к первой ошибке переводим фокус */
export function fieldOrder(category: CategoryConfig, draft: Draft): Field[] {
  return [
    "occasion",
    "date",
    ...(category.requestForm.guests === "hidden" ? [] : (["guests"] as const)),
    ...detailFields(category).map((f) => `d.${f.key}` as const),
    "services",
    ...draft.services.map((s) => `svc.${s.id}` as const),
    "name",
    "phone",
    "consent",
  ];
}

/** Срок заказа: поле витрины lead_days и срок выбранных услуг — как у сервера */
export function leadDaysOf(
  listing: Pick<ListingDetail, "attributes" | "services">,
  chosen: readonly string[],
): number {
  const own = listing.attributes.lead_days;
  let days = typeof own === "number" && Number.isSafeInteger(own) && own > 0 ? own : 0;
  for (const service of listing.services)
    if (chosen.includes(service.id)) days = Math.max(days, service.leadDays ?? 0);
  return days;
}

/** Первая дата, на которую можно подать заявку: завтра или позже срока заказа */
export const firstDate = (today: string, leadDays: number) => addDays(today, Math.max(1, leadDays));

/**
 * Свободные дни рядом с занятым — вместо него: по обе стороны, сначала ближние, по порядку дат.
 * Не раньше first (завтра или срок заказа) и не позже last. Частично занятый день (parts) —
 * свободный: часть дня выбирают в форме заявки
 */
export function nearbyFreeDays(
  busy: ReadonlySet<string>,
  day: string,
  range: { readonly first: string; readonly last: string },
  count = 3,
): string[] {
  const found: string[] = [];
  for (let step = 1; step <= 60 && found.length < count; step++) {
    for (const candidate of [addDays(day, -step), addDays(day, step)]) {
      if (found.length < count && candidate >= range.first && candidate <= range.last && !busy.has(candidate))
        found.push(candidate);
    }
  }
  return found.sort();
}

/** Число из поля «количество»: целое ≥ 1 или null */
export function parseQty(text: string): number | null {
  if (!/^\d{1,6}$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= 1 ? n : null;
}

/**
 * Поля категории для API (details): числа — числами, пустое не передаётся, услуги —
 * { id, qty, options } (количество — только у штучных единиц: час, кг, штука, комплект, стол)
 */
export function toDetails(category: CategoryConfig, listing: Pick<ListingDetail, "services">, draft: Draft) {
  const out: Record<string, unknown> = {};
  for (const field of detailFields(category)) {
    if (!fieldShown(field, draft.values)) continue;
    const value = draft.values[field.key];
    if (value === undefined || value === "" || value === false) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (field.type === "int") {
      const text = String(value).trim();
      out[field.key] = /^\d{1,9}$/.test(text) ? Number(text) : text;
    } else out[field.key] = value;
  }
  const services = servicesField(category);
  if (services && draft.services.length > 0) {
    out[services.key] = draft.services.map((chosen) => {
      const service = listing.services.find((s) => s.id === chosen.id);
      const qty = service && hasQty(service.priceUnit) ? parseQty(chosen.qty) : null;
      return { id: chosen.id, qty, options: chosen.options };
    });
  }
  return out;
}

/** Тексты ошибок — из словаря клиента */
export type ErrorTexts = Dict;

export interface ValidateContext {
  readonly listing: Pick<ListingDetail, "capMax" | "attributes" | "services" | "busyParts">;
  readonly category: CategoryConfig;
  readonly busy: ReadonlySet<string>;
  readonly today: string;
  readonly transferChecked: boolean;
}

/** Текст ошибки поля категории по пути из validateRequestDetails */
function detailError(field: DetailField, missing: boolean, t: ErrorTexts): string {
  switch (field.type) {
    case "int":
      return missing ? t.errRequired : t.errRange(field.min, field.max);
    case "time":
      return t.errTime;
    case "multi":
      return t.errChooseSome;
    case "enum":
    case "district":
      return t.errChoose;
    case "bool":
      return t.errInvalid;
  }
}

export function validate(
  draft: Draft,
  context: ValidateContext,
  t: ErrorTexts,
): Partial<Record<Field, string>> {
  const { listing, category, today } = context;
  const errors: Partial<Record<Field, string>> = {};
  if (!draft.occasion) errors.occasion = t.errOcc;

  // Дата: с завтрашнего дня (и не раньше срока заказа), не занята целиком
  const lead = leadDaysOf(
    listing,
    draft.services.map((s) => s.id),
  );
  const first = firstDate(today, lead);
  if (!isIsoDate(draft.date) || draft.date <= today || draft.date > addDays(today, EVENT_MAX_DAYS_AHEAD))
    errors.date = t.errDate;
  else if (context.busy.has(draft.date)) errors.date = t.errDateBusy;
  else if (draft.date < first) {
    const date = new Date(`${first}T00:00:00Z`);
    errors.date = t.errLead(lead, t.dayMonth(date.getUTCDate(), t.monthsShort[date.getUTCMonth()] ?? ""));
  }

  // Гости — по правилу формы категории; вместимость — у залов
  const mode = category.requestForm.guests;
  const guests = parseGuests(draft.guests);
  if (mode === "required" && guests === null) errors.guests = t.errGuests;
  else if (mode === "optional" && draft.guests.trim() !== "" && guests === null) errors.guests = t.errGuests;
  else if (mode !== "hidden" && guests !== null && listing.capMax !== null && guests > listing.capMax)
    errors.guests = t.errGuestsMax(listing.capMax);

  // Поля категории — те же правила, что у сервера
  const details = toDetails(category, listing, draft);
  const parsed = validateRequestDetails(category, details);
  if (!parsed.ok) {
    for (const path of parsed.errors) {
      const [, key = "", index, sub] = path.split(".");
      const field = detailFields(category).find((f) => f.key === key);
      if (field) {
        errors[`d.${key}`] ??= detailError(field, details[key] === undefined, t);
        continue;
      }
      if (key === servicesField(category)?.key) {
        const chosen = index === undefined ? undefined : draft.services[Number(index)];
        if (chosen && sub === "qty") errors[`svc.${chosen.id}`] ??= t.errQty;
        else errors.services ??= t.errServices;
      }
    }
  }
  if (draft.services.length > MAX_CHOSEN_SERVICES) errors.services = t.errServices;

  // Количество услуги — не меньше минимального у вендора
  for (const chosen of draft.services) {
    const service = listing.services.find((s) => s.id === chosen.id);
    if (!service || !hasQty(service.priceUnit)) continue;
    const qty = parseQty(chosen.qty);
    if (qty === null) errors[`svc.${chosen.id}`] ??= t.errQty;
    else if (service.minQty !== null && qty < service.minQty)
      errors[`svc.${chosen.id}`] ??= t.errMinQty(formatQty(service.priceUnit, service.minQty, t) ?? "");
  }

  // Часть дня (кортеж, фото, декор): время начала попадает в занятую часть
  const start = draft.values.start_time;
  if (
    hasDayParts(category) &&
    typeof start === "string" &&
    start &&
    isIsoDate(draft.date) &&
    !errors["d.start_time"]
  ) {
    const part = dayPartOf(category, start);
    const busyParts = listing.busyParts.find((p) => p.date === draft.date)?.parts ?? [];
    if (busyParts.includes(part)) errors["d.start_time"] = t.errPartBusy(t.dayPartName(part));
  }

  if (draft.name.trim().length === 0) errors.name = t.errRequired;
  if (!isPhoneDigits(phoneDigits(draft.phone))) errors.phone = t.errPhone;
  if (!context.transferChecked) errors.consent = t.errConsent;
  return errors;
}

/** Тело POST /requests из проверенного черновика */
export function toCreateRequest(
  draft: Draft,
  listing: Pick<ListingDetail, "id" | "services">,
  category: CategoryConfig,
  consents: { readonly transfer: ConsentText; readonly notify: ConsentText | null },
): CreateRequest {
  const scale = budgetScale(category);
  const budget = draft.budget === null ? null : (scale[draft.budget] ?? null);
  const comment = draft.comment.trim();
  const guests = category.requestForm.guests === "hidden" ? null : parseGuests(draft.guests);
  const details = toDetails(category, listing, draft);
  return {
    listingId: listing.id,
    occasionCode: draft.occasion ?? "",
    eventDate: draft.date ?? "",
    // Гости — по правилу формы категории: hidden не передаётся вовсе (иначе 400)
    ...(guests !== null ? { guests } : {}),
    ...(Object.keys(details).length > 0 ? { details } : {}),
    ...(budget?.min !== undefined ? { budgetMinUzs: budget.min } : {}),
    ...(budget?.max !== undefined ? { budgetMaxUzs: budget.max } : {}),
    contactName: draft.name.trim().slice(0, NAME_MAX),
    contactPhone: `${PHONE_PREFIX}${phoneDigits(draft.phone)}`,
    ...(comment ? { comment: comment.slice(0, COMMENT_MAX) } : {}),
    requestTransferConsentId: consents.transfer.id,
    ...(consents.notify ? { notifyConsentId: consents.notify.id } : {}),
  };
}
