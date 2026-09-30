// Cloudflare Turnstile: проверка «не робот» перед отправкой кода на телефон.
//
// Код входа уходит платным провайдером (SMS, Telegram Gateway) — без проверки скрипт
// может слать коды на чужие и платные номера за наш счёт (SMS pumping). Лимиты частоты
// (по IP и по номеру) это только замедляют.
//
// Включается секретом TURNSTILE_SECRET_KEY (wrangler secret put); публичный ключ виджета —
// переменная TURNSTILE_SITE_KEY, хаб берёт его из GET /auth/methods. Нет секрета —
// проверки нет: так локально и в окружениях без платного провайдера.
//
// Кому нужна: POST /auth/phone/send из браузера — хаб входа (/auth) на сайте, только там
// CSP пускает скрипт и фрейм challenges.cloudflare.com (turnstilePaths в воркере web).
// Mini App присылает вместо токена initData: подписанные Telegram данные не подделать,
// за каждыми — аккаунт Telegram и свежее открытие приложения из клиента (не старше часа,
// INIT_DATA_MAX_AGE_SECONDS). Такой запрос проверку пропускает — виджета в Mini App нет.
//
// Siteverify — только с сервера: remoteip (CF-Connecting-IP), idempotency_key (повтор
// после сбоя сети не считается вторым погашением токена). Принимается только
// success = true, action = phone_code и hostname — сайт окружения (WEB_APP_URL).
// Сбой siteverify — отказ (fail closed): 503, код не отправляется.

import { TURNSTILE_ACTION_PHONE } from "@bayramm/shared/api/account";
import { httpUrl } from "../config";
import { ApiError } from "../errors";

export { TURNSTILE_ACTION_PHONE };
export const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** Длиннее токен Turnstile не бывает */
export const TURNSTILE_TOKEN_MAX_LENGTH = 2048;
const SITEVERIFY_TIMEOUT_MS = 5_000;
// Один повтор после сбоя сети или 5xx — с тем же idempotency_key
const SITEVERIFY_ATTEMPTS = 2;

/* Тестовые секреты Cloudflare (developers.cloudflare.com/turnstile/troubleshooting/testing):
   принимают фиктивный токен тестового виджета. Годятся только локально: action и
   hostname в их ответе не настоящие и не сверяются. В staging и production такой
   секрет — ошибка настройки: отказ */
const TEST_SECRETS: ReadonlySet<string> = new Set([
  "1x0000000000000000000000000000000AA",
  "2x0000000000000000000000000000000AA",
  "3x0000000000000000000000000000000AA",
]);

export const turnstileRequired = () =>
  new ApiError(400, "turnstile_required", "Human check is required", ["turnstileToken"]);
export const turnstileFailed = () => new ApiError(403, "turnstile_failed", "Human check failed");
export const turnstileUnavailable = () =>
  new ApiError(503, "turnstile_unavailable", "Human check is unavailable, try again later");

export interface TurnstileEnv {
  readonly APP_ENV: string;
  readonly WEB_APP_URL: string;
  readonly TURNSTILE_SECRET_KEY?: string;
  readonly TURNSTILE_SITE_KEY?: string;
}

/** Проверка включена: задан секрет */
export function turnstileEnabled(env: TurnstileEnv): boolean {
  return typeof env.TURNSTILE_SECRET_KEY === "string" && env.TURNSTILE_SECRET_KEY.trim() !== "";
}

/**
 * Публичный ключ виджета для GET /auth/methods; null — проверка выключена. Секрет есть,
 * а ключа нет — ошибка настройки: хаб не покажет виджет, и код по телефону из браузера
 * не отправится (сервер ответит turnstile_required), пока ключ не зададут
 */
export function turnstileSiteKey(env: TurnstileEnv): string | null {
  if (!turnstileEnabled(env)) return null;
  const key = env.TURNSTILE_SITE_KEY?.trim() ?? "";
  if (key === "") {
    console.error("auth.turnstile: TURNSTILE_SECRET_KEY задан, а TURNSTILE_SITE_KEY — нет");
    return null;
  }
  return key;
}

/** Ответ siteverify: только поля, которые сверяем */
interface SiteverifyResult {
  readonly success?: unknown;
  readonly action?: unknown;
  readonly hostname?: unknown;
  readonly "error-codes"?: unknown;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface VerifyTurnstileOptions {
  /** Токен из виджета (cf-turnstile-response) */
  readonly token: unknown;
  /** IP посетителя (CF-Connecting-IP); нет — не передаём */
  readonly remoteIp: string | null;
  readonly action?: string;
  readonly fetch?: Fetch;
  readonly timeoutMs?: number;
}

/** Ответ siteverify после сбоя: null — не ответил (сеть, таймаут, 5xx, не JSON) */
async function siteverify(fetchFn: Fetch, body: URLSearchParams, timeoutMs: number) {
  for (let attempt = 1; attempt <= SITEVERIFY_ATTEMPTS; attempt++) {
    try {
      const res = await fetchFn(TURNSTILE_SITEVERIFY_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status >= 500) {
        console.warn("auth.turnstile: siteverify error", { status: res.status, attempt });
        continue;
      }
      return (await res.json()) as SiteverifyResult;
    } catch (err) {
      console.warn("auth.turnstile: siteverify unreachable", {
        reason: err instanceof Error ? err.name : typeof err,
        attempt,
      });
    }
  }
  return null;
}

/**
 * Токен Turnstile: проверка через siteverify. Нет токена — 400 turnstile_required;
 * токен не принят (неверный, истёк, уже погашен, чужие action или сайт) — 403
 * turnstile_failed; siteverify не ответил — 503 turnstile_unavailable. Вызывать, только
 * если turnstileEnabled(env)
 */
export async function verifyTurnstile(env: TurnstileEnv, options: VerifyTurnstileOptions): Promise<void> {
  const secret = env.TURNSTILE_SECRET_KEY?.trim() ?? "";
  if (secret === "") throw new Error("verifyTurnstile: TURNSTILE_SECRET_KEY не задан");
  const { token, remoteIp, action = TURNSTILE_ACTION_PHONE } = options;
  if (typeof token !== "string" || token.length === 0) throw turnstileRequired();
  if (token.length > TURNSTILE_TOKEN_MAX_LENGTH) throw turnstileFailed();

  const testSecret = TEST_SECRETS.has(secret);
  if (testSecret && env.APP_ENV !== "local") {
    console.error("auth.turnstile: тестовый секрет вне APP_ENV=local — проверка отклонена");
    throw turnstileUnavailable();
  }

  const body = new URLSearchParams({ secret, response: token, idempotency_key: crypto.randomUUID() });
  if (remoteIp) body.set("remoteip", remoteIp);
  const result = await siteverify(
    options.fetch ?? ((input, init) => fetch(input, init)),
    body,
    options.timeoutMs ?? SITEVERIFY_TIMEOUT_MS,
  );
  if (result === null) throw turnstileUnavailable();

  const errors = Array.isArray(result["error-codes"])
    ? result["error-codes"].filter((code): code is string => typeof code === "string").slice(0, 5)
    : [];
  if (result.success !== true) {
    // Ключ неверный — это наша настройка, а не посетитель
    if (errors.includes("invalid-input-secret") || errors.includes("missing-input-secret")) {
      console.error("auth.turnstile: siteverify отверг секрет", { errors });
      throw turnstileUnavailable();
    }
    console.info("auth.turnstile: token rejected", { errors });
    throw turnstileFailed();
  }
  if (testSecret) return;

  const hostname = new URL(httpUrl("WEB_APP_URL", env.WEB_APP_URL)).hostname;
  if (result.action !== action || result.hostname !== hostname) {
    // Токен чужого виджета или сайта: в лог — только то, что не совпало
    console.warn("auth.turnstile: token for another action or site", {
      action: result.action === action,
      hostname: result.hostname === hostname,
    });
    throw turnstileFailed();
  }
}
