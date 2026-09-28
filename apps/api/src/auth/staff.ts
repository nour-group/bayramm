// Вход сотрудника через виджет Telegram (панель оператора).
//
// Данные виджета проверяются по подписи токеном бота; дальше — только Telegram
// ID (в базе — HMAC от него) и имя пользователя для приглашения. Найти
// сотрудника или принять приглашение может только app.staff_sign_in под
// актором system; сессия выдаётся в той же транзакции.

import { type LoginWidgetParams, verifyLoginWidget } from "@bayramm/tg";
import { sql } from "kysely";
import { type StaffRole, SYSTEM, withActor } from "../db/actor";
import type { Db } from "../db/client";
import { ApiError, forbidden } from "../errors";
import { generateToken, hashToken, telegramIdHash } from "./crypto";

// Виджет подписывает данные в момент нажатия «Войти», и браузер сразу несёт их
// сюда. Сутки по умолчанию — много для входа в панель: данные виджета проходят
// через адресную строку, и короткое окно ограничивает повтор
export const STAFF_AUTH_MAX_AGE_SECONDS = 10 * 60;
export const STAFF_SESSION_TTL_SECONDS = 12 * 60 * 60;

export interface StaffSession {
  token: string;
  expiresAt: Date;
  staff: { id: string; role: StaffRole };
}

interface Secrets {
  TELEGRAM_BOT_TOKEN: string;
  ID_HASH_KEY: string;
}

interface SignInRow {
  staff_id: string;
  role: StaffRole;
  claimed: boolean;
}

/**
 * Проверяет данные виджета и выдаёт сессию сотрудника.
 * Подпись не сошлась или устарела — 401; сотрудника нет, он отключён или
 * приглашение уже принято другим аккаунтом — одинаковый 403.
 */
export async function signInStaff(db: Db, env: Secrets, params: LoginWidgetParams): Promise<StaffSession> {
  const verified = await verifyLoginWidget(params, env.TELEGRAM_BOT_TOKEN, {
    maxAgeSeconds: STAFF_AUTH_MAX_AGE_SECONDS,
  });
  if (!verified.ok) {
    // Причина — только в лог: клиенту хватит 401
    console.warn("auth.staff: login widget rejected", verified.reason);
    throw new ApiError(401, "unauthorized", "Invalid Telegram login data");
  }
  const { user } = verified.data;

  const tgIdHash = await telegramIdHash(env.ID_HASH_KEY, user.id);
  const token = generateToken();
  const tokenHash = await hashToken(token);

  return withActor(db, SYSTEM, async (trx) => {
    const { rows } = await sql<SignInRow>`
      select staff_id, role, claimed
      from app.staff_sign_in(${tgIdHash}::bytea, ${user.id}::bigint, ${user.username ?? null}::text)`.execute(
      trx,
    );
    const staff = rows[0];
    if (staff === undefined) throw forbidden();
    if (staff.claimed) console.info("auth.staff: invite claimed", { staffId: staff.staff_id });

    const session = await trx
      .insertInto("app.sessions")
      .values({
        token_hash: tokenHash,
        staff_id: staff.staff_id,
        via: "tg_staff",
        expires_at: sql<Date>`now() + make_interval(secs => ${STAFF_SESSION_TTL_SECONDS})`,
      })
      .returning("expires_at")
      .executeTakeFirstOrThrow();

    return { token, expiresAt: session.expires_at, staff: { id: staff.staff_id, role: staff.role } };
  });
}
