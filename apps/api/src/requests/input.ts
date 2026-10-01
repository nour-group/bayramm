// Тело POST /requests: разбор и проверка до базы. Окончательно решают база и
// её триггеры (листинг активен, согласие действует, вместимость, лимит), здесь —
// всё, что можно отсечь по самим данным.
//
//   · даты — по Ташкенту: событие не раньше завтрашнего дня и не дальше двух лет;
//   · гостей 1–5000 (вместимость листинга проверяет база: BR015); нужно ли их число,
//     решает форма категории — это и поля категории (details) проверяет
//     requests/service.ts, когда известна витрина;
//   · телефон — +998 и 9 цифр; пробелы, дефисы и скобки убираются;
//   · имя до 80 символов, комментарий до 1000 — как ограничения таблицы request_contacts;
//   · согласие на передачу контактов обязательно: без него — 422 consent_required.

import { MAX_GUESTS } from "../catalog/query";
import { ApiError } from "../errors";
import { addDays, isIsoDate } from "../time";

export const MAX_UZS = 99_999_999_999;
export const EVENT_DATE_MAX_DAYS_AHEAD = 730;
export const CONTACT_NAME_MAX = 80;
export const COMMENT_MAX = 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_RE = /^[a-z_]{2,20}$/;
const PHONE_RE = /^\+998[0-9]{9}$/;
const PHONE_SEPARATORS_RE = /[\s\-()]/g;
// Управляющие символы: в имени — никакие, в комментарии — кроме перевода строки и табуляции
const CONTROL_RE = /\p{Cc}/u;
const COMMENT_CONTROL_RE = /[^\P{Cc}\n\r\t]/u;

export interface CreateRequestInput {
  readonly listingId: string;
  readonly occasionCode: string;
  readonly eventDate: string;
  /** null — не указано (обязательно ли — по форме категории) */
  readonly guests: number | null;
  /** Поля категории как пришли: проверяются по форме категории витрины */
  readonly details: unknown;
  readonly budgetMinUzs: number | null;
  readonly budgetMaxUzs: number | null;
  readonly contactName: string;
  readonly contactPhone: string;
  readonly comment: string | null;
  readonly requestTransferConsentId: string;
  readonly notifyConsentId: string | null;
}

/** Длина в символах, как length() в Postgres, а не в единицах UTF-16 */
const charLength = (value: string) => Array.from(value).length;

function uuid(value: unknown): string | null {
  return typeof value === "string" && UUID_RE.test(value) ? value.toLowerCase() : null;
}

function optionalInt(value: unknown, min: number, max: number): number | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : undefined;
}

/**
 * Проверенное тело заявки. today — «сегодня» по Ташкенту.
 * Неверные поля — 400 invalid_request, их имена — в details.
 */
export function parseCreateRequest(body: unknown, today: string): CreateRequestInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError(400, "invalid_request", "Body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  const bad: string[] = [];

  const listingId = uuid(b.listingId);
  if (listingId === null) bad.push("listingId");

  const occasionCode =
    typeof b.occasionCode === "string" && CODE_RE.test(b.occasionCode) ? b.occasionCode : null;
  if (occasionCode === null) bad.push("occasionCode");

  const eventDate =
    typeof b.eventDate === "string" &&
    isIsoDate(b.eventDate) &&
    b.eventDate > today &&
    b.eventDate <= addDays(today, EVENT_DATE_MAX_DAYS_AHEAD)
      ? b.eventDate
      : null;
  if (eventDate === null) bad.push("eventDate");

  const guests = optionalInt(b.guests, 1, MAX_GUESTS);
  if (guests === undefined) bad.push("guests");

  const details = b.details ?? null;
  if (details !== null && (typeof details !== "object" || Array.isArray(details))) bad.push("details");

  const budgetMin = optionalInt(b.budgetMinUzs, 0, MAX_UZS);
  if (budgetMin === undefined) bad.push("budgetMinUzs");
  const budgetMax = optionalInt(b.budgetMaxUzs, 1, MAX_UZS);
  if (budgetMax === undefined) bad.push("budgetMaxUzs");
  else if (budgetMax !== null && typeof budgetMin === "number" && budgetMax < budgetMin)
    bad.push("budgetMaxUzs");

  const name = typeof b.contactName === "string" ? b.contactName.trim() : "";
  const contactName =
    name.length > 0 && charLength(name) <= CONTACT_NAME_MAX && !CONTROL_RE.test(name) ? name : null;
  if (contactName === null) bad.push("contactName");

  const phone = typeof b.contactPhone === "string" ? b.contactPhone.replace(PHONE_SEPARATORS_RE, "") : "";
  const contactPhone = PHONE_RE.test(phone) ? phone : null;
  if (contactPhone === null) bad.push("contactPhone");

  let comment: string | null = null;
  if (typeof b.comment === "string") {
    const text = b.comment.trim();
    if (charLength(text) > COMMENT_MAX || COMMENT_CONTROL_RE.test(text)) bad.push("comment");
    else comment = text === "" ? null : text;
  } else if (b.comment !== undefined && b.comment !== null) {
    bad.push("comment");
  }

  const transferMissing = b.requestTransferConsentId === undefined || b.requestTransferConsentId === null;
  const requestTransferConsentId = uuid(b.requestTransferConsentId);
  if (requestTransferConsentId === null && !transferMissing) bad.push("requestTransferConsentId");

  const notifyMissing = b.notifyConsentId === undefined || b.notifyConsentId === null;
  const notifyConsentId = notifyMissing ? null : uuid(b.notifyConsentId);
  if (!notifyMissing && notifyConsentId === null) bad.push("notifyConsentId");

  if (bad.length > 0) throw new ApiError(400, "invalid_request", "Invalid request body", bad);
  // Галочка не предзаполнена и не отмечена — заявки без согласия не бывает
  if (requestTransferConsentId === null) throw consentRequired("requestTransferConsentId");

  return {
    listingId: listingId as string,
    occasionCode: occasionCode as string,
    eventDate: eventDate as string,
    guests: guests ?? null,
    details,
    budgetMinUzs: budgetMin ?? null,
    budgetMaxUzs: budgetMax ?? null,
    contactName: contactName as string,
    contactPhone: contactPhone as string,
    comment,
    requestTransferConsentId,
    notifyConsentId,
  };
}

export const consentRequired = (field: string) =>
  new ApiError(422, "consent_required", "Consent is required", [field]);
