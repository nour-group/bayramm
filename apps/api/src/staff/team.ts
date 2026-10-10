// Команда — только администратор. Сотрудника приглашают по имени пользователя
// Telegram или по номеру телефона: приглашение принимает первый вход аккаунта с этим
// Telegram или кодом на этот номер (номер уже подтверждён у аккаунта — сразу). Номер
// не хранится — только его HMAC (app.staff.phone_hash). Менять команду может только
// база (app.staff_invite, app.staff_invite_phone, app.staff_set_role,
// app.staff_set_active, app.staff_revoke_invite): себя не отключить и роль не сменить,
// последнего действующего администратора — никак. Отозвать (удалить) можно только
// приглашение, которое ещё не приняли; принятое — отключают.
//
//   GET    /staff/team                     все сотрудники: действующие сверху
//   POST   /staff/team                     { username | phone, displayName, role } → 201
//   POST   /staff/team/:id/role            { role }
//   POST   /staff/team/:id/deactivate | activate
//   DELETE /staff/team/:id                 отозвать непринятое приглашение (409 staff_invite_accepted)

import type { StaffRole, TeamList, TeamMember } from "@bayramm/shared/api/staff";
import { Hono } from "hono";
import { sql } from "kysely";
import { phoneHash } from "../auth/crypto";
import { staffOf } from "../auth/session";
import { type Tx, withActor } from "../db/actor";
import { inviteStaff, staffProfilesAs } from "../db/pii";
import type { AppEnv } from "../env";
import { notFound } from "../errors";
import { requirePermission } from "./access";
import { Input, invalidInput, limitJson, readBody } from "./input";
import { iso, pathId } from "./shared";

export const team = new Hono<AppEnv>();

const ROLES = ["admin", "manager", "moderator"] as const satisfies readonly StaffRole[];

async function loadTeam(trx: Tx, self: string): Promise<TeamList> {
  const rows = await trx
    .selectFrom("app.staff as s")
    .innerJoin(staffProfilesAs("p"), "p.staff_id", "s.id")
    .select([
      "s.id",
      "s.role",
      "s.active",
      "s.tg_linked_at",
      "s.created_at",
      "p.display_name",
      "p.telegram_username",
      // Сам чат панели не нужен — только то, что бот может писать сотруднику
      sql<boolean>`p.telegram_chat_id is not null`.as("bot_linked"),
      // Сам хэш номера панели не нужен — только то, что пригласили по телефону
      sql<boolean>`s.phone_hash is not null and p.telegram_username is null`.as("by_phone"),
      sql<boolean>`s.account_id is not null`.as("accepted"),
    ])
    .orderBy("s.active", "desc")
    .orderBy("p.display_name")
    .orderBy("s.id")
    .execute();
  return {
    items: rows.map(
      (row): TeamMember => ({
        id: row.id,
        displayName: row.display_name,
        username: row.telegram_username,
        invitedBy: row.by_phone ? "phone" : "telegram",
        role: row.role,
        active: row.active,
        accepted: row.accepted || row.tg_linked_at !== null,
        linked: row.tg_linked_at !== null,
        linkedAt: iso(row.tg_linked_at),
        botLinked: row.bot_linked,
        createdAt: iso(row.created_at),
        self: row.id === self,
      }),
    ),
  };
}

team.get("/", requirePermission("team.manage"), async (c) => {
  const actor = staffOf(c);
  return c.json(await withActor(c.var.db, actor, (trx) => loadTeam(trx, actor.id)));
});

// Приглашение: имя пользователя Telegram или номер телефона — одно из двух
team.post("/", requirePermission("team.manage"), limitJson, async (c) => {
  const actor = staffOf(c);
  const input = new Input(await readBody(c.req.raw));
  const byPhone = input.has("phone") && !input.has("username");
  // Имя, @имя или ссылка t.me — как у витрины и вендора; в базу — имя (её триггер — в нижний регистр)
  const username = byPhone ? undefined : input.telegram("username", true);
  // Номер Узбекистана в любой записи → «+998XXXXXXXXX»; другой — 422 с полем phone
  const phone = byPhone ? input.phone("phone", true) : undefined;
  if (input.has("phone") && input.has("username")) input.fail("phone");
  const displayName = input.text("displayName", { max: 80, required: true });
  const role = input.oneOf("role", ROLES, true);
  input.done();
  if (typeof displayName !== "string" || !role) throw invalidInput(["displayName", "role"]);
  let invite: Parameters<typeof inviteStaff>[1];
  if (typeof phone === "string") {
    invite = { displayName, role, phoneHash: await phoneHash(c.env.ID_HASH_KEY, phone) };
  } else if (typeof username === "string") {
    invite = { displayName, role, username };
  } else {
    throw invalidInput([byPhone ? "phone" : "username"]);
  }
  const body = await withActor(c.var.db, actor, async (trx) => {
    await inviteStaff(trx, invite);
    return loadTeam(trx, actor.id);
  });
  return c.json(body, 201);
});

async function assertStaff(trx: Tx, id: string): Promise<void> {
  const found = await trx.selectFrom("app.staff").select("id").where("id", "=", id).executeTakeFirst();
  if (!found) throw notFound();
}

team.post("/:id/role", requirePermission("team.manage"), limitJson, async (c) => {
  const actor = staffOf(c);
  const id = pathId(c.req.param("id"));
  const input = new Input(await readBody(c.req.raw));
  const role = input.oneOf("role", ROLES, true);
  input.done();
  if (!role) throw invalidInput(["role"]);
  const body = await withActor(c.var.db, actor, async (trx) => {
    await assertStaff(trx, id);
    await sql`select app.staff_set_role(${id}::uuid, ${role}::app.staff_role)`.execute(trx);
    return loadTeam(trx, actor.id);
  });
  return c.json(body);
});

for (const [action, active] of [
  ["deactivate", false],
  ["activate", true],
] as const) {
  team.post(`/:id/${action}`, requirePermission("team.manage"), async (c) => {
    const actor = staffOf(c);
    const id = pathId(c.req.param("id"));
    const body = await withActor(c.var.db, actor, async (trx) => {
      await assertStaff(trx, id);
      await sql`select app.staff_set_active(${id}::uuid, ${active}::boolean)`.execute(trx);
      return loadTeam(trx, actor.id);
    });
    return c.json(body);
  });
}

team.delete("/:id", requirePermission("team.manage"), async (c) => {
  const actor = staffOf(c);
  const id = pathId(c.req.param("id"));
  const body = await withActor(c.var.db, actor, async (trx) => {
    await assertStaff(trx, id);
    await sql`select app.staff_revoke_invite(${id}::uuid)`.execute(trx);
    return loadTeam(trx, actor.id);
  });
  return c.json(body);
});
