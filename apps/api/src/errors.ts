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
}

export class ApiError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;
  readonly details: string[] | undefined;

  constructor(status: ContentfulStatusCode, code: string, message: string, details?: string[]) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toBody(): ErrorBody {
    const error: ErrorBody["error"] = { code: this.code, message: this.message };
    if (this.details !== undefined) error.details = this.details;
    return { error };
  }
}

export const notFound = () => new ApiError(404, "not_found", "Not found");
export const unauthorized = () => new ApiError(401, "unauthorized", "Authentication required");
// Вход есть, прав нет: чужой вид сессии, не та роль, сотрудник не найден.
// Одинаково для всех случаев — по ответу не узнать, чего именно не хватило
export const forbidden = () => new ApiError(403, "forbidden", "Access denied");
export const clientBlocked = () => new ApiError(403, "client_blocked", "Account is blocked");
const internalError = () => new ApiError(500, "internal_error", "Internal error");

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

// Бизнес-правила из триггеров (SQLSTATE класса BR, список — в заголовке миграции
// 20260928120100_core.sql). Нарушение состояния — 409, неверные данные — 422,
// действие не по роли и блокировка клиента — 403
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
    case "23505": // unique_violation
      return err.constraint === "requests_client_listing_date_uq"
        ? new ApiError(409, "duplicate_request", "Request for this listing and date already exists")
        : new ApiError(409, "conflict", "Already exists");
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
