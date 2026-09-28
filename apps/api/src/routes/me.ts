// Свой профиль клиента: GET /me (Bearer) → 200 { id, locale, firstName, … }.
// Читается под актором клиента — чужую строку RLS не отдаст, даже если id подменить.
// Телефон сюда не входит: его читают только через pii.read_client_phone с журналом

import { Hono } from "hono";
import { authenticate, requireClient } from "../auth/session";
import { withActor } from "../db/actor";
import { database } from "../db/middleware";
import type { AppEnv } from "../env";
import { notFound } from "../errors";

export const me = new Hono<AppEnv>();

me.use(database, authenticate);

me.get("/", async (c) => {
  const { actor } = requireClient(c);
  const row = await withActor(c.var.db, actor, (trx) =>
    trx
      .selectFrom("app.clients as cl")
      .leftJoin("pii.client_profiles as p", "p.client_id", "cl.id")
      .select(["cl.id", "cl.locale", "cl.can_message", "p.first_name", "p.last_name", "p.username"])
      .where("cl.id", "=", actor.id)
      .executeTakeFirst(),
  );
  if (row === undefined) throw notFound();

  return c.json({
    id: row.id,
    locale: row.locale,
    firstName: row.first_name,
    lastName: row.last_name,
    username: row.username,
    canMessage: row.can_message,
  });
});
