import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { sql } from "kysely";
import {
  type Actor,
  type ClientActor,
  GUEST,
  type StaffActor,
  type StaffRole,
  SYSTEM,
  type VendorActor,
  withActor,
} from "../db/actor";
import type { AppEnv } from "../env";
import { clientBlocked, forbidden, unauthorized } from "../errors";
import { hashToken, parseAuthorization } from "./crypto";

/**
 * Актор запроса по заголовку `Authorization: Bearer <токен>`.
 *
 * Нет заголовка — guest. Заголовок есть, но токен кривой, неизвестный,
 * просроченный или отозванный — 401. Сессию ищем под актором system: до этого
 * момента актора ещё нет.
 *
 *   · сессия клиента (via = tg_client) — актор client; клиент удалён — 401,
 *     заблокирован — 403;
 *   · сессия сотрудника (via = tg_staff) — актор staff с ролью; роль и
 *     активность читаются на каждый запрос, поэтому отключение сотрудника
 *     действует сразу: его сессии получают 401;
 *   · сессия кабинета (via = tg_partner) — актор vendor_user с вендором;
 *     отключение пользователя или снятая привязка к Telegram действуют так же
 *     сразу — 401.
 */
export const authenticate = createMiddleware<AppEnv>(async (c, next) => {
  const bearer = parseAuthorization(c.req.header("Authorization"));
  if (bearer.kind === "none") {
    c.set("actor", GUEST);
    c.set("sessionId", null);
    await next();
    return;
  }
  if (bearer.kind === "invalid") throw unauthorized();

  const tokenHash = await hashToken(bearer.token);
  const session = await withActor(c.var.db, SYSTEM, (trx) =>
    trx
      .selectFrom("app.sessions as s")
      .leftJoin("app.clients as cl", "cl.id", "s.client_id")
      .leftJoin("app.staff as st", "st.id", "s.staff_id")
      .leftJoin("app.vendor_users as vu", "vu.id", "s.vendor_user_id")
      .select([
        "s.id as sessionId",
        "s.via",
        "cl.id as clientId",
        "cl.blocked_at",
        "cl.deleted_at",
        "st.id as staffId",
        "st.role as staffRole",
        "st.active as staffActive",
        "vu.id as vendorUserId",
        "vu.vendor_id as vendorId",
        "vu.disabled_at as vendorDisabledAt",
        sql<boolean>`vu.tg_user_hash is not null`.as("vendorLinked"),
      ])
      .where("s.token_hash", "=", tokenHash)
      .where("s.revoked_at", "is", null)
      .where("s.expires_at", ">", sql<Date>`now()`)
      .executeTakeFirst(),
  );
  if (session === undefined) throw unauthorized();

  let actor: Actor;
  if (session.clientId !== null) {
    if (session.deleted_at !== null) throw unauthorized();
    if (session.blocked_at !== null) throw clientBlocked();
    actor = { kind: "client", id: session.clientId };
  } else if (session.staffId !== null && session.staffRole !== null) {
    if (session.staffActive !== true) throw unauthorized();
    actor = { kind: "staff", id: session.staffId, role: session.staffRole };
  } else if (session.vendorUserId !== null && session.vendorId !== null) {
    if (session.vendorDisabledAt !== null) throw unauthorized();
    // Вход был по Telegram: привязку сняли — сессия больше не его
    if (session.via === "tg_partner" && session.vendorLinked !== true) throw unauthorized();
    actor = { kind: "vendor_user", id: session.vendorUserId, vendorId: session.vendorId };
  } else {
    throw unauthorized();
  }

  c.set("actor", actor);
  c.set("sessionId", session.sessionId);
  await next();
});

/** Любая сессия (клиента, сотрудника или кабинета) или 401. Для выхода. */
export function requireSession(c: Context<AppEnv>): {
  actor: ClientActor | StaffActor | VendorActor;
  sessionId: string;
} {
  const actor = c.get("actor");
  const sessionId = c.get("sessionId");
  if (actor === undefined || actor.kind === "guest" || actor.kind === "system" || !sessionId) {
    throw unauthorized();
  }
  return { actor, sessionId };
}

/** Клиент с сессией: гостю — 401, сотруднику — 403. Для маршрутов под authenticate. */
export function requireClient(c: Context<AppEnv>): { actor: ClientActor; sessionId: string } {
  const { actor, sessionId } = requireSession(c);
  if (actor.kind !== "client") throw forbidden();
  return { actor, sessionId };
}

/**
 * Защита маршрутов панели оператора (после authenticate): гостю — 401,
 * клиенту — 403, сотруднику не из перечисленных ролей — 403.
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
 * Защита маршрутов кабинета вендора (после authenticate): гостю — 401, клиенту и
 * сотруднику — 403. Какие заявки и листинги видны — решает RLS по вендору сессии.
 */
export const requireVendor = createMiddleware<AppEnv>(async (c, next) => {
  const actor = c.get("actor");
  if (actor === undefined || actor.kind === "guest") throw unauthorized();
  if (actor.kind !== "vendor_user") throw forbidden();
  await next();
});

/** Пользователь вендора — в обработчиках за requireVendor. Без сессии кабинета — 401. */
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
