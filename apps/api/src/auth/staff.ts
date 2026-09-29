// Сессия сотрудника (панель оператора).
//
// Сотрудник — роль на аккаунте (app.staff.account_id), принимается только по
// приглашению. Сессия сотрудника — отдельная от сессии аккаунта: не дольше 12 часов
// от доказательства входа и выдаётся только по свежему доказательству —
// app.staff_elevate проверяет роль, активность аккаунта и возраст доказательства и
// пишет повышение в журнал. Три пути:
//   · сессия аккаунта с proof_at моложе 12 часов (панель после хаба входа);
//   · initData Mini App — панель открыта кнопкой бота;
//   · данные виджета входа Telegram (прежний вход панели).

import type { LoginWidgetParams } from "@bayramm/tg";
import { sql } from "kysely";
import { type StaffRole, SYSTEM, type Tx, withActor } from "../db/actor";
import type { Db } from "../db/client";
import { forbidden } from "../errors";
import { reauthRequired, type SignInSource, signInTelegram, verifyWebApp, verifyWidget } from "./account";
import { generateToken, hashToken } from "./crypto";

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

interface ElevateRow {
  result: "ok" | "stale" | "forbidden";
  staff_id: string | null;
  role: StaffRole | null;
  expires_at: Date | null;
}

/**
 * Сессия сотрудника по доказательству аккаунта (под актором system). Нет
 * действующей роли — 403; доказательство старше 12 часов — 401 reauth_required.
 */
export async function elevate(
  trx: Tx,
  params: { accountId: string; proofAt: Date; via: string },
): Promise<StaffSession> {
  const token = generateToken();
  const tokenHash = await hashToken(token);
  const { rows } = await sql<ElevateRow>`
    select result, staff_id, role, expires_at
    from app.staff_elevate(${params.accountId}::uuid, ${params.proofAt}::timestamptz, ${tokenHash}::bytea,
                           ${params.via}::text)`.execute(trx);
  const row = rows[0];
  if (row === undefined) throw new Error("staff_elevate: нет результата");
  if (row.result === "stale") throw reauthRequired();
  if (row.result !== "ok" || row.staff_id === null || row.role === null || row.expires_at === null) {
    throw forbidden();
  }
  console.info("auth.staff: elevated", { staffId: row.staff_id, via: params.via });
  return { token, expiresAt: row.expires_at, staff: { id: row.staff_id, role: row.role } };
}

/** Сессия сотрудника из сессии аккаунта (POST /auth/staff/elevate) */
export function elevateSession(
  db: Db,
  session: { accountId: string; proofAt: Date; via: string },
): Promise<StaffSession> {
  return withActor(db, SYSTEM, (trx) => elevate(trx, session));
}

// Вход по данным Telegram и сразу — сессия сотрудника. Не сотрудник — 403, и
// транзакция откатывается: аккаунт по такому входу не создаётся
async function signInAndElevate(
  db: Db,
  env: Secrets,
  proof: Awaited<ReturnType<typeof verifyWebApp>>,
  source: SignInSource,
): Promise<StaffSession> {
  return withActor(db, SYSTEM, async (trx) => {
    const { accountId } = await signInTelegram(trx, env, proof, source);
    return elevate(trx, { accountId, proofAt: proof.at, via: proof.via });
  });
}

/** Панель как Mini App: initData из кнопки бота (POST /auth/staff/webapp) */
export async function signInStaffWebApp(db: Db, env: Secrets, initData: string): Promise<StaffSession> {
  return signInAndElevate(db, env, await verifyWebApp(env, initData), "admin");
}

/** @deprecated Виджет входа Telegram на домене панели (устаревший POST /auth/staff/telegram) */
export async function signInStaff(db: Db, env: Secrets, params: LoginWidgetParams): Promise<StaffSession> {
  return signInAndElevate(db, env, await verifyWidget(env, params), "admin");
}
