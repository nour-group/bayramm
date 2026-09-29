// Заявки клиентов в панели оператора: все заявки, их статус и срок ответа
// вендора (SLA), история, заметки. Телефоны скрыты: показать — отдельным
// запросом, который база пишет в журнал доступа к ПДн.
//
//   GET  /staff/requests?status=&sla=&q=&limit=&offset=   список: сначала без ответа;
//        sla=late — очередь просроченных и нарушенных, самый давний срок первым
//   GET  /staff/requests/:id                              заявка, история, срок ответа по
//        шагам (timeline), заметки
//   POST /staff/requests/:id/client-phone  { reason }     телефон клиента — только
//        администратор, причина обязательна (так же проверяет функция базы read_request_phone)
//   POST /staff/requests/:id/vendor-phone  { reason? }    кому звонить: контакт вендора
//        и телефон карточки
//   POST /staff/requests/:id/remind                       напомнить вендору сейчас
//        (app.staff_remind_vendor: не чаще раза в 30 минут, только пока ждёт ответа)
//   POST /staff/requests/:id/contacted  { comment? }      «связались» — переход заявки
//        сотрудником: first_response_by = staff, в метрику ответов вендора не идёт
//   POST /staff/requests/:id/notes      { text }          заметка (только добавить)

import type {
  RequestNote,
  RequestStatus,
  RequestVendorPhones,
  RevealedPhone,
  SlaEvent,
  SlaState,
  StaffRequestDetail,
  StaffRequestList,
} from "@bayramm/shared/api/staff";
import { Hono } from "hono";
import { type RawBuilder, sql } from "kysely";
import { staffOf } from "../auth/session";
import { type Tx, withActor } from "../db/actor";
import {
  notifiableVendorUsers,
  readListingPhone,
  readRequestPhone,
  requestContactsAs,
  staffName,
  staffNameByText,
} from "../db/pii";
import type { AppEnv } from "../env";
import { ApiError, notFound } from "../errors";
import { outboxKick } from "../notify/kick";
import { requirePermission } from "./access";
import { Input, invalidInput, likePattern, limitJson, paging, readBody } from "./input";
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
  "ops_contacted",
  "closed",
] as const satisfies readonly SlaState[];

/** Очередь «требует действия»: срок вышел, ответа нет */
const LATE: readonly SlaState[] = ["overdue", "breached"];

/** Напоминания вендору: этапы SLA (cron) и от сотрудника */
const REMINDER_KINDS = ["vendor.sla_reminder", "vendor.ops_reminder"];

/** Пауза между напоминаниями сотрудника — как в app.staff_remind_vendor */
const OPS_REMINDER_PAUSE = sql`interval '30 minutes'`;

// Состояние срока ответа считает база по своим часам — одинаково для списка,
// фильтра и счётчиков. Первым «связались» отметил сотрудник — это не ответ
// вендора (first_response_by = staff): отдельное состояние, в «ответ в срок» не идёт
export const slaState: RawBuilder<SlaState> = sql<SlaState>`case
  when r.first_response_at is not null then
    case when r.first_response_by = 'staff' then 'ops_contacted'
         when r.first_response_at <= r.sla_due_at then 'answered'
         else 'answered_late' end
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
      // Одно напоминание — одно событие, даже если получателей несколько
      sql<number>`(select count(distinct (o.kind, o.created_at))::int from app.outbox o
                   where o.request_id = r.id and o.kind in (${sql.join(REMINDER_KINDS)}))`.as("reminders"),
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
    reminders: row.reminders,
  };
}

requests.get("/", requirePermission("requests.read"), async (c) => {
  const q = (c.req.query("q") ?? "").trim().slice(0, 100);
  const status = REQUEST_STATUSES.find((s) => s === c.req.query("status"));
  const slaParam = c.req.query("sla");
  const sla = slaParam === "late" ? LATE : SLA_STATES.filter((s) => s === slaParam);
  const { limit, offset } = paging((key) => c.req.query(key));

  const result = await withActor(c.var.db, staffOf(c), async (trx) => {
    let query = selectRequests(trx).select(sql<number>`(count(*) over ())::int`.as("total"));
    if (status) query = query.where("r.status", "=", status);
    if (sla.length > 0) query = query.where(sql<boolean>`${slaState} in (${sql.join(sla)})`);
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

// ── заявка целиком ──────────────────────────────────────────────────────────

interface ReminderRow {
  kind: string;
  at: Date;
  stage: string | null;
  by: string | null;
  recipients: number;
  delivered: number;
  failed: number;
}

/** Заявка целиком: поля, история статусов, срок ответа по шагам, заметки */
async function loadRequest(trx: Tx, id: string): Promise<StaffRequestDetail> {
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
      sql<boolean>`r.status in ('new', 'viewed') and r.first_response_at is null`.as("awaiting"),
      // Кому уйдёт напоминание — те же условия, что в app.enqueue_vendor_notice
      notifiableVendorUsers("r.vendor_id").as("reachable"),
      sql<Date | null>`(select max(o.created_at) + ${OPS_REMINDER_PAUSE} from app.outbox o
                        where o.request_id = r.id and o.kind = 'vendor.ops_reminder')`.as(
        "reminder_pause_until",
      ),
      sql<Date>`now()`.as("now"),
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

  // Напоминание — строка outbox на каждого пользователя вендора: сводим в одно событие.
  // Кто напомнил — id сотрудника в payload, имя — из профиля
  const { rows: reminders } = await sql<ReminderRow>`
    select o.kind, o.created_at as at, o.payload ->> 'stage' as stage,
           ${staffNameByText(sql<string | null>`o.payload ->> 'staff_id'`)} as by,
           count(*)::int as recipients,
           (count(*) filter (where o.status = 'sent'))::int as delivered,
           (count(*) filter (where o.status = 'dead'))::int as failed
    from app.outbox o
    where o.request_id = ${id}::uuid and o.kind in (${sql.join(REMINDER_KINDS)})
    group by 1, 2, 3, 4
    order by 2`.execute(trx);

  const notes = await trx
    .selectFrom("app.request_notes as n")
    .select([
      "n.id",
      "n.body",
      "n.created_at",
      staffName("n.author_id").as("author"),
    ])
    .where("n.request_id", "=", id)
    .orderBy("n.created_at")
    .orderBy("n.id")
    .execute();

  const now = row.now.getTime();
  const events: SlaEvent[] = [
    { kind: "created", at: iso(row.created_at) },
    ...(row.first_viewed_at ? [{ kind: "viewed" as const, at: iso(row.first_viewed_at) }] : []),
    ...reminders.map(
      (r): SlaEvent => ({
        kind: "reminder",
        at: iso(r.at),
        source: r.kind === "vendor.ops_reminder" ? "ops" : "auto",
        stage: r.stage !== null && /^\d$/.test(r.stage) ? Number(r.stage) : null,
        by: r.by,
        recipients: r.recipients,
        delivered: r.delivered,
        failed: r.failed,
      }),
    ),
    { kind: "due", at: iso(row.sla_due_at), passed: row.sla_due_at.getTime() <= now },
    ...(row.sla_breached_at ? [{ kind: "breached" as const, at: iso(row.sla_breached_at) }] : []),
    ...(row.first_response_at && row.first_response_by
      ? [{ kind: "response" as const, at: iso(row.first_response_at), by: row.first_response_by }]
      : []),
  ];
  // По времени; при равенстве — в порядке, в котором события перечислены выше
  const timeline = events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.at.localeCompare(b.event.at) || a.index - b.index)
    .map(({ event }) => event);

  const pauseUntil = row.reminder_pause_until;
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
    timeline,
    notes: notes.map(
      (n): RequestNote => ({ id: n.id, text: n.body, authorName: n.author, at: iso(n.created_at) }),
    ),
    awaiting: row.awaiting,
    vendorReachable: row.reachable,
    nextReminderAt: pauseUntil !== null && pauseUntil.getTime() > now ? iso(pauseUntil) : null,
  };
}

requests.get("/:id", requirePermission("requests.read"), async (c) => {
  const id = pathId(c.req.param("id"));
  return c.json(await withActor(c.var.db, staffOf(c), (trx) => loadRequest(trx, id)));
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

// ── действия с заявкой ──────────────────────────────────────────────────────

// Напоминание ставит в outbox база (app.staff_remind_vendor) — отправляем сразу
requests.post("/:id/remind", requirePermission("requests.write"), outboxKick, async (c) => {
  const id = pathId(c.req.param("id"));
  const body: StaffRequestDetail = await withActor(c.var.db, staffOf(c), async (trx) => {
    await requestRefs(trx, id);
    await sql`select app.staff_remind_vendor(${id}::uuid)`.execute(trx);
    return loadRequest(trx, id);
  });
  return c.json(body);
});

// «Связались»: переход new|viewed → contacted от сотрудника. Кто отметил, пишет база
// (first_response_by = staff, история статусов, журнал); комментарий — в историю
// статусов (app.reason). Клиенту уходит то же уведомление, что при ответе вендора
requests.post("/:id/contacted", requirePermission("requests.write"), limitJson, outboxKick, async (c) => {
  const id = pathId(c.req.param("id"));
  const input = new Input(await readBody(c.req.raw));
  const comment = input.text("comment", { max: 1000, multiline: true });
  input.done();

  const body: StaffRequestDetail = await withActor(c.var.db, staffOf(c), async (trx) => {
    await requestRefs(trx, id);
    if (comment) await sql`select set_config('app.reason', ${comment}, true)`.execute(trx);
    const updated = await trx
      .updateTable("app.requests")
      .set({ status: "contacted" })
      .where("id", "=", id)
      .where("status", "in", ["new", "viewed"])
      .returning("id")
      .executeTakeFirst();
    if (!updated) throw new ApiError(409, "illegal_transition", "Request is not awaiting a response");
    return loadRequest(trx, id);
  });
  return c.json(body);
});

requests.post("/:id/notes", requirePermission("requests.write"), limitJson, async (c) => {
  const id = pathId(c.req.param("id"));
  const input = new Input(await readBody(c.req.raw));
  const text = input.text("text", { max: 1000, required: true, multiline: true });
  input.done();
  if (typeof text !== "string") throw invalidInput(["text"]);

  const body: StaffRequestDetail = await withActor(c.var.db, staffOf(c), async (trx) => {
    await requestRefs(trx, id);
    // Автора и время ставит база (app.request_notes_before_insert)
    await trx.insertInto("app.request_notes").values({ request_id: id, body: text }).execute();
    return loadRequest(trx, id);
  });
  return c.json(body, 201);
});
