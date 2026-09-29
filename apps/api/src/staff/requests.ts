// Заявки клиентов в панели оператора: все заявки, их статус и срок ответа
// вендора (SLA), история. Телефоны скрыты: показать — отдельным запросом,
// который база пишет в журнал доступа к ПДн.
//
//   GET  /staff/requests?status=&sla=&q=&limit=&offset=   список: сначала без ответа
//   GET  /staff/requests/:id                              заявка и история статусов
//   POST /staff/requests/:id/client-phone  { reason }     телефон клиента — только
//        администратор, причина обязательна (так же проверяет функция базы read_request_phone)
//   POST /staff/requests/:id/vendor-phone  { reason? }    кому звонить: контакт вендора
//        и телефон карточки

import type {
  RequestStatus,
  RequestVendorPhones,
  RevealedPhone,
  SlaState,
  StaffRequestDetail,
  StaffRequestList,
} from "@bayramm/shared/api/staff";
import { Hono } from "hono";
import { type RawBuilder, sql } from "kysely";
import { staffOf } from "../auth/session";
import { type Tx, withActor } from "../db/actor";
import { readListingPhone, readRequestPhone, requestContactsAs } from "../db/pii";
import type { AppEnv } from "../env";
import { notFound } from "../errors";
import { requirePermission } from "./access";
import { likePattern, limitJson, paging } from "./input";
import { iso, num, pathId } from "./shared";
import { readReason, readVendorPhones } from "./vendors";

export const requests = new Hono<AppEnv>();

const REQUEST_STATUSES = [
  "new",
  "viewed",
  "contacted",
  "deal",
  "declined",
  "withdrawn",
  "expired",
] as const satisfies readonly RequestStatus[];

export const SLA_STATES = [
  "waiting",
  "overdue",
  "breached",
  "answered",
  "answered_late",
  "closed",
] as const satisfies readonly SlaState[];

// Состояние срока ответа считает база по своим часам — одинаково для списка,
// фильтра и счётчиков
const slaState: RawBuilder<SlaState> = sql<SlaState>`case
  when r.first_response_at is not null then
    case when r.first_response_at <= r.sla_due_at then 'answered' else 'answered_late' end
  when r.status not in ('new', 'viewed') then 'closed'
  when r.sla_breached_at is not null then 'breached'
  when now() > r.sla_due_at then 'overdue'
  else 'waiting'
end`;

// Без ответа — наверху, ближайший срок первым; остальные — свежие сверху
const awaitingFirst = sql<number>`case when r.first_response_at is null and r.status in ('new', 'viewed') then 0 else 1 end`;

const selectRequests = (trx: Tx) =>
  trx
    .selectFrom("app.requests as r")
    .innerJoin("app.listings as l", "l.id", "r.listing_id")
    .innerJoin("app.vendor_accounts as v", "v.id", "r.vendor_id")
    .select([
      "r.id",
      "r.public_no",
      "r.status",
      "r.sla_due_at",
      "r.first_response_at",
      "r.first_response_by",
      "r.occasion_code",
      "r.event_date",
      "r.guests",
      "r.created_at",
      "l.id as listing_id",
      "l.name as listing_name",
      "v.id as vendor_id",
      "v.public_code",
      "v.name as vendor_name",
      slaState.as("sla"),
    ]);

type RequestRow = Awaited<ReturnType<ReturnType<typeof selectRequests>["executeTakeFirstOrThrow"]>>;

function itemView(row: RequestRow) {
  return {
    id: row.id,
    publicNo: num(row.public_no),
    status: row.status,
    sla: row.sla,
    slaDueAt: iso(row.sla_due_at),
    firstResponseAt: iso(row.first_response_at),
    firstResponseBy: row.first_response_by,
    occasionCode: row.occasion_code,
    eventDate: row.event_date,
    guests: row.guests,
    createdAt: iso(row.created_at),
    listing: { id: row.listing_id, name: row.listing_name },
    vendor: { id: row.vendor_id, code: row.public_code, name: row.vendor_name },
  };
}

requests.get("/", requirePermission("requests.read"), async (c) => {
  const q = (c.req.query("q") ?? "").trim().slice(0, 100);
  const status = REQUEST_STATUSES.find((s) => s === c.req.query("status"));
  const sla = SLA_STATES.find((s) => s === c.req.query("sla"));
  const { limit, offset } = paging((key) => c.req.query(key));

  const result = await withActor(c.var.db, staffOf(c), async (trx) => {
    let query = selectRequests(trx).select(sql<number>`(count(*) over ())::int`.as("total"));
    if (status) query = query.where("r.status", "=", status);
    if (sla) query = query.where(sql<boolean>`${slaState} = ${sla}`);
    if (q !== "") {
      const pattern = likePattern(q);
      const number = /^\d{1,12}$/.test(q) ? q : null;
      query = query.where((eb) =>
        eb.or([
          eb("l.name", "ilike", pattern),
          eb("v.name", "ilike", pattern),
          eb("v.public_code", "ilike", pattern),
          ...(number ? [eb("r.public_no", "=", number)] : []),
        ]),
      );
    }
    const rows = await query
      .orderBy(awaitingFirst)
      .orderBy(
        sql`case when r.first_response_at is null and r.status in ('new', 'viewed') then r.sla_due_at end`,
      )
      .orderBy("r.created_at", "desc")
      .limit(limit)
      .offset(offset)
      .execute();
    const counts = await trx
      .selectFrom("app.requests as r")
      .select([slaState.as("sla"), sql<number>`count(*)::int`.as("n")])
      .groupBy(sql`1`)
      .execute();
    return { rows, counts };
  });

  const counts = Object.fromEntries(SLA_STATES.map((s) => [s, 0])) as Record<SlaState, number>;
  for (const row of result.counts) counts[row.sla] = row.n;
  const body: StaffRequestList = {
    total: result.rows[0]?.total ?? 0,
    counts,
    items: result.rows.map(itemView),
  };
  return c.json(body);
});

requests.get("/:id", requirePermission("requests.read"), async (c) => {
  const id = pathId(c.req.param("id"));
  const body: StaffRequestDetail = await withActor(c.var.db, staffOf(c), async (trx) => {
    const row = await selectRequests(trx)
      .leftJoin(requestContactsAs("rc"), "rc.request_id", "r.id")
      .select([
        "r.budget_min_uzs",
        "r.budget_max_uzs",
        "r.decline_reason",
        "r.decline_note",
        "r.first_viewed_at",
        "r.sla_breached_at",
        "r.source",
        "rc.contact_name",
        "rc.comment",
        "rc.purged_at",
      ])
      .where("r.id", "=", id)
      .executeTakeFirst();
    if (!row) throw notFound();
    const history = await trx
      .selectFrom("app.request_status_log")
      .select(["from_status", "to_status", "actor_kind", "source", "reason", "at"])
      .where("request_id", "=", id)
      .orderBy("at", "desc")
      .orderBy("id", "desc")
      .execute();
    return {
      ...itemView(row),
      budgetMinUzs: num(row.budget_min_uzs),
      budgetMaxUzs: num(row.budget_max_uzs),
      declineReason: row.decline_reason,
      declineNote: row.decline_note,
      firstViewedAt: iso(row.first_viewed_at),
      slaBreachedAt: iso(row.sla_breached_at),
      source: row.source,
      contactName: row.purged_at ? null : row.contact_name,
      comment: row.purged_at ? null : row.comment,
      contactPurged: row.purged_at !== null,
      history: history.map((h) => ({
        from: h.from_status,
        to: h.to_status,
        actorKind: h.actor_kind,
        source: h.source,
        reason: h.reason,
        at: iso(h.at),
      })),
    };
  });
  return c.json(body);
});

async function requestRefs(trx: Tx, id: string) {
  const row = await trx
    .selectFrom("app.requests")
    .select(["id", "vendor_id", "listing_id"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) throw notFound();
  return row;
}

requests.post(
  "/:id/client-phone",
  requirePermission("requests.read"),
  requirePermission("client_phones.read"),
  limitJson,
  async (c) => {
    const id = pathId(c.req.param("id"));
    const reason = await readReason(c.req.raw, true);
    const body: RevealedPhone = await withActor(c.var.db, staffOf(c), async (trx) => {
      await requestRefs(trx, id);
      return { phone: await readRequestPhone(trx, id, reason) };
    });
    return c.json(body);
  },
);

requests.post("/:id/vendor-phone", requirePermission("requests.read"), limitJson, async (c) => {
  const id = pathId(c.req.param("id"));
  const reason = await readReason(c.req.raw);
  const body: RequestVendorPhones = await withActor(c.var.db, staffOf(c), async (trx) => {
    const refs = await requestRefs(trx, id);
    const phones = await readVendorPhones(trx, refs.vendor_id, reason);
    return { ...phones, listingPhone: await readListingPhone(trx, refs.listing_id, reason) };
  });
  return c.json(body);
});
