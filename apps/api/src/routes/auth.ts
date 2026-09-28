// Вход клиента через Telegram Mini App и выход.
//
//   POST /auth/telegram { initData } → 200 { token, expiresAt }
//   POST /auth/logout   (Bearer)     → 204
//
// initData проверяется по подписи токеном бота; всё, что в ней есть, читается
// только после проверки. Клиент — псевдоним в app.clients (HMAC от Telegram ID),
// Telegram ID и имя — в pii.client_profiles. Сессия — случайный токен, в базе
// только его sha256.

import { type TelegramUser, verifyInitData } from "@bayramm/tg";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { sql } from "kysely";
import { generateToken, hashToken, telegramIdHash } from "../auth/crypto";
import { authenticate, requireClient } from "../auth/session";
import { SYSTEM, type Tx, withActor } from "../db/actor";
import { database } from "../db/middleware";
import type { AppEnv } from "../env";
import { ApiError, clientBlocked } from "../errors";

// Mini App получает свежую initData при каждом открытии и сразу входит.
// Час — запас на медленную сеть и повтор, дольше подписанные данные не принимаем
export const INIT_DATA_MAX_AGE_SECONDS = 60 * 60;
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
// initData — около килобайта, пакет tg режет всё длиннее 16 КБ
const MAX_BODY_BYTES = 32 * 1024;

const USERNAME_RE = /^[A-Za-z0-9_]{4,32}$/;
const NAME_MAX = 128;

export const auth = new Hono<AppEnv>();

auth.use(database);

auth.post(
  "/telegram",
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json(new ApiError(413, "payload_too_large", "Request body is too large").toBody(), 413),
  }),
  async (c) => {
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
  },
);

auth.post("/logout", authenticate, async (c) => {
  const { actor, sessionId } = requireClient(c);
  // Под актором клиента: RLS даёт отозвать только свою сессию
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

async function readInitData(request: Request): Promise<string> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError(400, "invalid_request", "Body must be JSON");
  }
  const initData =
    typeof body === "object" && body !== null ? (body as { initData?: unknown }).initData : undefined;
  if (typeof initData !== "string" || initData.length === 0) {
    throw new ApiError(400, "invalid_request", "initData is required");
  }
  return initData;
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
