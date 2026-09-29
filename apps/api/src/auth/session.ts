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
 *     действует сразу: его сессии получают 401.
 *
 * Сессии кабинета вендора появятся вместе со входом вендора — до тех пор их
 * токены получают 401.
 *
 * Актор уже определён раньше по цепочке (лимит по актору в ratelimit.ts) —
 * повторно сессию не ищем.
 */
export const authenticate = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get("actor") !== undefined) {
    await next();
    return;
  }
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
      .select([
        "s.id as sessionId",
        "cl.id as clientId",
        "cl.blocked_at",
        "cl.deleted_at",
        "st.id as staffId",
        "st.role as staffRole",
        "st.active as staffActive",
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
  } else {
    throw unauthorized();
  }

  c.set("actor", actor);
  c.set("sessionId", session.sessionId);
  await next();
});

/** Любая сессия (клиента или сотрудника) или 401. Для выхода. */
export function requireSession(c: Context<AppEnv>): { actor: ClientActor | StaffActor; sessionId: string } {
  const actor = c.get("actor");
  const sessionId = c.get("sessionId");
  if ((actor?.kind !== "client" && actor?.kind !== "staff") || !sessionId) throw unauthorized();
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

/** Сотрудник запроса — в обработчиках за requireStaff. Без сессии сотрудника — 401. */
export function staffOf(c: Context<AppEnv>): StaffActor {
  const actor = c.get("actor");
  if (actor?.kind !== "staff") throw unauthorized();
  return actor;
}
