// Панель оператора: всё под /staff — только для действующих сотрудников.
//
//   GET /staff/me (Bearer, сессия сотрудника) → 200 { id, role, displayName, username, permissions,
//                                                       botLinked }
//
// Разделы (контракт — @bayramm/shared/api/staff, права по ролям — staff/access.ts):
//   /staff/dictionaries   справочники для форм
//   /staff/vendors        вендоры, чек-лист проверки, пользователи кабинета
//   /staff/listings       карточки, статусы, фото, занятость
//   /staff/revisions      правки опубликованных карточек: очередь и решение
//   /staff/services       услуги витрин (кроме отклонённых): очередь модерации и решение
//   /staff/requests       заявки, срок ответа вендора, напоминания, заметки
//   /staff/clients        клиенты (псевдонимы), блокировка
//   /staff/outbox         очередь уведомлений: что не доставлено, повтор
//   /staff/audit          журнал действий и журнал доступа к ПДн
//   /staff/settings       настройки платформы
//   /staff/team           сотрудники: приглашение, роль, отключение
//   /staff/metrics        метрики запуска: по неделям, по вендорам (только чтение)
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
import { audit } from "../staff/audit";
import { availability } from "../staff/availability";
import { clients } from "../staff/clients";
import { dictionaries } from "../staff/dictionaries";
import { listings } from "../staff/listings";
import { metrics } from "../staff/metrics";
import { outbox } from "../staff/outbox";
import { photos } from "../staff/photos";
import { requests } from "../staff/requests";
import { revisions } from "../staff/revisions";
import { listingServices, serviceModeration, vendorListings } from "../staff/services";
import { settings } from "../staff/settings";
import { team } from "../staff/team";
import { vendors } from "../staff/vendors";

/** Разделы панели без базы и входа — их ставит staff ниже (так их проверяют юнит-тесты) */
export const sections = new Hono<AppEnv>();

sections.route("/dictionaries", dictionaries);
sections.route("/vendors", vendors);
sections.route("/vendors", vendorListings);
sections.route("/listings", listings);
sections.route("/listings", listingServices);
sections.route("/listings", photos);
sections.route("/listings", availability);
sections.route("/revisions", revisions);
sections.route("/services", serviceModeration);
sections.route("/requests", requests);
sections.route("/clients", clients);
sections.route("/outbox", outbox);
sections.route("/audit", audit);
sections.route("/settings", settings);
sections.route("/team", team);
sections.route("/metrics", metrics);

export const staff = new Hono<AppEnv>();

staff.use(database, authenticate, requireStaff());

// Ответы панели — с именами клиентов, заявками и открытыми телефонами: ни браузеру, ни прокси их
// не хранить (как у кабинета)
staff.use(async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

staff.get("/me", async (c) => {
  const actor = staffOf(c);
  const row = await withActor(c.var.db, actor, (trx) =>
    trx
      .selectFrom("app.staff as s")
      .innerJoin(staffProfilesAs("p"), "p.staff_id", "s.id")
      .select(["s.id", "s.role", "p.display_name", "p.telegram_username", "p.telegram_chat_id"])
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
    // Чат с ботом есть — оповещения команды доходят (app.enqueue_staff_alert пишет только ему)
    botLinked: row.telegram_chat_id !== null,
  };
  return c.json(body);
});

staff.route("/", sections);
