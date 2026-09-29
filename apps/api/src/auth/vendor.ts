// Вход в кабинет вендора (Mini App, открытый из бота).
//
// Пользователя вендора заводит сотрудник — с телефоном. Привязка к Telegram —
// в боте: вендор делится своим контактом, вебхук находит пользователя по
// телефону и записывает app.vendor_users.tg_user_hash = HMAC(ID_HASH_KEY,
// Telegram ID) — тот же псевдоним, что у клиентов. Здесь — только вход:
// initData проверяется по подписи токеном бота, пользователь ищется по этому
// псевдониму под актором system, сессия выдаётся в той же транзакции.

import { verifyInitData } from "@bayramm/tg";
import { sql } from "kysely";
import { SYSTEM, withActor } from "../db/actor";
import type { Db } from "../db/client";
import { ApiError } from "../errors";
import { generateToken, hashToken, telegramIdHash } from "./crypto";

// Как у клиента: Mini App получает свежую initData при каждом открытии
export const VENDOR_INIT_DATA_MAX_AGE_SECONDS = 60 * 60;
// Сессия кабинета — рабочая смена; дальше — снова вход из бота
export const VENDOR_SESSION_TTL_SECONDS = 12 * 60 * 60;

export interface VendorSession {
  token: string;
  expiresAt: Date;
  vendorUser: { id: string; vendorId: string };
}

interface Secrets {
  TELEGRAM_BOT_TOKEN: string;
  ID_HASH_KEY: string;
}

// Коды 403 — стабильные: по ним кабинет объясняет, что делать дальше
export const vendorNotLinked = () =>
  new ApiError(403, "vendor_not_linked", "Telegram account is not linked to a vendor");
export const vendorDisabled = () => new ApiError(403, "vendor_disabled", "Vendor access is disabled");

// Язык Telegram → язык кабинета; остальные языки — не трогаем
function localeOf(languageCode: string | undefined): "ru" | "uz" | null {
  const lang = languageCode?.toLowerCase().split("-")[0];
  return lang === "ru" || lang === "uz" ? lang : null;
}

/**
 * Проверяет initData и выдаёт сессию кабинета.
 * Подпись не сошлась или устарела — 401; Telegram не привязан ни к одному
 * пользователю вендора — 403 vendor_not_linked; пользователь отключён — 403
 * vendor_disabled. При первом входе язык кабинета берётся из Telegram.
 */
export async function signInVendor(db: Db, env: Secrets, initData: string): Promise<VendorSession> {
  const verified = await verifyInitData(initData, env.TELEGRAM_BOT_TOKEN, {
    maxAgeSeconds: VENDOR_INIT_DATA_MAX_AGE_SECONDS,
  });
  if (!verified.ok) {
    // Причина — только в лог: клиенту хватит 401
    console.warn("auth.vendor: initData rejected", verified.reason);
    throw new ApiError(401, "unauthorized", "Invalid Telegram init data");
  }
  const { user } = verified.data;

  const tgUserHash = await telegramIdHash(env.ID_HASH_KEY, user.id);
  const token = generateToken();
  const tokenHash = await hashToken(token);
  const locale = localeOf(user.languageCode);

  return withActor(db, SYSTEM, async (trx) => {
    const found = await trx
      .selectFrom("app.vendor_users")
      .select(["id", "vendor_id", "disabled_at"])
      .where("tg_user_hash", "=", tgUserHash)
      .executeTakeFirst();
    if (found === undefined) throw vendorNotLinked();
    if (found.disabled_at !== null) throw vendorDisabled();

    // Язык — только при первом входе: дальше его выбирает сам вендор
    await trx
      .updateTable("app.vendor_users")
      .set({
        last_login_at: sql<Date>`now()`,
        locale: sql`case when last_login_at is null then coalesce(${locale}::app.locale, locale) else locale end`,
      })
      .where("id", "=", found.id)
      .execute();

    const session = await trx
      .insertInto("app.sessions")
      .values({
        token_hash: tokenHash,
        vendor_user_id: found.id,
        via: "tg_partner",
        expires_at: sql<Date>`now() + make_interval(secs => ${VENDOR_SESSION_TTL_SECONDS})`,
      })
      .returning("expires_at")
      .executeTakeFirstOrThrow();

    return {
      token,
      expiresAt: session.expires_at,
      vendorUser: { id: found.id, vendorId: found.vendor_id },
    };
  });
}
