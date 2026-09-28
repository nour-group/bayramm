// Срок годности подписанных данных Telegram (initData Mini App, виджет входа):
// общие опции и проверка auth_date.

export interface FreshnessOptions {
  /** Сколько секунд после подписи данные принимаются. По умолчанию сутки. */
  maxAgeSeconds?: number;
  /** Текущее время в миллисекундах, как у Date.now. Подменяется в тестах. */
  now?: () => number;
}

export const DEFAULT_MAX_AGE_SECONDS = 24 * 60 * 60;

// Часы телефона, серверов Telegram и Worker'а расходятся; дата из будущего дальше этого — не расхождение
const MAX_FUTURE_SKEW_SECONDS = 5 * 60;

export interface Freshness {
  maxAgeSeconds: number;
  now: () => number;
}

/** Опции с умолчаниями. Неверные — исключение: это ошибка конфигурации, а не плохой запрос. */
export function resolveFreshness(opts: FreshnessOptions): Freshness {
  const maxAgeSeconds = opts.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0) {
    throw new RangeError("@bayramm/tg: maxAgeSeconds должен быть положительным конечным числом");
  }
  return { maxAgeSeconds, now: opts.now ?? Date.now };
}

/**
 * auth_date из подписанных данных: unix-секунды или причина отказа.
 * Вызывать только после проверки подписи.
 */
export function readAuthDate(
  value: string | undefined,
  freshness: Freshness,
): { ok: true; authDate: number } | { ok: false; reason: "expired" | "malformed" } {
  if (value === undefined || !/^[1-9]\d{0,11}$/.test(value)) return { ok: false, reason: "malformed" };
  const authDate = Number(value);

  const nowMs = freshness.now();
  if (!Number.isFinite(nowMs)) throw new RangeError("@bayramm/tg: now() вернул не число");
  const nowSeconds = Math.floor(nowMs / 1000);
  if (nowSeconds - authDate > freshness.maxAgeSeconds || authDate - nowSeconds > MAX_FUTURE_SKEW_SECONDS) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, authDate };
}
