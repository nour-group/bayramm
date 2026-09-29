// Бот Telegram этого окружения.
//
//   GET  /telegram/bot                                   → 200 { username, miniAppUrl }
//   POST /telegram/sync  (Bearer <TELEGRAM_SYNC_KEY>)    → 200 { ok, results: [...] }
//   POST /telegram/webhook (X-Telegram-Bot-Api-Secret-Token) → 200 { ok: true }
//
// /bot — без входа: имя бота нужно странице входа панели оператора ещё до входа
// (виджет Telegram). Имя — из getMe (кэш на час), адрес Mini App — из переменной
// WEB_APP_URL. Telegram не ответил — 503.
//
// /sync — настройка бота из кода (telegram/bot-profile.ts), её вызывает деплой.
// Закрыт отдельным секретом TELEGRAM_SYNC_KEY: не задан — маршрута как будто нет
// (404), ключ не тот — 401. Отчёт — по каждому вызову; частичная неудача — тоже
// 200, с ok: false. Вебхук ставится на API_URL/telegram/webhook, только если
// API_URL — https (локально Telegram до API не достучится).
//
// /webhook — обновления от Telegram (bot/handler.ts). Секрет заголовка — не
// отдельный секрет, а производный от ID_HASH_KEY (telegram/webhook-secret.ts).
// Не тот секрет — 401. Всё, что бот не обрабатывает (не личный чат, не
// сообщение, повтор update_id), — 200 без действий, иначе Telegram повторял бы
// доставку. Ответы в чат уходят после ответа Telegram (waitUntil).

import { verifyWebhookSecret } from "@bayramm/tg";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { secretsEqual } from "../auth/crypto";
import { handleUpdate, type Reply } from "../bot/handler";
import { parseUpdate } from "../bot/update";
import { httpUrl } from "../config";
import { database } from "../db/middleware";
import type { AppEnv } from "../env";
import { ApiError, notFound, unauthorized } from "../errors";
import { BadBotInfoError, botUsername, defaultCache } from "../telegram/bot-info";
import { botProfile } from "../telegram/bot-profile";
import { type TelegramClient, TelegramError, telegramClient } from "../telegram/client";
import { syncBotProfile } from "../telegram/sync";
import { webhookSecret } from "../telegram/webhook-secret";

// Страница входа ждёт ответа: getMe — короткий, 5 секунд хватает с запасом
const BOT_INFO_TIMEOUT_MS = 5_000;
const SYNC_TIMEOUT_MS = 10_000;
const REPLY_TIMEOUT_MS = 10_000;
// Сообщение с контактом или командой — пара килобайт; больше — не наше, отбрасываем
const WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
// Браузеру можно не спрашивать имя бота чаще, чем раз в 5 минут
const BOT_INFO_CACHE_CONTROL = "public, max-age=300";
export const MIN_SYNC_KEY_LENGTH = 32;

const telegramUnavailable = () =>
  new ApiError(503, "telegram_unavailable", "Telegram is temporarily unavailable");

/** WEB_APP_URL без завершающего «/»; не http(s)-адрес — ошибка настройки */
const webAppUrl = (env: Pick<Env, "WEB_APP_URL">) => httpUrl("WEB_APP_URL", env.WEB_APP_URL);

/** Вебхук для setWebhook: только если API_URL — https (иначе Telegram его не примет) */
async function webhookTarget(env: Pick<Env, "API_URL" | "ID_HASH_KEY">) {
  const apiUrl = httpUrl("API_URL", env.API_URL);
  if (!apiUrl.startsWith("https://")) return undefined;
  return { url: `${apiUrl}/telegram/webhook`, secretToken: await webhookSecret(env.ID_HASH_KEY) };
}

// Секрет вебхука — до чтения тела и до базы
const requireWebhookSecret = createMiddleware<AppEnv>(async (c, next) => {
  if (!(await verifyWebhookSecret(c.req.raw, await webhookSecret(c.env.ID_HASH_KEY)))) throw unauthorized();
  await next();
});

// Слишком большое тело от Telegram — 200 и в лог: 413 Telegram повторял бы
const limitWebhookBody = bodyLimit({
  maxSize: WEBHOOK_MAX_BODY_BYTES,
  onError: (c) => {
    console.warn("telegram.webhook: body too large, update dropped");
    return c.json({ ok: true });
  },
});

// Ответы в чат — по очереди, после ответа Telegram. Неудача — в лог (без текста)
async function sendReplies(client: TelegramClient, replies: readonly Reply[]): Promise<void> {
  for (const reply of replies) {
    try {
      await client.call("sendMessage", reply);
    } catch (err) {
      if (!(err instanceof TelegramError)) throw err;
      console.warn("telegram.webhook: reply failed", {
        reason: err.reason,
        status: err.status,
        description: err.description,
      });
      return;
    }
  }
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
  const steps = botProfile({ webAppUrl: webAppUrl(c.env), webhook: await webhookTarget(c.env) });
  const client = telegramClient({ token: c.env.TELEGRAM_BOT_TOKEN, timeoutMs: SYNC_TIMEOUT_MS });
  const results = await syncBotProfile(client, steps);
  const ok = results.every((result) => result.ok);
  if (!ok)
    console.warn("telegram.sync: finished with failures", { failed: results.filter((r) => !r.ok).length });
  return c.json({ ok, results });
});

telegram.post("/webhook", requireWebhookSecret, limitWebhookBody, database, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    console.warn("telegram.webhook: body is not JSON, update dropped");
    return c.json({ ok: true });
  }
  const update = parseUpdate(body);
  if (update === null) return c.json({ ok: true });

  const replies = await handleUpdate(
    c.var.db,
    {
      idHashKey: c.env.ID_HASH_KEY,
      webAppUrl: webAppUrl(c.env),
      vendorAppUrl: httpUrl("VENDOR_APP_URL", c.env.VENDOR_APP_URL),
      adminAppUrl: httpUrl("ADMIN_APP_URL", c.env.ADMIN_APP_URL),
    },
    update,
  );
  if (replies.length > 0) {
    const client = telegramClient({ token: c.env.TELEGRAM_BOT_TOKEN, timeoutMs: REPLY_TIMEOUT_MS });
    c.executionCtx.waitUntil(
      sendReplies(client, replies).catch((err: unknown) => {
        console.error("telegram.webhook: replies failed", {
          error: err instanceof Error ? err.name : typeof err,
        });
      }),
    );
  }
  return c.json({ ok: true });
});
