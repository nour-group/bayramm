// Клиенты в панели оператора. Клиент — псевдоним (id), имя из Telegram видно
// только на странице одного клиента; телефон — только администратору, с
// причиной и записью в журнал доступа к ПДн. Поиск — по id (или его началу) и
// номеру заявки; по имени и телефону не ищем, выгрузки базы клиентов нет.
//
//   GET  /staff/clients?q=&blocked=1&limit=&offset=   список, новые сверху (не больше 50 за раз)
//   GET  /staff/clients/:id                           клиент, его заявки, журнал согласий
//   POST /staff/clients/:id/phone    { reason }       телефон из профиля (функция базы read_client_phone)
//   POST /staff/clients/:id/block    { reason }       заблокировать (app.staff_block_client)
//   POST /staff/clients/:id/unblock                   снять блокировку

import type {
  ClientConsent,
  ClientDetail,
  ClientList,
  ClientListItem,
  ClientRequest,
  ConsentPurpose,
  RevealedPhone,
} from "@bayramm/shared/api/staff";
import { Hono } from "hono";
import { sql } from "kysely";
import { staffOf } from "../auth/session";
import { type Tx, withActor } from "../db/actor";
import { clientProfilesAs, readClientPhone } from "../db/pii";
import type { AppEnv } from "../env";
import { notFound } from "../errors";
import { requirePermission } from "./access";
import { Input, invalidInput, limitJson, paging, readBody } from "./input";
import { slaState } from "./requests";
import { iso, num, pathId, staffName } from "./shared";
import { readReason } from "./vendors";

export const clients = new Hono<AppEnv>();

/** Список — страницами поменьше: это не выгрузка базы */
const MAX_PAGE = 50;

/** C- и первые 8 символов id */
export const clientRef = (id: string) => `C-${id.slice(0, 8)}`;

/**
 * Строка поиска → условие: номер заявки (цифры), полный id, его начало от 8 знаков
 * (можно с «C-»). Остальное — ничего не найдено: по имени и телефону не ищем
 */
export function parseClientQuery(
  raw: string,
): { kind: "request"; no: string } | { kind: "id"; prefix: string } | { kind: "none" } | null {
  const q = raw.trim().toLowerCase();
  if (q === "") return null;
  if (/^№?\s*\d{1,12}$/.test(q)) return { kind: "request", no: q.replace(/\D/g, "") };
  const id = q.replace(/^c-/, "");
  if (/^[0-9a-f]{8}(-[0-9a-f]{0,4}){0,3}(-[0-9a-f]{0,12})?$/.test(id)) return { kind: "id", prefix: id };
  return { kind: "none" };
}

const selectClients = (trx: Tx) =>
  trx
    .selectFrom("app.clients as c")
    .select([
      "c.id",
      "c.created_at",
      "c.last_seen_at",
      "c.locale",
      "c.blocked_at",
      "c.deleted_at",
      sql<number>`(select count(*)::int from app.requests r where r.client_id = c.id)`.as("requests"),
      sql<Date | null>`(select max(r.created_at) from app.requests r where r.client_id = c.id)`.as(
        "last_request_at",
      ),
    ]);

type ClientRow = Awaited<ReturnType<ReturnType<typeof selectClients>["executeTakeFirstOrThrow"]>>;

function itemView(row: ClientRow): ClientListItem {
  return {
    id: row.id,
    ref: clientRef(row.id),
    createdAt: iso(row.created_at),
    lastSeenAt: iso(row.last_seen_at),
    locale: row.locale,
    blocked: row.blocked_at !== null,
    deleted: row.deleted_at !== null,
    requests: row.requests,
    lastRequestAt: iso(row.last_request_at),
  };
}

clients.get("/", requirePermission("clients.read"), async (c) => {
  const search = parseClientQuery((c.req.query("q") ?? "").slice(0, 100));
  const blocked = c.req.query("blocked") === "1";
  const { limit, offset } = paging((key) => c.req.query(key), MAX_PAGE);

  const body: ClientList = await withActor(c.var.db, staffOf(c), async (trx) => {
    if (search?.kind === "none") return { total: 0, items: [] };
    let query = selectClients(trx).select(sql<number>`(count(*) over ())::int`.as("total"));
    if (blocked) query = query.where("c.blocked_at", "is not", null);
    if (search?.kind === "id") query = query.where(sql<boolean>`c.id::text like ${`${search.prefix}%`}`);
    if (search?.kind === "request") {
      query = query.where((eb) =>
        eb.exists(
          eb
            .selectFrom("app.requests as r")
            .select("r.id")
            .whereRef("r.client_id", "=", "c.id")
            .where("r.public_no", "=", search.no),
        ),
      );
    }
    const rows = await query
      .orderBy("c.created_at", "desc")
      .orderBy("c.id")
      .limit(limit)
      .offset(offset)
      .execute();
    return { total: rows[0]?.total ?? 0, items: rows.map(itemView) };
  });
  return c.json(body);
});

async function loadClient(trx: Tx, id: string): Promise<ClientDetail> {
  const row = await selectClients(trx)
    .leftJoin(clientProfilesAs("p"), "p.client_id", "c.id")
    .select([
      "c.can_message",
      "c.blocked_reason",
      staffName("c.blocked_by").as("blocked_by_name"),
      "p.client_id as profile_id",
      "p.first_name",
      "p.last_name",
      "p.username",
    ])
    .where("c.id", "=", id)
    .executeTakeFirst();
  if (row === undefined) throw notFound();

  const requests = await trx
    .selectFrom("app.requests as r")
    .innerJoin("app.listings as l", "l.id", "r.listing_id")
    .select([
      "r.id",
      "r.public_no",
      "r.status",
      "r.event_date",
      "r.created_at",
      "l.id as listing_id",
      "l.name as listing_name",
      slaState.as("sla"),
    ])
    .where("r.client_id", "=", id)
    .orderBy("r.created_at", "desc")
    .limit(100)
    .execute();

  const consents = await trx
    .selectFrom("app.consents as c")
    .innerJoin("app.consent_texts as t", "t.id", "c.text_id")
    .leftJoin("app.listings as l", "l.id", "c.scope_listing_id")
    .select([
      "c.purpose",
      "c.action",
      "c.source",
      "c.created_at",
      "t.version",
      "l.id as listing_id",
      "l.name as listing_name",
    ])
    .where("c.subject_kind", "=", "client")
    .where("c.subject_id", "=", id)
    .orderBy("c.created_at", "desc")
    .orderBy("c.id")
    .limit(200)
    .execute();

  return {
    ...itemView(row),
    canMessage: row.can_message,
    deletedAt: iso(row.deleted_at),
    blockedInfo:
      row.blocked_at !== null
        ? { at: iso(row.blocked_at), reason: row.blocked_reason ?? "", by: row.blocked_by_name }
        : null,
    profile:
      row.profile_id !== null
        ? { firstName: row.first_name, lastName: row.last_name, username: row.username }
        : null,
    requestList: requests.map(
      (r): ClientRequest => ({
        id: r.id,
        publicNo: num(r.public_no),
        status: r.status,
        sla: r.sla,
        eventDate: r.event_date,
        createdAt: iso(r.created_at),
        listing: { id: r.listing_id, name: r.listing_name },
      }),
    ),
    consents: consents.map(
      (row): ClientConsent => ({
        purpose: row.purpose as ConsentPurpose,
        action: row.action,
        textVersion: row.version,
        source: row.source,
        at: iso(row.created_at),
        listing: row.listing_id !== null ? { id: row.listing_id, name: row.listing_name ?? "" } : null,
      }),
    ),
  };
}

clients.get("/:id", requirePermission("clients.read"), async (c) => {
  const id = pathId(c.req.param("id"));
  return c.json(await withActor(c.var.db, staffOf(c), (trx) => loadClient(trx, id)));
});

async function assertClient(trx: Tx, id: string): Promise<void> {
  const found = await trx.selectFrom("app.clients").select("id").where("id", "=", id).executeTakeFirst();
  if (!found) throw notFound();
}

// Телефон из профиля клиента: база отдаёт его только администратору с причиной и
// пишет чтение в app.pii_access_log
clients.post(
  "/:id/phone",
  requirePermission("clients.read"),
  requirePermission("client_phones.read"),
  limitJson,
  async (c) => {
    const id = pathId(c.req.param("id"));
    const reason = await readReason(c.req.raw, true);
    const body: RevealedPhone = await withActor(c.var.db, staffOf(c), async (trx) => {
      await assertClient(trx, id);
      return { phone: await readClientPhone(trx, id, reason) };
    });
    return c.json(body);
  },
);

clients.post("/:id/block", requirePermission("clients.block"), limitJson, async (c) => {
  const id = pathId(c.req.param("id"));
  const input = new Input(await readBody(c.req.raw));
  const reason = input.text("reason", { max: 500, required: true, multiline: true });
  input.done();
  if (typeof reason !== "string") throw invalidInput(["reason"]);
  const body = await withActor(c.var.db, staffOf(c), async (trx) => {
    await assertClient(trx, id);
    await sql`select app.staff_block_client(${id}::uuid, ${reason}::text)`.execute(trx);
    return loadClient(trx, id);
  });
  return c.json(body);
});

clients.post("/:id/unblock", requirePermission("clients.block"), async (c) => {
  const id = pathId(c.req.param("id"));
  const body = await withActor(c.var.db, staffOf(c), async (trx) => {
    await assertClient(trx, id);
    await sql`select app.staff_unblock_client(${id}::uuid)`.execute(trx);
    return loadClient(trx, id);
  });
  return c.json(body);
});
