// Панель оператора: всё под /staff — только для действующих сотрудников.
//
//   GET /staff/me (Bearer, сессия сотрудника) → 200 { id, role, displayName, username }
//
// Читается под актором сотрудника; роль и активность проверены в authenticate
// на этот же запрос.

import { Hono } from "hono";
import { authenticate, requireStaff, staffOf } from "../auth/session";
import { withActor } from "../db/actor";
import { database } from "../db/middleware";
import type { AppEnv } from "../env";
import { notFound } from "../errors";

export const staff = new Hono<AppEnv>();

staff.use(database, authenticate, requireStaff());

staff.get("/me", async (c) => {
  const actor = staffOf(c);
  const row = await withActor(c.var.db, actor, (trx) =>
    trx
      .selectFrom("app.staff as s")
      .innerJoin("pii.staff_profiles as p", "p.staff_id", "s.id")
      .select(["s.id", "s.role", "p.display_name", "p.telegram_username"])
      .where("s.id", "=", actor.id)
      .executeTakeFirst(),
  );
  if (row === undefined) throw notFound();

  return c.json({
    id: row.id,
    role: row.role,
    displayName: row.display_name,
    // Имя, по которому пригласили; после привязки вход идёт по Telegram ID
    username: row.telegram_username,
  });
});
