// Немедленная отправка уведомлений после записи — не дожидаясь cron.
//
// Уведомления ставят в app.outbox триггеры базы (новая заявка, смена статуса),
// поэтому маршруту, который пишет заявку, ничего не нужно делать для
// доставки: cron разберёт очередь в течение минуты. Чтобы не ждать и минуты —
// middleware outboxKick на такой маршрут (или kickOutbox в обработчике): после
// успешного ответа один проход отправителя в waitUntil. Best effort: неудача
// только в лог, строки останутся для cron.
//
//   requests.post("/", outboxKick, async (c) => { … });

import { createMiddleware } from "hono/factory";
import { httpUrl } from "../config";
import { createDb } from "../db/client";
import type { AppEnv } from "../env";
import { telegramClient } from "../telegram/client";
import { type DispatchDeps, dispatchOutbox } from "./outbox";
import type { Urls } from "./render";

/** Немедленный проход берёт немного: он живёт в waitUntil запроса */
export const KICK_BATCH = 10;
const SEND_TIMEOUT_MS = 10_000;

type OutboxEnv = Pick<
  Env,
  "HYPERDRIVE" | "TELEGRAM_BOT_TOKEN" | "WEB_APP_URL" | "VENDOR_APP_URL" | "ADMIN_APP_URL"
>;

export function outboxUrls(env: Pick<Env, "WEB_APP_URL" | "VENDOR_APP_URL" | "ADMIN_APP_URL">): Urls {
  return {
    webAppUrl: httpUrl("WEB_APP_URL", env.WEB_APP_URL),
    vendorAppUrl: httpUrl("VENDOR_APP_URL", env.VENDOR_APP_URL),
    adminAppUrl: httpUrl("ADMIN_APP_URL", env.ADMIN_APP_URL),
  };
}

/** Всё, кроме базы, что нужно отправителю: клиент Telegram и адреса приложений */
export function outboxDeps(env: Omit<OutboxEnv, "HYPERDRIVE">): Omit<DispatchDeps, "db"> {
  return {
    telegram: telegramClient({ token: env.TELEGRAM_BOT_TOKEN, timeoutMs: SEND_TIMEOUT_MS }),
    urls: outboxUrls(env),
  };
}

/** Один проход отправителя со своим пулом базы */
async function runOutbox(env: OutboxEnv, limit: number) {
  const db = createDb(env.HYPERDRIVE.connectionString);
  try {
    return await dispatchOutbox({ db, ...outboxDeps(env), limit });
  } finally {
    await db.destroy().catch(() => {});
  }
}

/** Отправить подошедшие уведомления после ответа (waitUntil) */
export function kickOutbox(env: OutboxEnv, waitUntil: (promise: Promise<unknown>) => void): void {
  waitUntil(
    runOutbox(env, KICK_BATCH).catch((err: unknown) => {
      console.warn("outbox: kick failed", { error: err instanceof Error ? err.name : typeof err });
    }),
  );
}

/** Middleware: после успешного ответа маршрута — kickOutbox */
export const outboxKick = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  if (c.res.status < 400) kickOutbox(c.env, (promise) => c.executionCtx.waitUntil(promise));
});
