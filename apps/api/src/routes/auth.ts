// Вход через Telegram и выход.
//
//   POST /auth/telegram        { initData }      → 200 { token, expiresAt }  клиент, Mini App
//   POST /auth/staff/telegram  { поля виджета }  → 200 { token, expiresAt }  сотрудник, панель оператора
//   POST /auth/logout          (Bearer)          → 204                       любая сессия
//
// Подписанные данные Telegram проверяются токеном бота; всё, что в них есть,
// читается только после проверки. Клиент — псевдоним в app.clients (HMAC от
// Telegram ID), Telegram ID и имя — в pii.client_profiles. Сотрудник — см.
// auth/staff.ts. Сессия — случайный токен, в базе только его sha256.
//
// Ограничение частоты попыток входа сюда не входит: оно встаёт middleware перед
// маршрутами (src/ratelimit.ts), сами обработчики от него не зависят.

import { type TelegramUser, verifyInitData } from "@bayramm/tg";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { sql } from "kysely";
import { generateToken, hashToken, telegramIdHash } from "../auth/crypto";
import { authenticate, requireSession } from "../auth/session";
import { signInStaff } from "../auth/staff";
import { SYSTEM, type Tx, withActor } from "../db/actor";
import { database } from "../db/middleware";
import type { AppEnv } from "../env";
import { ApiError, clientBlocked } from "../errors";

// Mini App получает свежую initData при каждом открытии и сразу входит.
// Час — запас на медленную сеть и повтор, дольше подписанные данные не принимаем
export const INIT_DATA_MAX_AGE_SECONDS = 60 * 60;
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
// initData — около килобайта, пакет tg режет всё длиннее 16 КБ; данные виджета ещё меньше
const MAX_BODY_BYTES = 32 * 1024;

const USERNAME_RE = /^[A-Za-z0-9_]{4,32}$/;
const NAME_MAX = 128;

const limitBody = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: (c) => c.json(new ApiError(413, "payload_too_large", "Request body is too large").toBody(), 413),
});

export const auth = new Hono<AppEnv>();

auth.use(database);

auth.post("/telegram", limitBody, async (c) => {
  const initData = await readInitData(c.req.raw);

  const verified = await verifyInitData(initData, c.env.TELEGRAM_BOT_TOKEN, {
    maxAgeSeconds: INIT_DATA_MAX_AGE_SECONDS,
  });
  if (!verified.ok) {
    // Причина — только в лог: клиенту хватит 401
    console.warn("auth.telegram: initData rejected", verified.reason);
    throw new ApiError(401, "unauthorized", "Invalid Telegram init data");
  }
  const { user } = verified.data;

  const tgIdHash = await telegramIdHash(c.env.ID_HASH_KEY, user.id);
  const token = generateToken();
  const tokenHash = await hashToken(token);

  const session = await withActor(c.var.db, SYSTEM, async (trx) => {
    const client = await upsertClient(trx, tgIdHash, user);
    // Исключение откатывает транзакцию: заблокированному ничего не пишем
    if (client.blocked_at !== null) throw clientBlocked();
    await upsertProfile(trx, client.id, user);
    return trx
      .insertInto("app.sessions")
      .values({
        token_hash: tokenHash,
        client_id: client.id,
        via: "tg_client",
        expires_at: sql<Date>`now() + make_interval(secs => ${SESSION_TTL_SECONDS})`,
      })
      .returning("expires_at")
      .executeTakeFirstOrThrow();
  });

  return c.json({ token, expiresAt: session.expires_at.toISOString() });
});

// Панель оператора шлёт поля виджета как есть: id, first_name, username, auth_date, hash, …
auth.post("/staff/telegram", limitBody, async (c) => {
  const fields = await readJsonObject(c.req.raw);
  const session = await signInStaff(c.var.db, c.env, fields);
  return c.json({ token: session.token, expiresAt: session.expiresAt.toISOString() });
});

auth.post("/logout", authenticate, async (c) => {
  const { actor, sessionId } = requireSession(c);
  // Под актором сессии: RLS даёт отозвать только свою (сотрудник — привилегированный,
  // но id сессии берётся из его же токена)
  await withActor(c.var.db, actor, (trx) =>
    trx
      .updateTable("app.sessions")
      .set({ revoked_at: sql<Date>`now()` })
      .where("id", "=", sessionId)
      .where("revoked_at", "is", null)
      .execute(),
  );
  return c.body(null, 204);
});

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiError(400, "invalid_request", "Body must be JSON");
  }
}

async function readInitData(request: Request): Promise<string> {
  const body = await readJson(request);
  const initData =
    typeof body === "object" && body !== null ? (body as { initData?: unknown }).initData : undefined;
  if (typeof initData !== "string" || initData.length === 0) {
    throw new ApiError(400, "invalid_request", "initData is required");
  }
  return initData;
}

// Тело — JSON-объект; что в нём, решает проверка подписи (verifyLoginWidget)
async function readJsonObject(request: Request): Promise<Readonly<Record<string, unknown>>> {
  const body = await readJson(request);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError(400, "invalid_request", "Body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

// Язык Telegram → язык интерфейса; остальные языки — умолчание базы (uz)
function localeOf(languageCode: string | undefined): "ru" | "uz" | undefined {
  const lang = languageCode?.toLowerCase().split("-")[0];
  return lang === "ru" || lang === "uz" ? lang : undefined;
}

// Обрезка по символам, а не по UTF-16: length() в Postgres считает символы
function clip(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length > max ? chars.slice(0, max).join("") : value;
}

// Клиент по псевдониму: новый — создаём, известный — отмечаем визит.
// Язык выбирается только при создании: дальше его меняет сам клиент.
// can_message только включается: снять его может бот (пользователь заблокировал бота).
// Удалённый аккаунт при новом входе возвращается к жизни (профиль создаётся заново)
function upsertClient(trx: Tx, tgIdHash: Uint8Array, user: TelegramUser) {
  return trx
    .insertInto("app.clients")
    .values({
      tg_id_hash: tgIdHash,
      locale: localeOf(user.languageCode),
      can_message: user.allowsWriteToPm === true,
      last_seen_at: sql<Date>`now()`,
    })
    .onConflict((oc) =>
      oc.column("tg_id_hash").doUpdateSet({
        last_seen_at: sql<Date>`now()`,
        can_message: sql<boolean>`app.clients.can_message or excluded.can_message`,
        deleted_at: null,
      }),
    )
    .returning(["id", "blocked_at"])
    .executeTakeFirstOrThrow();
}

// Профиль с ПДн: Telegram ID и имя обновляются при каждом входе — в Telegram их меняют
async function upsertProfile(trx: Tx, clientId: string, user: TelegramUser): Promise<void> {
  await trx
    .insertInto("pii.client_profiles")
    .values({
      client_id: clientId,
      telegram_id: user.id,
      first_name: clip(user.firstName, NAME_MAX),
      last_name: user.lastName === undefined ? null : clip(user.lastName, NAME_MAX),
      username: user.username !== undefined && USERNAME_RE.test(user.username) ? user.username : null,
    })
    .onConflict((oc) =>
      oc.column("client_id").doUpdateSet((eb) => ({
        first_name: eb.ref("excluded.first_name"),
        last_name: eb.ref("excluded.last_name"),
        username: eb.ref("excluded.username"),
      })),
    )
    .execute();
}
