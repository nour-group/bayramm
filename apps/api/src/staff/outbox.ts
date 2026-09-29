// Здоровье очереди уведомлений (app.outbox): сколько ждёт отправки, сколько не
// доставлено и почему. Получатель — только вид и начало id, payload не отдаём:
// в нём id, а текст сообщения собирается при отправке.
//
//   GET  /staff/outbox              счётчики и недоставленные (dead), новые сверху
//   POST /staff/outbox/:id/retry    недоставленное — снова в очередь (app.staff_retry_outbox)

import type { OutboxDeadItem, OutboxHealth, OutboxStatus } from "@bayramm/shared/api/staff";
import { Hono } from "hono";
import { sql } from "kysely";
import { staffOf } from "../auth/session";
import { type Tx, withActor } from "../db/actor";
import type { AppEnv } from "../env";
import { notFound } from "../errors";
import { outboxKick } from "../notify/kick";
import { requirePermission } from "./access";
import { iso, num, pathId } from "./shared";

export const outbox = new Hono<AppEnv>();

const STATUSES = ["pending", "sending", "sent", "failed", "dead"] as const satisfies readonly OutboxStatus[];
const DEAD_LIMIT = 100;
/** Причина ошибки в панели — коротко: полная строка есть в базе */
const ERROR_MAX = 300;

async function loadHealth(trx: Tx): Promise<OutboxHealth> {
  // sent копится без конца — считаем только за сутки
  const counts = await trx
    .selectFrom("app.outbox")
    .select(["status", sql<number>`count(*)::int`.as("n")])
    .where((eb) =>
      eb.or([eb("status", "<>", "sent"), eb("sent_at", ">", sql<Date>`now() - interval '24 hours'`)]),
    )
    .groupBy("status")
    .execute();
  const oldest = await trx
    .selectFrom("app.outbox")
    .select(sql<Date | null>`min(next_attempt_at)`.as("at"))
    .where("status", "in", ["pending", "failed"])
    .executeTakeFirst();
  const dead = await trx
    .selectFrom("app.outbox as o")
    .leftJoin("app.requests as r", "r.id", "o.request_id")
    .select([
      "o.id",
      "o.kind",
      "o.recipient_kind",
      "o.recipient_id",
      "o.attempts",
      "o.last_error",
      "o.created_at",
      "o.enqueued_at",
      "r.id as request_id",
      "r.public_no",
      sql<number>`(count(*) over ())::int`.as("total"),
    ])
    .where("o.status", "=", "dead")
    .orderBy("o.created_at", "desc")
    .orderBy("o.id")
    .limit(DEAD_LIMIT)
    .execute();

  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<OutboxStatus, number>;
  for (const row of counts) byStatus[row.status] = row.n;
  return {
    counts: byStatus,
    oldestPendingAt: iso(oldest?.at ?? null),
    deadTotal: dead[0]?.total ?? 0,
    dead: dead.map(
      (row): OutboxDeadItem => ({
        id: row.id,
        kind: row.kind,
        recipientKind: row.recipient_kind,
        recipientRef: row.recipient_id ? row.recipient_id.slice(0, 8) : null,
        attempts: row.attempts,
        error: row.last_error ? row.last_error.slice(0, ERROR_MAX) : null,
        createdAt: iso(row.created_at),
        lastAttemptAt: iso(row.enqueued_at),
        request:
          row.request_id !== null && row.public_no !== null
            ? { id: row.request_id, publicNo: num(row.public_no) }
            : null,
      }),
    ),
  };
}

outbox.get("/", requirePermission("outbox.read"), async (c) => {
  return c.json(await withActor(c.var.db, staffOf(c), loadHealth));
});

// Поставили в очередь — отправляем сразу, не дожидаясь cron
outbox.post("/:id/retry", requirePermission("outbox.retry"), outboxKick, async (c) => {
  const id = pathId(c.req.param("id"));
  const body = await withActor(c.var.db, staffOf(c), async (trx) => {
    const found = await trx.selectFrom("app.outbox").select("id").where("id", "=", id).executeTakeFirst();
    if (!found) throw notFound();
    await sql`select app.staff_retry_outbox(${id}::uuid)`.execute(trx);
    return loadHealth(trx);
  });
  return c.json(body);
});
