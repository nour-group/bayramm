// Бот Telegram этого окружения.
//
//   GET  /telegram/bot                                   → 200 { username, miniAppUrl }
//   POST /telegram/sync  (Bearer <TELEGRAM_SYNC_KEY>)    → 200 { ok, results: [...] }
//
// /bot — без входа: имя бота нужно странице входа панели оператора ещё до входа
// (виджет Telegram). Имя — из getMe (кэш на час), адрес Mini App — из переменной
// WEB_APP_URL. Telegram не ответил — 503.
//
// /sync — настройка бота из кода (telegram/bot-profile.ts), её вызывает деплой.
// Закрыт отдельным секретом TELEGRAM_SYNC_KEY: не задан — маршрута как будто нет
// (404), ключ не тот — 401. Отчёт — по каждому вызову; частичная неудача — тоже
// 200, с ok: false.

import { trimTrailingSlashes } from "@bayramm/shared";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { secretsEqual } from "../auth/crypto";
import type { AppEnv } from "../env";
import { ApiError, notFound, unauthorized } from "../errors";
import { BadBotInfoError, botUsername, defaultCache } from "../telegram/bot-info";
import { botProfile } from "../telegram/bot-profile";
import { TelegramError, telegramClient } from "../telegram/client";
import { syncBotProfile } from "../telegram/sync";

// Страница входа ждёт ответа: getMe — короткий, 5 секунд хватает с запасом
const BOT_INFO_TIMEOUT_MS = 5_000;
const SYNC_TIMEOUT_MS = 10_000;
// Браузеру можно не спрашивать имя бота чаще, чем раз в 5 минут
const BOT_INFO_CACHE_CONTROL = "public, max-age=300";
export const MIN_SYNC_KEY_LENGTH = 32;

const telegramUnavailable = () =>
  new ApiError(503, "telegram_unavailable", "Telegram is temporarily unavailable");

/** WEB_APP_URL без завершающего «/»; не http(s)-адрес — ошибка настройки */
function webAppUrl(env: Pick<Env, "WEB_APP_URL">): string {
  const value = trimTrailingSlashes(env.WEB_APP_URL ?? "");
  const protocol = URL.canParse(value) ? new URL(value).protocol : null;
  if (protocol !== "https:" && protocol !== "http:") {
    throw new Error("WEB_APP_URL не задан или не http(s)-адрес");
  }
  return value;
}

// Ключ /sync: заголовок Authorization: Bearer <ключ>, сравнение за постоянное время
const requireSyncKey = createMiddleware<AppEnv>(async (c, next) => {
  const expected = c.env.TELEGRAM_SYNC_KEY;
  if (!expected) throw notFound();
  if (expected.length < MIN_SYNC_KEY_LENGTH) {
    // Ошибка настройки, а не запроса: короткий ключ легко подобрать
    throw new Error(`TELEGRAM_SYNC_KEY короче ${MIN_SYNC_KEY_LENGTH} символов`);
  }
  const received = /^Bearer (\S+)$/i.exec(c.req.header("Authorization")?.trim() ?? "")?.[1];
  if (received === undefined || !(await secretsEqual(received, expected))) throw unauthorized();
  await next();
});

export const telegram = new Hono<AppEnv>();

telegram.get("/bot", async (c) => {
  const miniAppUrl = webAppUrl(c.env);
  const token = c.env.TELEGRAM_BOT_TOKEN;
  let username: string;
  try {
    username = await botUsername({
      token,
      appEnv: c.env.APP_ENV,
      origin: new URL(c.req.url).origin,
      client: telegramClient({ token, timeoutMs: BOT_INFO_TIMEOUT_MS }),
      cache: defaultCache(),
      waitUntil: (promise) => c.executionCtx.waitUntil(promise),
    });
  } catch (err) {
    if (err instanceof TelegramError) {
      // Описание от Telegram — только в лог (токен из него вырезан клиентом)
      console.warn("telegram.bot: getMe failed", {
        reason: err.reason,
        status: err.status,
        description: err.description,
      });
      throw telegramUnavailable();
    }
    if (err instanceof BadBotInfoError) {
      console.warn("telegram.bot: getMe returned unexpected bot info");
      throw telegramUnavailable();
    }
    throw err;
  }
  return c.json({ username, miniAppUrl }, 200, { "cache-control": BOT_INFO_CACHE_CONTROL });
});

telegram.post("/sync", requireSyncKey, async (c) => {
  const steps = botProfile({ webAppUrl: webAppUrl(c.env) });
  const client = telegramClient({ token: c.env.TELEGRAM_BOT_TOKEN, timeoutMs: SYNC_TIMEOUT_MS });
  const results = await syncBotProfile(client, steps);
  const ok = results.every((result) => result.ok);
  if (!ok)
    console.warn("telegram.sync: finished with failures", { failed: results.filter((r) => !r.ok).length });
  return c.json({ ok, results });
});
