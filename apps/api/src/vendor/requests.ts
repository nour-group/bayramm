// Входящие заявки кабинета вендора.
//
// Всё — под актором пользователя вендора: чужие заявки RLS не отдаёт, поэтому
// чужой id неотличим от несуществующего (404). Условие vendor_id = вендор
// сессии в запросах — не защита (её держит RLS), а подсказка планировщику
// (индекс requests_vendor_inbox).
//
// Данные клиента — ровно по согласию: имя и комментарий видны, пока согласие
// действует и заявка не отозвана (политика request_contacts_read), телефон —
// только через pii.read_request_phone, каждое чтение — в pii_access_log.
// Какие переходы статусов разрешены, решает база (app.request_transitions);
// отказ «занято» сам занимает дату в календаре (триггер).

import {
  DECLINE_NOTE_MAX,
  DECLINE_REASONS,
  type DeclineReason,
  REQUEST_TABS,
  type RequestStatus,
  type RequestTab,
  TAB_STATUSES,
  VENDOR_TARGET_STATUSES,
  type VendorRequestDetail,
  type VendorRequestItem,
  type VendorRequestPage,
  type VendorRequestPatch,
  type VendorTargetStatus,
} from "@bayramm/shared/api/vendor";
import { sql } from "kysely";
import { type Tx, type VendorActor, withActor } from "../db/actor";
import type { Db } from "../db/client";
import { ApiError, notFound } from "../errors";

export const PAGE_LIMIT_DEFAULT = 30;
export const PAGE_LIMIT_MAX = 50;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** id из адреса: не UUID — такого точно нет (404, а не 400: как и чужой) */
export function idOrNotFound(value: string): string {
  if (!UUID_RE.test(value)) throw notFound();
  return value.toLowerCase();
}

const invalid = (field: string) => new ApiError(422, "invalid_input", "Invalid input", [field]);

// ── разбор запроса ─────────────────────────────────────────────────────────

export interface ListQuery {
  tab: RequestTab;
  /** Номер заявки, после которой продолжать (строго меньше) */
  before: number | null;
  limit: number;
}

export function parseListQuery(query: Record<string, string | undefined>): ListQuery {
  const tab = query.tab ?? "new";
  if (!(REQUEST_TABS as readonly string[]).includes(tab)) throw invalid("tab");

  let before: number | null = null;
  if (query.cursor !== undefined) {
    if (!/^[1-9][0-9]{0,15}$/.test(query.cursor)) throw invalid("cursor");
    before = Number(query.cursor);
  }

  let limit = PAGE_LIMIT_DEFAULT;
  if (query.limit !== undefined) {
    if (!/^[0-9]{1,3}$/.test(query.limit)) throw invalid("limit");
    limit = Number(query.limit);
    if (limit < 1 || limit > PAGE_LIMIT_MAX) throw invalid("limit");
  }
  return { tab: tab as RequestTab, before, limit };
}

export function parsePatch(body: unknown): VendorRequestPatch {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("body");
  const { status, declineReason, declineNote } = body as Record<string, unknown>;

  if (!(VENDOR_TARGET_STATUSES as readonly unknown[]).includes(status)) throw invalid("status");
  const target = status as VendorTargetStatus;

  if (target !== "declined") {
    if (declineReason !== undefined && declineReason !== null) throw invalid("declineReason");
    if (declineNote !== undefined && declineNote !== null) throw invalid("declineNote");
    return { status: target };
  }

  if (!(DECLINE_REASONS as readonly unknown[]).includes(declineReason)) throw invalid("declineReason");
  let note: string | undefined;
  if (declineNote !== undefined && declineNote !== null) {
    if (typeof declineNote !== "string") throw invalid("declineNote");
    const trimmed = declineNote.trim();
    if (Array.from(trimmed).length > DECLINE_NOTE_MAX) throw invalid("declineNote");
    if (trimmed !== "") note = trimmed;
  }
  return {
    status: target,
    declineReason: declineReason as DeclineReason,
    ...(note === undefined ? {} : { declineNote: note }),
  };
}

// ── чтение ─────────────────────────────────────────────────────────────────

/** Заявки вендора с листингом и контактом (контакт — только если его видно по согласию) */
function requestsOf(trx: Tx, actor: VendorActor) {
  return trx
    .selectFrom("app.requests as r")
    .innerJoin("app.listings as l", "l.id", "r.listing_id")
    .leftJoin("pii.request_contacts as rc", (join) =>
      join.onRef("rc.request_id", "=", "r.id").on("rc.purged_at", "is", null),
    )
    .select([
      "r.id",
      "r.public_no",
      "r.status",
      "r.decline_reason",
      "r.listing_id",
      "l.name as listing_name",
      "r.occasion_code",
      "r.event_date",
      "r.guests",
      "r.budget_min_uzs",
      "r.budget_max_uzs",
      "r.created_at",
      "r.sla_due_at",
      "r.first_response_at",
      sql<boolean>`r.sla_breached_at is not null or coalesce(r.first_response_at, now()) > r.sla_due_at`.as(
        "sla_breached",
      ),
      "r.decline_note",
      "rc.contact_name",
      "rc.comment",
    ])
    .where("r.vendor_id", "=", actor.vendorId);
}

type ItemRow = Awaited<ReturnType<ReturnType<typeof requestsOf>["executeTakeFirstOrThrow"]>>;

const money = (value: string | null): number | null => (value === null ? null : Number(value));

function toItem(row: ItemRow): VendorRequestItem {
  return {
    id: row.id,
    publicNo: Number(row.public_no),
    status: row.status,
    declineReason: row.decline_reason,
    listing: { id: row.listing_id, name: row.listing_name },
    occasionCode: row.occasion_code,
    eventDate: row.event_date,
    guests: row.guests,
    budgetMinUzs: money(row.budget_min_uzs),
    budgetMaxUzs: money(row.budget_max_uzs),
    createdAt: row.created_at.toISOString(),
    sla: {
      dueAt: row.sla_due_at.toISOString(),
      firstResponseAt: row.first_response_at?.toISOString() ?? null,
      breached: row.sla_breached === true,
    },
    contactName: row.contact_name,
  };
}

function emptyCounts(): Record<RequestTab, number> {
  return { new: 0, active: 0, closed: 0 };
}

const tabOf = (status: RequestStatus): RequestTab =>
  REQUEST_TABS.find((tab) => TAB_STATUSES[tab].includes(status)) ?? "closed";

/** GET /vendor/requests: страница вкладки, новые сверху, и счётчики вкладок */
export async function listRequests(db: Db, actor: VendorActor, query: ListQuery): Promise<VendorRequestPage> {
  return withActor(db, actor, async (trx) => {
    let page = requestsOf(trx, actor).where("r.status", "in", [...TAB_STATUSES[query.tab]]);
    if (query.before !== null) page = page.where("r.public_no", "<", String(query.before));
    const rows = await page
      .orderBy("r.public_no", "desc")
      .limit(query.limit + 1)
      .execute();

    const byStatus = await trx
      .selectFrom("app.requests")
      .select(["status", sql<number>`count(*)::int`.as("n")])
      .where("vendor_id", "=", actor.vendorId)
      .groupBy("status")
      .execute();

    const counts = emptyCounts();
    for (const { status, n } of byStatus) counts[tabOf(status)] += Number(n);

    const items = rows.slice(0, query.limit).map(toItem);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: rows.length > query.limit && last ? String(last.publicNo) : null,
      counts,
    };
  });
}

async function readItem(trx: Tx, actor: VendorActor, id: string): Promise<ItemRow> {
  const row = await requestsOf(trx, actor).where("r.id", "=", id).executeTakeFirst();
  if (row === undefined) throw notFound();
  return row;
}

/**
 * GET /vendor/requests/:id: карточка заявки. Новую — отмечает просмотренной
 * (new → viewed, в журнале статусов — вендор, источник vendor_cabinet).
 * Телефон клиента — через журналируемое чтение и только при видимом контакте.
 */
export async function getRequest(db: Db, actor: VendorActor, id: string): Promise<VendorRequestDetail> {
  return withActor(db, actor, async (trx) => {
    await trx
      .updateTable("app.requests")
      .set({ status: "viewed" })
      .where("id", "=", id)
      .where("vendor_id", "=", actor.vendorId)
      .where("status", "=", "new")
      .execute();

    const row = await readItem(trx, actor, id);

    let phone: string | null = null;
    if (row.contact_name !== null) {
      const { rows } = await sql<{ phone: string | null }>`
        select pii.read_request_phone(${id}::uuid) as phone`.execute(trx);
      phone = rows[0]?.phone ?? null;
    }

    const history = await trx
      .selectFrom("app.request_status_log")
      .select(["to_status", "at", "actor_kind"])
      .where("request_id", "=", id)
      .orderBy("id")
      .execute();

    return {
      ...toItem(row),
      declineNote: row.decline_note,
      contact: row.contact_name === null ? null : { name: row.contact_name, phone, comment: row.comment },
      history: history.map((entry) => ({
        status: entry.to_status,
        at: entry.at.toISOString(),
        by: entry.actor_kind,
      })),
    };
  });
}

// ── действия ───────────────────────────────────────────────────────────────

/**
 * PATCH /vendor/requests/:id: переход статуса. Повтор того же действия (двойное
 * нажатие) — не ошибка: заявка возвращается как есть. Недопустимый переход —
 * 409 illegal_transition от базы.
 */
export async function updateRequestStatus(
  db: Db,
  actor: VendorActor,
  id: string,
  patch: VendorRequestPatch,
): Promise<VendorRequestItem> {
  return withActor(db, actor, async (trx) => {
    const current = await readItem(trx, actor, id);
    const repeated =
      current.status === patch.status &&
      (patch.status !== "declined" || current.decline_reason === patch.declineReason);
    if (repeated) return toItem(current);

    await trx
      .updateTable("app.requests")
      .set({
        status: patch.status,
        decline_reason: patch.status === "declined" ? (patch.declineReason ?? null) : null,
        decline_note: patch.status === "declined" ? (patch.declineNote ?? null) : null,
      })
      .where("id", "=", id)
      .where("vendor_id", "=", actor.vendorId)
      .execute();
    return toItem(await readItem(trx, actor, id));
  });
}

/** POST /vendor/requests/:id/call: нажатие на телефон клиента — в журнал действий, статус не меняется */
export async function logCallAttempt(db: Db, actor: VendorActor, id: string): Promise<void> {
  await withActor(db, actor, async (trx) => {
    await readItem(trx, actor, id);
    // Актор и время журнал берёт из транзакции; в detail — ничего о клиенте
    await trx
      .insertInto("app.audit_log")
      .values({
        action: "request.call_attempt",
        object_type: "request",
        object_id: id,
        source: "vendor_cabinet",
      })
      .execute();
  });
}
