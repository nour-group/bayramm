/* Ошибка обращения к API. code — стабильный код из тела ответа ({ error: { code } },
   apps/api/src/errors.ts); по нему экран выбирает текст. Свои коды клиента:
   network — запрос не дошёл, bad_response — ответ не JSON, no_session — нет входа
   через Telegram (обычный браузер). */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** 409 duplicate_request: id уже отправленной заявки на тот же листинг и дату */
  readonly existingId: string | undefined;

  constructor(status: number, code: string, existingId?: string) {
    super(`API ${status} ${code}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.existingId = existingId;
  }
}

export const isApiError = (error: unknown): error is ApiError => error instanceof ApiError;

export const isNotFound = (error: unknown) => isApiError(error) && error.status === 404;

/** Запрос отменён (экран ушёл или фильтр сменился) — это не ошибка для показа */
export const isAbort = (error: unknown) =>
  typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

/** Ошибка из ответа не-2xx: код из тела, иначе http_<статус> */
export async function errorFromResponse(res: Response): Promise<ApiError> {
  const body: unknown = await res.json().catch(() => null);
  const error = field(body, "error");
  const code = field(error, "code");
  // existingId по контракту — рядом с error; на всякий случай смотрим и внутрь
  const existingId = field(body, "existingId") ?? field(error, "existingId");
  return new ApiError(
    res.status,
    typeof code === "string" && code.length > 0 ? code : `http_${res.status}`,
    typeof existingId === "string" ? existingId : undefined,
  );
}
