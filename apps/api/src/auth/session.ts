import { VENDOR_HEADER } from "@bayramm/shared/api/account";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { sql } from "kysely";
import {
  type AccountActor,
  type Actor,
  type ClientActor,
  GUEST,
  type StaffActor,
  type StaffRole,
  SYSTEM,
  type VendorActor,
  withActor,
} from "../db/actor";
import type { AppEnv, SessionInfo } from "../env";
import { clientBlocked, forbidden, unauthorized } from "../errors";
import type { AppCode } from "./account";
import { hashToken, parseAuthorization } from "./crypto";
import { vendorActorFor } from "./vendor";

/**
 * Сессия запроса по заголовку `Authorization: Bearer <токен>`.
 *
 * Нет заголовка — guest. Заголовок есть, но токен кривой, неизвестный,
 * просроченный или отозванный, аккаунт отключён или удалён — 401. Сессию ищем под
 * актором system: до этого момента актора ещё нет.
 *
 *   · сессия аккаунта — актор account. Роль для маршрута выводят из членств
 *     аккаунта: клиент — requireClient, партнёр — requireVendor;
 *   · сессия сотрудника (staff_id) — актор staff с ролью. Роль и активность
 *     читаются на каждый запрос, поэтому отключение сотрудника действует сразу:
 *     его сессии получают 401.
 */
export const authenticate = createMiddleware<AppEnv>(async (c, next) => {
  const bearer = parseAuthorization(c.req.header("Authorization"));
  if (bearer.kind === "none") {
    c.set("actor", GUEST);
    c.set("session", null);
    c.set("sessionId", null);
    await next();
    return;
  }
  if (bearer.kind === "invalid") throw unauthorized();

  const tokenHash = await hashToken(bearer.token);
  const row = await withActor(c.var.db, SYSTEM, (trx) =>
    trx
      .selectFrom("app.sessions as s")
      .innerJoin("app.accounts as a", "a.id", "s.account_id")
      .leftJoin("app.staff as st", "st.id", "s.staff_id")
      .leftJoin("app.clients as cl", "cl.account_id", "s.account_id")
      .select([
        "s.id as sessionId",
        "s.account_id as accountId",
        "s.app",
        "s.via",
        "s.proof_at as proofAt",
        "a.disabled_at as accountDisabledAt",
        "a.deleted_at as accountDeletedAt",
        "st.id as staffId",
        "st.role as staffRole",
        "st.active as staffActive",
        "st.account_id as staffAccountId",
        "cl.id as clientId",
        sql<boolean>`cl.blocked_at is not null`.as("clientBlocked"),
        sql<boolean>`cl.deleted_at is not null`.as("clientDeleted"),
      ])
      .where("s.token_hash", "=", tokenHash)
      .where("s.revoked_at", "is", null)
      .where("s.expires_at", ">", sql<Date>`now()`)
      .executeTakeFirst(),
  );
  if (row === undefined) throw unauthorized();
  if (row.accountDisabledAt !== null || row.accountDeletedAt !== null) throw unauthorized();

  const session: SessionInfo = {
    id: row.sessionId,
    accountId: row.accountId,
    kind: row.staffId === null ? "account" : "staff",
    app: row.app as AppCode,
    via: row.via,
    proofAt: row.proofAt,
    client:
      row.clientId === null
        ? null
        : { id: row.clientId, blocked: row.clientBlocked, deleted: row.clientDeleted },
  };

  let actor: Actor;
  if (row.staffId !== null) {
    // Роль сотрудника — только своего аккаунта и только действующая
    if (row.staffActive !== true || row.staffRole === null || row.staffAccountId !== row.accountId) {
      throw unauthorized();
    }
    actor = { kind: "staff", id: row.staffId, role: row.staffRole };
  } else {
    actor = { kind: "account", id: row.accountId };
  }

  c.set("actor", actor);
  c.set("session", session);
  c.set("sessionId", session.id);
  await next();
});

/** Сессия запроса (любая) или 401. Для выхода и своего аккаунта */
export function requireSession(c: Context<AppEnv>): {
  actor: AccountActor | StaffActor | ClientActor | VendorActor;
  session: SessionInfo;
} {
  const actor = c.get("actor");
  const session = c.get("session");
  if (actor === undefined || actor.kind === "guest" || actor.kind === "system" || !session) {
    throw unauthorized();
  }
  return { actor, session };
}

/** Сессия аккаунта (не сотрудника) или 401/403 */
export function requireAccountSession(c: Context<AppEnv>): SessionInfo {
  const { session } = requireSession(c);
  if (session.kind !== "account") throw forbidden();
  return session;
}

/** Актор своего аккаунта для любой сессии: GET /me, способы входа, удаление */
export function accountOf(c: Context<AppEnv>): AccountActor {
  const { session } = requireSession(c);
  return { kind: "account", id: session.accountId };
}

/**
 * Клиент: роль клиента аккаунта из сессии аккаунта. Гостю — 401; сессии сотрудника
 * и аккаунту без роли клиента — 403; заблокированному клиенту — 403 client_blocked.
 * Актор запроса дальше — клиент.
 */
export function requireClient(c: Context<AppEnv>): { actor: ClientActor; sessionId: string } {
  const current = c.get("actor");
  const session = requireAccountSession(c);
  if (current?.kind === "client") return { actor: current, sessionId: session.id };
  const client = session.client;
  if (client === null || client.deleted) throw forbidden();
  if (client.blocked) throw clientBlocked();
  const actor: ClientActor = { kind: "client", id: client.id };
  c.set("actor", actor);
  return { actor, sessionId: session.id };
}

/**
 * Защита маршрутов панели оператора (после authenticate): гостю — 401,
 * не сессии сотрудника — 403, сотруднику не из перечисленных ролей — 403.
 * Без ролей — любой действующий сотрудник. Роли не упорядочены: admin не
 * включает manager и moderator — их перечисляют явно.
 */
export function requireStaff(...roles: StaffRole[]) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const actor = c.get("actor");
    if (actor === undefined || actor.kind === "guest") throw unauthorized();
    if (actor.kind !== "staff") throw forbidden();
    if (roles.length > 0 && !roles.includes(actor.role)) throw forbidden();
    await next();
  });
}

/**
 * Защита маршрутов кабинета вендора (после authenticate): гостю — 401, сессии
 * сотрудника — 403. Актор — пользователь вендора из членств аккаунта: одно — оно,
 * несколько — по заголовку VENDOR_HEADER (auth/vendor.ts). Какие заявки и листинги
 * видны — решает RLS по вендору актора.
 */
export const requireVendor = createMiddleware<AppEnv>(async (c, next) => {
  const session = requireAccountSession(c);
  const actor = await vendorActorFor(c.var.db, session.accountId, c.req.header(VENDOR_HEADER));
  c.set("actor", actor);
  await next();
});

/** Пользователь вендора — в обработчиках за requireVendor. Без кабинета — 401. */
export function vendorOf(c: Context<AppEnv>): VendorActor {
  const actor = c.get("actor");
  if (actor?.kind !== "vendor_user") throw unauthorized();
  return actor;
}

/** Сотрудник запроса — в обработчиках за requireStaff. Без сессии сотрудника — 401. */
export function staffOf(c: Context<AppEnv>): StaffActor {
  const actor = c.get("actor");
  if (actor?.kind !== "staff") throw unauthorized();
  return actor;
}
