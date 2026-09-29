// Аккаунт: проверка доказательств входа и сессии аккаунта.
//
// Один человек — один аккаунт (app.accounts); клиент, партнёр и сотрудник — роли на
// нём. Доказательство входа — подписанные данные Telegram (initData Mini App, виджет
// входа) или код из сообщения на телефон (auth/otp.ts). Проверив доказательство, API
// вызывает функцию базы под актором system: она находит или создаёт аккаунт,
// восстанавливает удалённый, обновляет профиль и привязывает роли, доказанные этим
// входом (приглашение сотрудника по имени пользователя, пользователей вендора по
// телефону). Сессия аккаунта — случайный токен, в базе только его sha256; proof_at —
// когда человек доказал, кто он: от него считается свежесть для сессии сотрудника.

import { type LoginWidgetParams, verifyInitData, verifyLoginWidget } from "@bayramm/tg";
import { sql } from "kysely";
import type { Tx } from "../db/actor";
import { ApiError, clientBlocked } from "../errors";
import { generateToken, hashToken, phoneHash, telegramIdHash } from "./crypto";

// Mini App получает свежую initData при каждом открытии и сразу входит. Час — запас
// на медленную сеть и повтор, дольше подписанные данные не принимаем
export const INIT_DATA_MAX_AGE_SECONDS = 60 * 60;
// Виджет подписывает данные в момент нажатия «Войти», браузер сразу несёт их сюда.
// Данные виджета проходят через адресную строку — короткое окно ограничивает повтор
export const WIDGET_MAX_AGE_SECONDS = 10 * 60;
export const ACCOUNT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
// Свежее доказательство: для сессии сотрудника, кода хаба панели и добавления способа входа
export const RECENT_PROOF_SECONDS = 12 * 60 * 60;

export type AppCode = "web" | "vendor" | "admin";
/** Чем доказан вход сессии аккаунта (app.sessions.via) */
export type ProofVia = "tg_webapp" | "tg_widget" | "phone_otp" | "hub_code";
/** Откуда вход — для журнала (app.source) */
export type SignInSource = "tma" | "web" | "vendor_cabinet" | "admin" | "partner_bot";

export const accountDisabled = () => new ApiError(403, "account_disabled", "Account is disabled");
export const reauthRequired = () =>
  new ApiError(401, "reauth_required", "Sign in again: the last sign-in is too old for this action");

interface Secrets {
  TELEGRAM_BOT_TOKEN: string;
  ID_HASH_KEY: string;
}

/** Пользователь Telegram из проверенных данных: только то, что идёт в аккаунт */
export interface TelegramProof {
  readonly user: {
    readonly id: number;
    readonly firstName: string;
    readonly lastName?: string | undefined;
    readonly username?: string | undefined;
    readonly languageCode?: string | undefined;
    readonly allowsWriteToPm?: boolean | undefined;
  };
  /** Когда Telegram подписал данные */
  readonly at: Date;
  readonly via: "tg_webapp" | "tg_widget";
}

const invalidTelegram = () => new ApiError(401, "unauthorized", "Invalid Telegram login data");

/** initData Mini App → доказательство; подпись не сошлась или устарела — 401 */
export async function verifyWebApp(env: Secrets, initData: string): Promise<TelegramProof> {
  const verified = await verifyInitData(initData, env.TELEGRAM_BOT_TOKEN, {
    maxAgeSeconds: INIT_DATA_MAX_AGE_SECONDS,
  });
  if (!verified.ok) {
    // Причина — только в лог: клиенту хватит 401
    console.warn("auth: initData rejected", verified.reason);
    throw new ApiError(401, "unauthorized", "Invalid Telegram init data");
  }
  return { user: verified.data.user, at: new Date(verified.data.authDate * 1000), via: "tg_webapp" };
}

/** Поля виджета входа → доказательство; подпись не сошлась или устарела — 401 */
export async function verifyWidget(env: Secrets, params: LoginWidgetParams): Promise<TelegramProof> {
  const verified = await verifyLoginWidget(params, env.TELEGRAM_BOT_TOKEN, {
    maxAgeSeconds: WIDGET_MAX_AGE_SECONDS,
  });
  if (!verified.ok) {
    console.warn("auth: login widget rejected", verified.reason);
    throw invalidTelegram();
  }
  return { user: verified.data.user, at: new Date(verified.data.authDate * 1000), via: "tg_widget" };
}

// Язык Telegram → язык интерфейса; остальные языки — умолчание базы (uz)
export function localeOf(languageCode: string | undefined): "ru" | "uz" | null {
  const lang = languageCode?.toLowerCase().split("-")[0];
  return lang === "ru" || lang === "uz" ? lang : null;
}

// Обрезка по символам, а не по UTF-16: length() в Postgres считает символы
function clip(value: string | undefined, max: number): string | null {
  if (value === undefined) return null;
  const chars = Array.from(value);
  return chars.length > max ? chars.slice(0, max).join("") : value;
}

const NAME_MAX = 128;
const USERNAME_RE = /^[A-Za-z0-9_]{4,32}$/;

interface SignInRow {
  account_id: string;
  created: boolean;
  disabled: boolean;
}

/**
 * Аккаунт по Telegram (под актором system): найти или создать, профиль — из
 * Telegram. Отключённый аккаунт — 403 account_disabled (транзакция откатывается).
 */
export async function signInTelegram(
  trx: Tx,
  env: Secrets,
  proof: TelegramProof,
  source: SignInSource,
): Promise<{ accountId: string; created: boolean }> {
  const { user } = proof;
  const tgHash = await telegramIdHash(env.ID_HASH_KEY, user.id);
  const username = user.username !== undefined && USERNAME_RE.test(user.username) ? user.username : null;
  const { rows } = await sql<SignInRow>`
    select account_id, created, disabled
    from app.account_sign_in_telegram(${tgHash}::bytea, ${user.id}::bigint, ${username}::text,
                                      ${clip(user.firstName, NAME_MAX)}::text, ${clip(user.lastName, NAME_MAX)}::text,
                                      ${localeOf(user.languageCode)}::app.locale, ${source}::app.source)`.execute(
    trx,
  );
  const row = rows[0];
  if (row === undefined) throw new Error("account_sign_in_telegram: нет результата");
  if (row.disabled) throw accountDisabled();
  if (row.created) console.info("auth: account created", { via: proof.via });
  return { accountId: row.account_id, created: row.created };
}

/** Аккаунт по телефону, код уже проверен (под актором system). Номер — +998XXXXXXXXX */
export async function signInPhone(
  trx: Tx,
  env: Pick<Secrets, "ID_HASH_KEY">,
  phone: string,
  locale: "ru" | "uz" | null,
  source: SignInSource,
): Promise<{ accountId: string; created: boolean }> {
  const hash = await phoneHash(env.ID_HASH_KEY, phone);
  const { rows } = await sql<SignInRow>`
    select account_id, created, disabled
    from app.account_sign_in_phone(${hash}::bytea, ${phone}::text, ${locale}::app.locale,
                                   ${source}::app.source)`.execute(trx);
  const row = rows[0];
  if (row === undefined) throw new Error("account_sign_in_phone: нет результата");
  if (row.disabled) throw accountDisabled();
  if (row.created) console.info("auth: account created", { via: "phone_otp" });
  return { accountId: row.account_id, created: row.created };
}

/**
 * Роль клиента у аккаунта — при входе в клиентское приложение (под актором system).
 * Заблокированный клиент — 403 client_blocked (транзакция откатывается).
 */
export async function ensureClient(
  trx: Tx,
  accountId: string,
  locale: "ru" | "uz" | null,
  canMessage: boolean,
): Promise<string> {
  const { rows } = await sql<{ client_id: string; blocked: boolean }>`
    select client_id, blocked
    from app.account_ensure_client(${accountId}::uuid, ${locale}::app.locale, ${canMessage}::boolean)`.execute(
    trx,
  );
  const row = rows[0];
  if (row === undefined) throw new Error("account_ensure_client: нет результата");
  if (row.blocked) throw clientBlocked();
  return row.client_id;
}

export interface IssuedSession {
  readonly id: string;
  readonly token: string;
  readonly expiresAt: Date;
}

/** Сессия аккаунта (под актором system): 7 дней, proof_at — момент доказательства */
export async function issueAccountSession(
  trx: Tx,
  params: { accountId: string; app: AppCode; via: ProofVia; proofAt: Date },
): Promise<IssuedSession> {
  const token = generateToken();
  const tokenHash = await hashToken(token);
  // Доказательство из будущего (часы Telegram впереди) — не позже «сейчас»
  const proofAt = new Date(Math.min(params.proofAt.getTime(), Date.now()));
  const row = await trx
    .insertInto("app.sessions")
    .values({
      token_hash: tokenHash,
      account_id: params.accountId,
      via: params.via,
      app: params.app,
      proof_at: proofAt,
      expires_at: sql<Date>`now() + make_interval(secs => ${ACCOUNT_SESSION_TTL_SECONDS})`,
    })
    .returning(["id", "expires_at"])
    .executeTakeFirstOrThrow();
  return { id: row.id, token, expiresAt: row.expires_at };
}

/** Свежее ли доказательство: не старше RECENT_PROOF_SECONDS */
export function isRecentProof(proofAt: Date, now = Date.now()): boolean {
  return now - proofAt.getTime() < RECENT_PROOF_SECONDS * 1000;
}

/** Тело ответа входа */
export const sessionBody = (session: { token: string; expiresAt: Date }) => ({
  token: session.token,
  expiresAt: session.expiresAt.toISOString(),
});
