import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { sql } from "kysely";
import { type ClientActor, GUEST, SYSTEM, withActor } from "../db/actor";
import type { AppEnv } from "../env";
import { clientBlocked, unauthorized } from "../errors";
import { hashToken, parseAuthorization } from "./crypto";

/**
 * Актор запроса по заголовку `Authorization: Bearer <токен>`.
 *
 * Нет заголовка — guest. Заголовок есть, но токен кривой, неизвестный,
 * просроченный или отозванный — 401. Клиент заблокирован — 403.
 * Сессию ищем под актором system: до этого момента актора ещё нет.
 *
 * Пока только сессии клиентов (via = tg_client). Сессии кабинета вендора
 * появятся вместе со входом вендора — до тех пор их токены получают 401.
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
      .innerJoin("app.clients as cl", "cl.id", "s.client_id")
      .select(["s.id as sessionId", "cl.id as clientId", "cl.blocked_at", "cl.deleted_at"])
      .where("s.token_hash", "=", tokenHash)
      .where("s.revoked_at", "is", null)
      .where("s.expires_at", ">", sql<Date>`now()`)
      .executeTakeFirst(),
  );
  if (session === undefined || session.deleted_at !== null) throw unauthorized();
  if (session.blocked_at !== null) throw clientBlocked();

  c.set("actor", { kind: "client", id: session.clientId });
  c.set("sessionId", session.sessionId);
  await next();
});

/** Клиент с сессией или 401. Для маршрутов под authenticate. */
export function requireClient(c: Context<AppEnv>): { actor: ClientActor; sessionId: string } {
  const actor = c.get("actor");
  const sessionId = c.get("sessionId");
  if (actor?.kind !== "client" || !sessionId) throw unauthorized();
  return { actor, sessionId };
}
