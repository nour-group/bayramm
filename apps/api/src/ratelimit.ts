// Ограничение частоты запросов: вход (POST /auth/*) и создание заявки (POST /requests).
//
// Счётчики — привязки Workers Rate Limiting (ratelimits в wrangler.jsonc): окно 60 секунд,
// свой счётчик в каждой локации Cloudflare, подсчёт приблизительный. Это защита от
// скриптов и перебора, а не учёт: точный дневной лимит заявок — в базе.
//
//   POST /auth/*    — по IP                 RATE_LIMIT_AUTH_IP         30 в минуту
//   POST /me/identities/* — по IP           RATE_LIMIT_AUTH_IP         (тот же счётчик)
//   POST /ops/demo  — по IP                 RATE_LIMIT_AUTH_IP         (тот же; только staging,
//                                                                       ставит routes/ops.ts)
//   POST /requests  — по IP                 RATE_LIMIT_REQUESTS_IP     20 в минуту
//                   — по актору (клиенту)   RATE_LIMIT_REQUESTS_ACTOR   5 в минуту
//
// Лимиты по IP ставит mountRateLimits до маршрутов — до базы и проверки сессии.
// Ключ — HMAC(ID_HASH_KEY, IP) (auth/ip.ts): адрес не уходит даже в счётчик.
// Лимит по IP щедрый: у мобильных операторов за одним адресом много людей.
// Лимит по актору (limitByActor) стоит в самом маршруте после authenticate:
// ключ — вид и id актора из сессии (routes/requests.ts).
//
// Превышение — 429 { error: { code: "rate_limited" } }, Retry-After в секундах, no-store.
// Нет привязки или она упала — запрос проходит, причина в логе: лимит защищает от
// злоупотреблений, но сам не должен ронять вход.

import type { Context, Hono, MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import { clientIp, ipKey } from "./auth/ip";
import type { Actor } from "./db/actor";
import type { AppEnv } from "./env";
import { ApiError } from "./errors";

/** Окно всех лимитов (simple.period в wrangler.jsonc) — оно же Retry-After */
export const RATE_LIMIT_PERIOD_SECONDS = 60;

export type RateLimitBinding = "RATE_LIMIT_AUTH_IP" | "RATE_LIMIT_REQUESTS_IP" | "RATE_LIMIT_REQUESTS_ACTOR";

export const rateLimited = () => new ApiError(429, "rate_limited", "Too many requests");

function tooManyRequests(c: Context<AppEnv>): Response {
  return c.json(rateLimited().toBody(), 429, {
    "Retry-After": String(RATE_LIMIT_PERIOD_SECONDS),
    "Cache-Control": "no-store",
  });
}

/** true — пропустить; false — лимит исчерпан. Сбой привязки — пропустить. */
async function allowed(c: Context<AppEnv>, binding: RateLimitBinding, key: string): Promise<boolean> {
  const limiter = c.env[binding] as RateLimit | undefined;
  if (limiter === undefined) {
    console.error("ratelimit: нет привязки", binding);
    return true;
  }
  try {
    return (await limiter.limit({ key })).success;
  } catch (err) {
    console.error("ratelimit: привязка не ответила", binding, err);
    return true;
  }
}

/** Лимит по IP. Без CF-Connecting-IP (локально, в тестах) не применяется. */
export function limitByIp(binding: RateLimitBinding): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    const ip = clientIp(c.req.raw.headers);
    if (ip !== null && !(await allowed(c, binding, `ip:${await ipKey(c.env.ID_HASH_KEY, ip)}`))) {
      return tooManyRequests(c);
    }
    await next();
  });
}

function actorKey(actor: Actor | undefined): string | null {
  switch (actor?.kind) {
    case "account":
    case "client":
    case "staff":
    case "vendor_user":
      return `${actor.kind}:${actor.id}`;
    default:
      return null;
  }
}

/** Лимит по актору — после authenticate. Гость не считается: его отсечёт маршрут. */
export function limitByActor(binding: RateLimitBinding): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    const key = actorKey(c.get("actor"));
    if (key !== null && !(await allowed(c, binding, key))) return tooManyRequests(c);
    await next();
  });
}

/** Лимиты по IP перед маршрутами. Вызывать до app.route(...). */
export function mountRateLimits(app: Hono<AppEnv>): void {
  app.on("POST", "/auth/*", limitByIp("RATE_LIMIT_AUTH_IP"));
  // Добавление способа входа проверяет те же подписи и коды, что и вход
  app.on("POST", "/me/identities/*", limitByIp("RATE_LIMIT_AUTH_IP"));
  app.on("POST", "/requests", limitByIp("RATE_LIMIT_REQUESTS_IP"));
}
