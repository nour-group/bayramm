// Панель оператора: всё под /staff — только для действующих сотрудников.
//
//   GET /staff/me (Bearer, сессия сотрудника) → 200 { id, role, displayName, username, permissions }
//
// Разделы (контракт — @bayramm/shared/api/staff, права по ролям — staff/access.ts):
//   /staff/dictionaries   справочники для форм
//   /staff/vendors        вендоры, чек-лист проверки, пользователи кабинета
//   /staff/listings       карточки, статусы, фото, занятость
//   /staff/requests       заявки и срок ответа вендора
//
// Читается под актором сотрудника; роль и активность проверены в authenticate
// на этот же запрос.

import type { StaffMe } from "@bayramm/shared/api/staff";
import { Hono } from "hono";
import { authenticate, requireStaff, staffOf } from "../auth/session";
import { withActor } from "../db/actor";
import { database } from "../db/middleware";
import { staffProfilesAs } from "../db/pii";
import type { AppEnv } from "../env";
import { notFound } from "../errors";
import { permissionsOf } from "../staff/access";
import { availability } from "../staff/availability";
import { dictionaries } from "../staff/dictionaries";
import { listings } from "../staff/listings";
import { photos } from "../staff/photos";
import { requests } from "../staff/requests";
import { vendors } from "../staff/vendors";

/** Разделы панели без базы и входа — их ставит staff ниже (так их проверяют юнит-тесты) */
export const sections = new Hono<AppEnv>();

sections.route("/dictionaries", dictionaries);
sections.route("/vendors", vendors);
sections.route("/listings", listings);
sections.route("/listings", photos);
sections.route("/listings", availability);
sections.route("/requests", requests);

export const staff = new Hono<AppEnv>();

staff.use(database, authenticate, requireStaff());

staff.get("/me", async (c) => {
  const actor = staffOf(c);
  const row = await withActor(c.var.db, actor, (trx) =>
    trx
      .selectFrom("app.staff as s")
      .innerJoin(staffProfilesAs("p"), "p.staff_id", "s.id")
      .select(["s.id", "s.role", "p.display_name", "p.telegram_username"])
      .where("s.id", "=", actor.id)
      .executeTakeFirst(),
  );
  if (row === undefined) throw notFound();

  const body: StaffMe = {
    id: row.id,
    role: row.role,
    displayName: row.display_name,
    // Имя, по которому пригласили; после привязки вход идёт по Telegram ID
    username: row.telegram_username,
    // Для панели — какие кнопки показывать; проверяет сервер на каждом запросе
    permissions: permissionsOf(row.role),
  };
  return c.json(body);
});

staff.route("/", sections);
