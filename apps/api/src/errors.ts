// Ошибки API: единый формат ответа и перевод ошибок Postgres в HTTP — только здесь.
//
// Формат: { "error": { "code": "…", "message": "…", "details"?: [...] } }
// code — стабильный машинный код (по нему клиент выбирает текст на RU/UZ),
// message — короткое пояснение для разработчика, не для показа пользователю.

import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export interface ErrorBody {
  error: { code: string; message: string; details?: string[] };
  /** Рядом с error — только идентификаторы (duplicate_request → existingId) */
  readonly [extra: string]: unknown;
}

export class ApiError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;
  readonly details: string[] | undefined;
  readonly extra: Readonly<Record<string, string>> | undefined;

  constructor(
    status: ContentfulStatusCode,
    code: string,
    message: string,
    details?: string[],
    extra?: Readonly<Record<string, string>>,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.extra = extra;
  }

  toBody(): ErrorBody {
    const error: ErrorBody["error"] = { code: this.code, message: this.message };
    if (this.details !== undefined) error.details = this.details;
    return { ...this.extra, error };
  }
}

export const notFound = () => new ApiError(404, "not_found", "Not found");
export const unauthorized = () => new ApiError(401, "unauthorized", "Authentication required");
// Вход есть, прав нет: чужой вид сессии, не та роль, сотрудник не найден.
// Одинаково для всех случаев — по ответу не узнать, чего именно не хватило
export const forbidden = () => new ApiError(403, "forbidden", "Access denied");
export const clientBlocked = () => new ApiError(403, "client_blocked", "Account is blocked");
// Оптимистичная блокировка: запись изменили после того, как её прочли
export const versionConflict = () =>
  new ApiError(409, "version_conflict", "Record was changed by someone else — reload it");
const internalError = () => new ApiError(500, "internal_error", "Internal error");

// Уникальные ограничения, о которых интерфейсу нужно сказать по-человечески
const UNIQUE_CONSTRAINTS: Readonly<Record<string, { code: string; message: string }>> = {
  requests_client_listing_date_uq: {
    code: "duplicate_request",
    message: "Request for this listing and date already exists",
  },
  photos_dedupe: { code: "duplicate_photo", message: "This photo is already uploaded" },
  listings_slug_key: { code: "slug_taken", message: "This address is already taken" },
  vendor_contacts_stir_key: { code: "stir_taken", message: "This STIR belongs to another vendor" },
  vendor_users_vendor_phone_key: {
    code: "phone_taken",
    message: "This phone is already used by this vendor",
  },
  listing_packages_day_kind: { code: "duplicate_package", message: "Package of this kind already exists" },
  // app.assert_staff_username_free: имя пользователя Telegram у действующего сотрудника
  staff_profiles_telegram_username_active: {
    code: "username_taken",
    message: "This Telegram username belongs to an active staff member",
  },
};

// ── ошибки Postgres ────────────────────────────────────────────────────────

/** Поля DatabaseError из pg, которые нам нужны. detail не логируем: в нём бывают значения. */
export interface PgError extends Error {
  code: string;
  severity: string;
  detail?: string | undefined;
  constraint?: string | undefined;
  table?: string | undefined;
  schema?: string | undefined;
  column?: string | undefined;
}

// SQLSTATE — 5 символов [0-9A-Z]. severity отличает ошибку сервера от системной
// ошибки Node с похожим кодом (EPIPE тоже пять заглавных букв)
export function isPgError(err: unknown): err is PgError {
  if (!(err instanceof Error)) return false;
  const { code, severity } = err as Partial<PgError>;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) && typeof severity === "string";
}

interface Rule {
  status: ContentfulStatusCode;
  code: string;
  message: string;
}

// Бизнес-правила из триггеров (SQLSTATE класса BR, список — в заголовках миграций
// 20260928120100_core.sql и следующих). Нарушение состояния — 409, неверные
// данные — 422, действие не по роли и блокировка клиента — 403, лимит — 429
export const BUSINESS_RULES: Readonly<Record<string, Rule>> = {
  BR001: { status: 409, code: "append_only", message: "Record is append-only" },
  BR002: { status: 409, code: "illegal_transition", message: "Status transition is not allowed" },
  BR003: { status: 403, code: "forbidden_for_actor", message: "Action is not allowed for this actor" },
  BR004: { status: 422, code: "publish_blocked", message: "Listing is not ready to be published" },
  BR005: {
    status: 409,
    code: "moderated_field_requires_revision",
    message: "Field changes require a moderated revision",
  },
  BR006: { status: 422, code: "immutable_column", message: "Field cannot be changed" },
  BR007: { status: 409, code: "listing_not_active", message: "Listing is not active" },
  BR008: { status: 403, code: "client_blocked", message: "Account is blocked" },
  BR009: { status: 422, code: "consent_required", message: "Consent is required" },
  BR010: { status: 422, code: "reason_required", message: "Reason is required" },
  BR011: { status: 409, code: "too_many_photos", message: "Photo limit reached" },
  BR012: { status: 409, code: "checklist_locked", message: "Checklist is locked while listings are active" },
  BR013: { status: 409, code: "consent_text_not_current", message: "Consent text is not current" },
  // 20260930110000_client_api.sql
  BR014: { status: 429, code: "daily_request_limit", message: "Daily request limit reached" },
  BR015: { status: 422, code: "guests_over_capacity", message: "Guests exceed listing capacity" },
  // 20260930180000_admin_v02.sql
  BR016: { status: 429, code: "reminder_too_soon", message: "Vendor was reminded recently" },
  BR017: { status: 409, code: "staff_last_admin", message: "At least one active admin must remain" },
  BR018: { status: 409, code: "staff_self", message: "Staff cannot change their own access" },
  BR019: { status: 409, code: "request_not_awaiting", message: "Request is not awaiting a vendor response" },
  BR020: { status: 409, code: "vendor_unreachable", message: "Vendor has no Telegram-linked users" },
};

// У publish_blocked в DETAIL — коды недостающих пунктов через запятую
// (price, photos, …): их можно отдать клиенту для экрана «чего не хватает»
function publishBlockers(detail: string | undefined): string[] {
  return (detail ?? "").split(",").filter((item) => /^[a-z_]{1,40}$/.test(item));
}

export function fromPgError(err: PgError): ApiError {
  const rule = BUSINESS_RULES[err.code];
  if (rule) {
    const details = err.code === "BR004" ? publishBlockers(err.detail) : undefined;
    return new ApiError(rule.status, rule.code, rule.message, details);
  }
  if (err.code.startsWith("BR")) {
    // Новый код в базе, а здесь его ещё нет (тест сверяет список с миграцией)
    return new ApiError(422, "rule_violation", "Business rule violation");
  }

  switch (err.code) {
    case "23505": {
      // unique_violation
      const known = err.constraint === undefined ? undefined : UNIQUE_CONSTRAINTS[err.constraint];
      if (known) return new ApiError(409, known.code, known.message);
      return new ApiError(409, "conflict", "Already exists");
    }
    // RLS (WITH CHECK) и права: чужой объект для клиента не существует — не
    // подтверждаем, что он есть. 23503 — ссылка на несуществующий объект: тоже 404,
    // иначе по разнице ответов можно перебирать id
    case "42501": // insufficient_privilege
    case "23503": // foreign_key_violation
      return notFound();
    case "23502": // not_null_violation
    case "23514": // check_violation
      return new ApiError(422, "invalid_input", "Invalid input");
  }

  switch (err.code.slice(0, 2)) {
    case "22": // data_exception: формат, длина, диапазон
      return new ApiError(422, "invalid_input", "Invalid input");
    case "08": // connection_exception
    case "53": // insufficient_resources
    case "57": // operator_intervention (в т.ч. statement_timeout)
      return new ApiError(503, "service_unavailable", "Service temporarily unavailable");
  }
  return internalError();
}

// HTTPException из middleware Hono — код по статусу
const HTTP_CODES: Partial<Record<ContentfulStatusCode, string>> = {
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  413: "payload_too_large",
};

export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof HTTPException) {
    if (err.status >= 500) return internalError();
    return new ApiError(
      err.status,
      HTTP_CODES[err.status] ?? "invalid_request",
      err.message || "Invalid request",
    );
  }
  if (isPgError(err)) return fromPgError(err);
  return internalError();
}

function log(err: unknown, apiError: ApiError): void {
  if (isPgError(err)) {
    // Без detail и текста ошибки: там бывают значения из запроса.
    // 42501 пишем с текстом («permission denied for …», «violates row-level
    // security policy for table …») — так видно ошибку кода, спрятанную за 404
    const entry = {
      sqlstate: err.code,
      constraint: err.constraint,
      table: err.schema && err.table ? `${err.schema}.${err.table}` : err.table,
      column: err.column,
      ...(err.code === "42501" ? { message: err.message } : {}),
    };
    if (apiError.status >= 500) console.error("db error", entry);
    else console.warn("db error", entry);
    return;
  }
  if (apiError.status >= 500) console.error("unhandled error", err);
}

/** Обработчик для app.onError: всё, что долетело до верха, — в едином формате. */
export function handleError(err: unknown, c: Context): Response {
  const apiError = toApiError(err);
  log(err, apiError);
  return c.json(apiError.toBody(), apiError.status);
}
