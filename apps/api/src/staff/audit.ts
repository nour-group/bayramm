// Журнал действий (app.audit_log) и журнал доступа к ПДн (app.pii_access_log) —
// только чтение. Оба пишет база: триггеры и функции, API строк не добавляет.
// В журнале действий — коды, id и имена полей, как записано; значений ПДн там нет.
//
//   GET /staff/audit?actor=&actorKind=&type=&object=&action=&from=&to=&limit=&offset=
//   GET /staff/audit/pii?actor=&actorKind=&type=&object=&action=&from=&to=&limit=&offset=
//
// actor — id актора (сотрудника), type и object — вид и id объекта (для ПДн — чей
// телефон), action — начало кода действия (для ПДн — цели чтения), from / to —
// дни по Ташкенту включительно. Неверный фильтр — 422 invalid_input с его именем.

import type {
  ActorKind,
  AuditEntry,
  AuditList,
  PiiAccessEntry,
  PiiAccessList,
} from "@bayramm/shared/api/staff";
import { Hono } from "hono";
import { sql } from "kysely";
import { staffOf } from "../auth/session";
import { withActor } from "../db/actor";
import type { AppEnv } from "../env";
import { addDays, isIsoDate } from "../vendor/dates";
import { requirePermission } from "./access";
import { invalidInput, isUuid, paging } from "./input";
import { iso, staffName } from "./shared";

export const audit = new Hono<AppEnv>();

const ACTOR_KINDS = [
  "account",
  "client",
  "vendor_user",
  "staff",
  "system",
] as const satisfies readonly ActorKind[];
const TYPE_RE = /^[a-z][a-z_]{1,39}$/;
const ACTION_RE = /^[a-z][a-z_.]{0,59}$/;

export interface AuditFilters {
  actor?: string;
  actorKind?: ActorKind;
  type?: string;
  object?: string;
  action?: string;
  /** Первый день и день после последнего — "YYYY-MM-DD" по Ташкенту */
  from?: string;
  until?: string;
}

/** Фильтры из адреса; неверные — 422 со списком имён */
export function parseFilters(query: (key: string) => string | undefined): AuditFilters {
  const bad: string[] = [];
  const filters: AuditFilters = {};
  const value = (key: string) => {
    const raw = query(key)?.trim();
    return raw === undefined || raw === "" ? undefined : raw;
  };

  const actor = value("actor");
  if (actor !== undefined) {
    if (isUuid(actor)) filters.actor = actor.toLowerCase();
    else bad.push("actor");
  }
  const actorKind = value("actorKind");
  if (actorKind !== undefined) {
    const kind = ACTOR_KINDS.find((k) => k === actorKind);
    if (kind) filters.actorKind = kind;
    else bad.push("actorKind");
  }
  const type = value("type");
  if (type !== undefined) {
    if (TYPE_RE.test(type)) filters.type = type;
    else bad.push("type");
  }
  const object = value("object");
  if (object !== undefined) {
    if (object.length <= 100) filters.object = isUuid(object) ? object.toLowerCase() : object;
    else bad.push("object");
  }
  const action = value("action");
  if (action !== undefined) {
    if (ACTION_RE.test(action)) filters.action = action;
    else bad.push("action");
  }
  const from = value("from");
  if (from !== undefined) {
    if (isIsoDate(from)) filters.from = from;
    else bad.push("from");
  }
  const to = value("to");
  if (to !== undefined) {
    if (isIsoDate(to)) filters.until = addDays(to, 1);
    else bad.push("to");
  }
  if (bad.length > 0) throw invalidInput(bad);
  return filters;
}

// День по Ташкенту → момент его начала
const tashkentStart = (day: string) => sql<Date>`(${day}::date::timestamp at time zone 'Asia/Tashkent')`;

/** Имя сотрудника-актора (строка журнала — под псевдонимом a); для остальных — null */
const actorName = sql<string | null>`case when a.actor_kind = 'staff' then ${staffName("a.actor_id")} end`;

const total = sql<number>`(count(*) over ())::int`;

audit.get("/", requirePermission("audit.read"), async (c) => {
  const filters = parseFilters((key) => c.req.query(key));
  const { limit, offset } = paging((key) => c.req.query(key));

  const body: AuditList = await withActor(c.var.db, staffOf(c), async (trx) => {
    let query = trx
      .selectFrom("app.audit_log as a")
      .select([
        "a.id",
        "a.at",
        "a.actor_kind",
        "a.actor_id",
        "a.action",
        "a.object_type",
        "a.object_id",
        "a.detail",
        "a.source",
        actorName.as("actor_name"),
        total.as("total"),
      ]);
    if (filters.actor) query = query.where("a.actor_id", "=", filters.actor);
    if (filters.actorKind) query = query.where("a.actor_kind", "=", filters.actorKind);
    if (filters.type) query = query.where("a.object_type", "=", filters.type);
    if (filters.object) query = query.where("a.object_id", "=", filters.object);
    if (filters.action) query = query.where("a.action", "like", `${filters.action}%`);
    if (filters.from) query = query.where("a.at", ">=", tashkentStart(filters.from));
    if (filters.until) query = query.where("a.at", "<", tashkentStart(filters.until));
    const rows = await query
      .orderBy("a.at", "desc")
      .orderBy("a.id", "desc")
      .limit(limit)
      .offset(offset)
      .execute();
    return {
      total: rows[0]?.total ?? 0,
      items: rows.map(
        (row): AuditEntry => ({
          id: String(row.id),
          at: iso(row.at),
          actorKind: row.actor_kind,
          actor: row.actor_id !== null ? { id: row.actor_id, name: row.actor_name } : null,
          action: row.action,
          objectType: row.object_type,
          objectId: row.object_id,
          detail:
            typeof row.detail === "object" && row.detail !== null && !Array.isArray(row.detail)
              ? row.detail
              : {},
          source: row.source,
        }),
      ),
    };
  });
  return c.json(body);
});

audit.get("/pii", requirePermission("audit.read"), async (c) => {
  const filters = parseFilters((key) => c.req.query(key));
  // Чей телефон — всегда uuid (subject_id)
  if (filters.object !== undefined && !isUuid(filters.object)) throw invalidInput(["object"]);
  const { limit, offset } = paging((key) => c.req.query(key));

  const body: PiiAccessList = await withActor(c.var.db, staffOf(c), async (trx) => {
    let query = trx
      .selectFrom("app.pii_access_log as a")
      .select([
        "a.id",
        "a.at",
        "a.actor_kind",
        "a.actor_id",
        "a.subject_kind",
        "a.subject_id",
        "a.field",
        "a.purpose",
        "a.reason",
        actorName.as("actor_name"),
        total.as("total"),
      ]);
    if (filters.actor) query = query.where("a.actor_id", "=", filters.actor);
    if (filters.actorKind) query = query.where("a.actor_kind", "=", filters.actorKind);
    if (filters.type) query = query.where("a.subject_kind", "=", filters.type);
    if (filters.object) query = query.where("a.subject_id", "=", filters.object);
    if (filters.action) query = query.where("a.purpose", "like", `${filters.action}%`);
    if (filters.from) query = query.where("a.at", ">=", tashkentStart(filters.from));
    if (filters.until) query = query.where("a.at", "<", tashkentStart(filters.until));
    const rows = await query
      .orderBy("a.at", "desc")
      .orderBy("a.id", "desc")
      .limit(limit)
      .offset(offset)
      .execute();
    return {
      total: rows[0]?.total ?? 0,
      items: rows.map(
        (row): PiiAccessEntry => ({
          id: String(row.id),
          at: iso(row.at),
          actorKind: row.actor_kind,
          actor: row.actor_id !== null ? { id: row.actor_id, name: row.actor_name } : null,
          subjectKind: row.subject_kind,
          subjectId: row.subject_id,
          field: row.field,
          purpose: row.purpose,
          reason: row.reason,
        }),
      ),
    };
  });
  return c.json(body);
});
