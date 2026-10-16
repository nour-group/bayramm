// Входящие заявки кабинета вендора.
//
// Всё — под актором пользователя вендора: чужие заявки RLS не отдаёт, поэтому
// чужой id неотличим от несуществующего (404). Условие vendor_id = вендор
// сессии в запросах — не защита (её держит RLS), а подсказка планировщику
// (индекс requests_vendor_inbox).
//
// Данные клиента — ровно по согласию: имя и комментарий видны, пока согласие
// действует и заявка не отозвана (политика request_contacts_read), телефон —
// только через readRequestPhone (db/pii), каждое чтение — в pii_access_log.
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
import type { RequestDetails } from "@bayramm/shared/categories";
import { sql } from "kysely";
import { dayPartsOf, requestWindowsOf } from "../calendar/sessions";
import { roleActorKind, type Tx, type VendorActor, withActor } from "../db/actor";
import type { Db } from "../db/client";
import { readRequestPhone, requestContactsAs } from "../db/pii";
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
//
// Порядок входящих (кабинет, раздел «Заявки»: сначала те, где время истекает):
//   · «Ждут ответа» и «В работе» — сначала ждущие ответа (new/viewed без первого ответа),
//     среди них — по сроку ответа, ближайший сверху; просроченные — самые ранние
//     сроки, поэтому они выше всех. Ответившие («связались») — ниже, тоже по сроку;
//   · «Закрытые» — новые сверху (по номеру заявки).
// Курсор — позиция последней заявки страницы в этом порядке:
//   открытые — "<ответили 0|1>.<срок в микросекундах эпохи>.<номер>", закрытые — "<номер>".

/** Позиция последней заявки страницы */
export type InboxCursor =
  | { readonly kind: "deadline"; readonly answered: boolean; readonly dueUs: number; readonly no: number }
  | { readonly kind: "newest"; readonly no: number };

export interface ListQuery {
  tab: RequestTab;
  /** Только заявки этой витрины (переключатель витрин кабинета); null — все */
  listingId: string | null;
  /** После какой заявки продолжать; null — первая страница */
  after: InboxCursor | null;
  limit: number;
}

const NEWEST_CURSOR_RE = /^[1-9][0-9]{0,15}$/;
const DEADLINE_CURSOR_RE = /^([01])\.([1-9][0-9]{0,16})\.([1-9][0-9]{0,15})$/;

/** Курсор вкладки: у закрытой — номер заявки, у открытых — срок ответа и номер */
export function parseInboxCursor(tab: RequestTab, value: string): InboxCursor | null {
  if (tab === "closed") {
    return NEWEST_CURSOR_RE.test(value) ? { kind: "newest", no: Number(value) } : null;
  }
  const match = DEADLINE_CURSOR_RE.exec(value);
  if (!match) return null;
  const dueUs = Number(match[2]);
  const no = Number(match[3]);
  if (!Number.isSafeInteger(dueUs) || !Number.isSafeInteger(no)) return null;
  return { kind: "deadline", answered: match[1] === "1", dueUs, no };
}

export function formatInboxCursor(cursor: InboxCursor): string {
  return cursor.kind === "newest"
    ? String(cursor.no)
    : `${cursor.answered ? 1 : 0}.${cursor.dueUs}.${cursor.no}`;
}

/** Прежнее имя вкладки «Ждут ответа» — его шлют старые сборки кабинета */
const LEGACY_TABS: Readonly<Record<string, RequestTab>> = { new: "waiting" };

export function parseListQuery(query: Record<string, string | undefined>): ListQuery {
  const asked = query.tab ?? "waiting";
  const tab = Object.hasOwn(LEGACY_TABS, asked) ? LEGACY_TABS[asked] : asked;
  if (tab === undefined || !(REQUEST_TABS as readonly string[]).includes(tab)) throw invalid("tab");

  let after: InboxCursor | null = null;
  if (query.cursor !== undefined) {
    after = parseInboxCursor(tab as RequestTab, query.cursor);
    if (after === null) throw invalid("cursor");
  }

  let listingId: string | null = null;
  if (query.listingId !== undefined && query.listingId !== "") {
    if (!UUID_RE.test(query.listingId)) throw invalid("listingId");
    listingId = query.listingId.toLowerCase();
  }

  let limit = PAGE_LIMIT_DEFAULT;
  if (query.limit !== undefined) {
    if (!/^[0-9]{1,3}$/.test(query.limit)) throw invalid("limit");
    limit = Number(query.limit);
    if (limit < 1 || limit > PAGE_LIMIT_MAX) throw invalid("limit");
  }
  return { tab: tab as RequestTab, listingId, after, limit };
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
    .leftJoin(requestContactsAs("rc"), (join) =>
      join.onRef("rc.request_id", "=", "r.id").on("rc.purged_at", "is", null),
    )
    .select([
      "r.id",
      "r.public_no",
      "r.status",
      "r.decline_reason",
      "r.listing_id",
      "l.name as listing_name",
      "l.category_code",
      "l.part_windows",
      "r.occasion_code",
      "r.event_date",
      "r.guests",
      "r.day_parts",
      "r.details",
      "r.budget_min_uzs",
      "r.budget_max_uzs",
      "r.created_at",
      "r.sla_due_at",
      "r.first_response_at",
      "r.first_response_by",
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
    listing: {
      id: row.listing_id,
      name: row.listing_name,
      categoryCode: row.category_code,
      partWindows: requestWindowsOf(row.category_code, row.part_windows),
    },
    occasionCode: row.occasion_code,
    eventDate: row.event_date,
    guests: row.guests,
    dayParts: dayPartsOf(row.day_parts),
    details: row.details as RequestDetails,
    budgetMinUzs: money(row.budget_min_uzs),
    budgetMaxUzs: money(row.budget_max_uzs),
    createdAt: row.created_at.toISOString(),
    sla: {
      dueAt: row.sla_due_at.toISOString(),
      firstResponseAt: row.first_response_at?.toISOString() ?? null,
      breached: row.sla_breached === true,
    },
    // Ответ — всегда роль (партнёр, менеджер, система), аккаунта в заявке нет
    firstResponseBy: row.first_response_by === null ? null : roleActorKind(row.first_response_by),
    contactName: row.contact_name,
  };
}

function emptyCounts(): Record<RequestTab, number> {
  return { waiting: 0, active: 0, closed: 0 };
}

const tabOf = (status: RequestStatus): RequestTab =>
  REQUEST_TABS.find((tab) => TAB_STATUSES[tab].includes(status)) ?? "closed";

// Ответили ли уже (зеркало awaitsAnswer кабинета) и срок ответа в микросекундах эпохи:
// timestamptz хранит микросекунды, целое сравнение в курсоре — без потерь
const ANSWERED = sql<boolean>`(r.status not in ('new', 'viewed') or r.first_response_at is not null)`;
const DUE_US = sql<string>`(extract(epoch from r.sla_due_at) * 1000000)::bigint`;

/**
 * GET /vendor/requests: страница вкладки в порядке входящих (см. выше), счётчики вкладок и
 * сколько ждущих ответа уже просрочено — по всем вкладкам (плашка над списком и значок)
 */
export async function listRequests(db: Db, actor: VendorActor, query: ListQuery): Promise<VendorRequestPage> {
  return withActor(db, actor, async (trx) => {
    const base = requestsOf(trx, actor)
      .select([ANSWERED.as("answered"), DUE_US.as("due_us")])
      .where("r.status", "in", [...TAB_STATUSES[query.tab]])
      .$if(typeof query.listingId === "string", (qb) =>
        qb.where("r.listing_id", "=", query.listingId as string),
      );
    const { after } = query;
    const rows =
      query.tab === "closed"
        ? await base
            .$if(after?.kind === "newest", (qb) => qb.where("r.public_no", "<", String(after?.no)))
            .orderBy("r.public_no", "desc")
            .limit(query.limit + 1)
            .execute()
        : await base
            .$if(after?.kind === "deadline", (qb) => {
              const c = after as Extract<InboxCursor, { kind: "deadline" }>;
              return qb.where(
                sql<boolean>`(${ANSWERED}, ${DUE_US}, r.public_no) > (${c.answered}::boolean, ${c.dueUs}::bigint, ${c.no}::bigint)`,
              );
            })
            .orderBy(ANSWERED)
            .orderBy(DUE_US)
            .orderBy("r.public_no")
            .limit(query.limit + 1)
            .execute();

    // Просроченные — ждут первого ответа и срок вышел (как app.metrics_ops_now у команды)
    const byStatus = await trx
      .selectFrom("app.requests")
      .select([
        "status",
        sql<number>`count(*)::int`.as("n"),
        sql<number>`(count(*) filter (where first_response_at is null and sla_due_at <= now()))::int`.as(
          "overdue",
        ),
      ])
      .where("vendor_id", "=", actor.vendorId)
      .$if(typeof query.listingId === "string", (qb) =>
        qb.where("listing_id", "=", query.listingId as string),
      )
      .groupBy("status")
      .execute();

    const counts = emptyCounts();
    let overdue = 0;
    for (const row of byStatus) {
      counts[tabOf(row.status)] += Number(row.n);
      if (row.status === "new" || row.status === "viewed") overdue += Number(row.overdue);
    }

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    let nextCursor: string | null = null;
    if (rows.length > query.limit && last) {
      const no = Number(last.public_no);
      nextCursor = formatInboxCursor(
        query.tab === "closed"
          ? { kind: "newest", no }
          : { kind: "deadline", answered: last.answered, dueUs: Number(last.due_us), no },
      );
    }
    return { items: page.map(toItem), nextCursor, counts, overdue };
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
      phone = await readRequestPhone(trx, id);
    }

    const history = await trx
      .selectFrom("app.request_status_log")
      .select(["from_status", "to_status", "at", "actor_kind"])
      .where("request_id", "=", id)
      .orderBy("id")
      .execute();

    return {
      ...toItem(row),
      declineNote: row.decline_note,
      contact: row.contact_name === null ? null : { name: row.contact_name, phone, comment: row.comment },
      history: withoutUndone(history).map((entry) => ({
        status: entry.to_status,
        at: entry.at.toISOString(),
        by: roleActorKind(entry.actor_kind),
      })),
    };
  });
}

/**
 * История без отменённой отметки: «связались» и её отмена (contacted → new/viewed — так меняет
 * только отмена) — нажатие по ошибке, а не шаг заявки
 */
export function withoutUndone<E extends { from_status: RequestStatus | null; to_status: RequestStatus }>(
  entries: readonly E[],
): E[] {
  const kept: E[] = [];
  for (const [index, entry] of entries.entries()) {
    const next = entries[index + 1];
    const undone =
      entry.to_status === "contacted" &&
      next?.from_status === "contacted" &&
      (next.to_status === "new" || next.to_status === "viewed");
    const undo =
      entry.from_status === "contacted" && (entry.to_status === "new" || entry.to_status === "viewed");
    if (!undone && !undo) kept.push(entry);
  }
  return kept;
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

/**
 * POST /vendor/requests/:id/undo: отменить «Я связался с клиентом», нажатое по ошибке. Решает
 * база (app.vendor_request_undo_contacted): тот же пользователь, первые VENDOR_UNDO_SECONDS, отметка —
 * последний шаг; иначе 409 undo_expired. Чужая заявка — 404, как несуществующая
 */
export async function undoContacted(db: Db, actor: VendorActor, id: string): Promise<VendorRequestItem> {
  return withActor(db, actor, async (trx) => {
    await readItem(trx, actor, id);
    await sql`select app.vendor_request_undo_contacted(${id}::uuid)`.execute(trx);
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
