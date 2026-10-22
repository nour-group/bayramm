// Календарь занятости листинга в кабинете вендора.
//
// Строка app.availability = день занят целиком. У витрин с календарём день делится на утро, день
// и вечер: строка app.availability_parts — часть дня занята; часть занята и тогда, когда
// договорённостей (заявки deal) на неё столько же, сколько заказов витрина берёт одновременно
// (parallel_capacity). Как витрина работает — «Время работы» (calendar/sessions.ts): одно
// мероприятие в день (whole — любая договорённость или отметка занимает весь день) или
// несколько, в своих частях. Отмечать можно весь день и рабочие части витрины с несколькими
// мероприятиями.
// Вендор отмечает и снимает свои дни и части; закрытое сотрудником снять не может
// (триггеры availability_guard и availability_parts_guard → 403; правка нескольких дней сразу
// такие отметки пропускает). Прошедшие дни не меняются: календарь — обещание клиентам на
// будущее (так же решает база — никому, по дате Ташкента).
//
// Календарь ведут владелец кабинета и сотрудник площадки, а в панели — менеджер:
// правка идёт только от версии, которую человек видел (If-Match, calendar/version.ts),
// иначе 409 calendar_conflict — кабинет перечитает месяц и скажет, что его изменили.
// Сколько заказов одновременно — тоже часть календаря (app.listing_set_parallel_capacity),
// время работы целиком — только владелец (app.listing_set_day_sessions).
//
// Занятость активных листингов публична (каталог), поэтому RLS отдал бы
// вендору и чужой активный календарь. Здесь листинг проверяется явно: только
// свой, чужой — 404.

import type {
  BusyDay,
  BusyPart,
  BusySource,
  DayPart,
  DayPartRef,
  DaySessions,
  DaySessionsChange,
  PartBookings,
  VendorCalendar,
  VendorCalendarBatchResult,
  VendorCalendarChange,
  VendorCapacityChange,
} from "@bayramm/shared/api/vendor";
import { type AvailabilityMode, isDayPart } from "@bayramm/shared/categories";
import { sql } from "kysely";
import {
  assertMarkablePart,
  availabilityModeOf,
  calendarRequests,
  partBookings,
  saveDaySessions,
  sessionsOfRow,
} from "../calendar/sessions";
import { calendarVersion, lockCalendar } from "../calendar/version";
import { type Tx, type VendorActor, withActor } from "../db/actor";
import type { Db } from "../db/client";
import { ApiError, notFound } from "../errors";
import { assertVendorCan } from "./access";
import { addDays, isIsoDate, monthRange, tashkentToday } from "./dates";

/** Насколько вперёд можно отмечать дни: два года */
export const CALENDAR_HORIZON_DAYS = 730;
/** Сколько отметок одной правкой нескольких дней (как в панели) */
export const MAX_BATCH = 400;

const invalid = (field: string) => new ApiError(422, "invalid_input", "Invalid input", [field]);
const outOfRange = (fields?: string[]) =>
  new ApiError(422, "date_out_of_range", "Date is in the past or too far ahead", fields);

interface OwnListing {
  readonly id: string;
  readonly categoryCode: string;
  readonly mode: AvailabilityMode;
  readonly sessions: DaySessions;
  readonly dayParts: unknown;
}

async function assertOwnListing(trx: Tx, actor: VendorActor, listingId: string): Promise<OwnListing> {
  const listing = await trx
    .selectFrom("app.listings as l")
    .innerJoin("app.categories as c", "c.code", "l.category_code")
    .select([
      "l.id",
      "l.category_code",
      "l.parallel_capacity",
      "l.part_mode",
      "l.day_parts",
      "l.part_windows",
      "c.availability_mode",
    ])
    .where("l.id", "=", listingId)
    .where("l.vendor_id", "=", actor.vendorId)
    .executeTakeFirst();
  if (listing === undefined) throw notFound();
  return {
    id: listing.id,
    categoryCode: listing.category_code,
    mode: availabilityModeOf(listing.availability_mode),
    sessions: sessionsOfRow(listing),
    dayParts: listing.day_parts,
  };
}

export const toBusyDay = (row: { day: string; source: string; request_id: string | null }): BusyDay => ({
  day: row.day,
  source: row.source as BusySource,
  requestId: row.request_id,
});

const toBusyPart = (row: {
  day: string;
  part: DayPart;
  source: string;
  request_id: string | null;
}): BusyPart => ({
  day: row.day,
  part: row.part,
  source: row.source as BusySource,
  requestId: row.request_id,
});

/** Часть дня из адреса (?part=); нет — весь день */
export function parsePart(value: string | undefined): DayPart | null {
  if (value === undefined || value === "") return null;
  if (!isDayPart(value)) throw invalid("part");
  return value;
}

/** Отметки частей и договорённости по ним в [first, last] — для календарей кабинета и панели */
export async function partsCalendar(
  trx: Tx,
  listingId: string,
  first: string,
  last: string,
  sessions: Pick<DaySessions, "mode">,
): Promise<{ parts: BusyPart[]; bookings: PartBookings[] }> {
  const parts = await trx
    .selectFrom("app.availability_parts")
    .select(["day", "part", "source", "request_id"])
    .where("listing_id", "=", listingId)
    .where("day", ">=", first)
    .where("day", "<=", last)
    .orderBy("day")
    .orderBy("part")
    .execute();
  return {
    parts: parts.map(toBusyPart),
    bookings: await partBookings(trx, listingId, first, last, sessions.mode),
  };
}

/** GET /vendor/listings/:id/calendar?month=YYYY-MM (по умолчанию — текущий месяц по Ташкенту) */
export async function getCalendar(
  db: Db,
  actor: VendorActor,
  listingId: string,
  month: string | undefined,
  now: Date = new Date(),
): Promise<VendorCalendar> {
  const today = tashkentToday(now);
  const shown = month ?? today.slice(0, 7);
  const range = monthRange(shown);
  if (range === null) throw invalid("month");

  return withActor(db, actor, async (trx) => {
    const listing = await assertOwnListing(trx, actor, listingId);
    const busy = await trx
      .selectFrom("app.availability")
      .select(["day", "source", "request_id"])
      .where("listing_id", "=", listingId)
      .where("day", ">=", range.first)
      .where("day", "<=", range.last)
      .orderBy("day")
      .execute();
    // Заявки месяца — чтобы не отметить занятым день, о котором уже договорились, и открыть их из дня
    const requests =
      listing.mode === "parts" ? await calendarRequests(trx, listingId, range.first, range.last) : [];
    const parts =
      listing.mode === "parts"
        ? await partsCalendar(trx, listingId, range.first, range.last, listing.sessions)
        : { parts: [], bookings: [] };
    return {
      listingId,
      mode: listing.mode,
      parallelCapacity: listing.sessions.parallelCapacity,
      sessions: listing.sessions,
      parts: parts.parts,
      bookings: parts.bookings,
      month: shown,
      today,
      maxDay: addDays(today, CALENDAR_HORIZON_DAYS),
      busy: busy.map(toBusyDay),
      requestDays: [...new Set(requests.map((r) => r.day))],
      requests,
      version: await calendarVersion(trx, listingId),
    };
  });
}

/** День из адреса: настоящая дата от сегодня до горизонта */
export function parseDay(day: string, now: Date = new Date()): string {
  if (!isIsoDate(day)) throw invalid("day");
  const today = tashkentToday(now);
  if (day < today || day > addDays(today, CALENDAR_HORIZON_DAYS)) throw outOfRange();
  return day;
}

/** Отметить часть дня можно у витрины с календарём: рабочую часть, если мероприятий несколько */
function assertPart(listing: OwnListing, part: DayPart | null, field = "part"): void {
  if (part === null) return;
  if (listing.mode !== "parts") throw invalid(field);
  assertMarkablePart(listing.sessions, part, field);
}

/**
 * PUT /vendor/listings/:id/calendar/:day[?part=]: день (или часть дня) занят. Уже занятый —
 * остаётся как был
 */
export async function markBusy(
  db: Db,
  actor: VendorActor,
  listingId: string,
  day: string,
  version: number,
  part: DayPart | null = null,
): Promise<VendorCalendarChange> {
  return withActor(db, actor, async (trx) => {
    const listing = await assertOwnListing(trx, actor, listingId);
    assertPart(listing, part);
    await lockCalendar(trx, listingId, version);
    if (part === null) {
      await trx
        .insertInto("app.availability")
        .values({ listing_id: listingId, day, source: "vendor" })
        .onConflict((oc) => oc.columns(["listing_id", "day"]).doNothing())
        .execute();
      const row = await trx
        .selectFrom("app.availability")
        .select(["day", "source", "request_id"])
        .where("listing_id", "=", listingId)
        .where("day", "=", day)
        .executeTakeFirstOrThrow();
      return { day, part, busy: toBusyDay(row), version: await calendarVersion(trx, listingId) };
    }
    await trx
      .insertInto("app.availability_parts")
      .values({ listing_id: listingId, day, part, source: "vendor" })
      .onConflict((oc) => oc.columns(["listing_id", "day", "part"]).doNothing())
      .execute();
    const row = await trx
      .selectFrom("app.availability_parts")
      .select(["day", "part", "source", "request_id"])
      .where("listing_id", "=", listingId)
      .where("day", "=", day)
      .where("part", "=", part)
      .executeTakeFirstOrThrow();
    return { day, part, busy: toBusyPart(row), version: await calendarVersion(trx, listingId) };
  });
}

/** DELETE /vendor/listings/:id/calendar/:day[?part=]: свободен. Свободный — остаётся свободным */
export async function markFree(
  db: Db,
  actor: VendorActor,
  listingId: string,
  day: string,
  version: number,
  part: DayPart | null = null,
): Promise<VendorCalendarChange> {
  return withActor(db, actor, async (trx) => {
    const listing = await assertOwnListing(trx, actor, listingId);
    // Снять отметку части можно всегда — и у части, в которой витрина больше не работает
    if (part !== null && listing.mode !== "parts") throw invalid("part");
    await lockCalendar(trx, listingId, version);
    if (part === null) {
      await trx
        .deleteFrom("app.availability")
        .where("listing_id", "=", listingId)
        .where("day", "=", day)
        .execute();
    } else {
      await trx
        .deleteFrom("app.availability_parts")
        .where("listing_id", "=", listingId)
        .where("day", "=", day)
        .where("part", "=", part)
        .execute();
    }
    return { day, part, busy: null, version: await calendarVersion(trx, listingId) };
  });
}

// ── несколько дней сразу ────────────────────────────────────────────────────

export interface CalendarBatch {
  readonly busy: readonly string[];
  readonly free: readonly string[];
  readonly busyParts: readonly DayPartRef[];
  readonly freeParts: readonly DayPartRef[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isDay = (value: unknown): value is string => typeof value === "string" && isIsoDate(value);

function dayList(value: unknown, key: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_BATCH || !value.every(isDay)) throw invalid(key);
  return [...new Set(value)];
}

function partList(value: unknown, key: string): DayPartRef[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_BATCH) throw invalid(key);
  const seen = new Set<string>();
  const out: DayPartRef[] = [];
  for (const item of value) {
    const { day, part } = isObject(item) ? item : {};
    if (!isDay(day) || !isDayPart(part)) throw invalid(key);
    const k = `${day}/${part}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push({ day, part });
    }
  }
  return out;
}

/**
 * Тело PUT /vendor/listings/:id/calendar: дни и части — настоящие даты от сегодня до горизонта,
 * одно и то же — не «закрыть» и «открыть» сразу, всего не больше MAX_BATCH отметок
 */
export function parseBatch(body: unknown, now: Date = new Date()): CalendarBatch {
  if (!isObject(body)) throw invalid("busy");
  const batch = {
    busy: dayList(body.busy, "busy"),
    free: dayList(body.free, "free"),
    busyParts: partList(body.busyParts, "busyParts"),
    freeParts: partList(body.freeParts, "freeParts"),
  };
  const total = batch.busy.length + batch.free.length + batch.busyParts.length + batch.freeParts.length;
  if (total === 0 || total > MAX_BATCH) throw invalid("busy");
  if (batch.busy.some((day) => batch.free.includes(day))) throw invalid("free");
  if (batch.busyParts.some((b) => batch.freeParts.some((f) => f.day === b.day && f.part === b.part)))
    throw invalid("freeParts");
  const today = tashkentToday(now);
  const last = addDays(today, CALENDAR_HORIZON_DAYS);
  const outside = (day: string) => day < today || day > last;
  const bad = [
    ...(batch.busy.some(outside) ? ["busy"] : []),
    ...(batch.free.some(outside) ? ["free"] : []),
    ...(batch.busyParts.some((p) => outside(p.day)) ? ["busyParts"] : []),
    ...(batch.freeParts.some((p) => outside(p.day)) ? ["freeParts"] : []),
  ];
  if (bad.length > 0) throw outOfRange(bad);
  return batch;
}

/**
 * PUT /vendor/listings/:id/calendar: несколько дней одной правкой — закрыть или открыть весь
 * день или часть (например, все вечера суббот месяца). Отметки менеджера «открыть» не снимает —
 * они в skipped. Ответ — отметки и договорённости на отрезке правки и новая версия
 */
export async function applyBatch(
  db: Db,
  actor: VendorActor,
  listingId: string,
  batch: CalendarBatch,
  version: number,
): Promise<VendorCalendarBatchResult> {
  return withActor(db, actor, async (trx) => {
    const listing = await assertOwnListing(trx, actor, listingId);
    if (listing.mode !== "parts") throw invalid("busy");
    for (const ref of batch.busyParts) assertPart(listing, ref.part, "busyParts");
    await lockCalendar(trx, listingId, version);

    let skipped = 0;
    if (batch.busy.length > 0) {
      await trx
        .insertInto("app.availability")
        .values(batch.busy.map((day) => ({ listing_id: listingId, day, source: "vendor" })))
        .onConflict((oc) => oc.columns(["listing_id", "day"]).doNothing())
        .execute();
    }
    if (batch.free.length > 0) {
      await trx
        .deleteFrom("app.availability")
        .where("listing_id", "=", listingId)
        .where("day", "in", batch.free)
        .where("source", "<>", "staff")
        .execute();
      const marked = await trx
        .selectFrom("app.availability")
        .select(sql<number>`count(*)::int`.as("n"))
        .where("listing_id", "=", listingId)
        .where("day", "in", batch.free)
        .executeTakeFirstOrThrow();
      skipped += marked.n;
    }
    if (batch.busyParts.length > 0) {
      await trx
        .insertInto("app.availability_parts")
        .values(
          batch.busyParts.map((p) => ({ listing_id: listingId, day: p.day, part: p.part, source: "vendor" })),
        )
        .onConflict((oc) => oc.columns(["listing_id", "day", "part"]).doNothing())
        .execute();
    }
    if (batch.freeParts.length > 0) {
      const keys = batch.freeParts.map((p) => `${p.day}/${p.part}`);
      await sql`
        delete from app.availability_parts a
        where a.listing_id = ${listingId}::uuid and a.source <> 'staff'
          and (a.day::text || '/' || a.part::text) = any (${keys}::text[])
      `.execute(trx);
      const { rows } = await sql<{ n: number }>`
        select count(*)::int as n from app.availability_parts a
        where a.listing_id = ${listingId}::uuid
          and (a.day::text || '/' || a.part::text) = any (${keys}::text[])
      `.execute(trx);
      skipped += rows[0]?.n ?? 0;
    }

    const days = [
      ...batch.busy,
      ...batch.free,
      ...batch.busyParts.map((p) => p.day),
      ...batch.freeParts.map((p) => p.day),
    ].sort();
    const from = days[0] ?? tashkentToday();
    const to = days.at(-1) ?? from;
    const busy = await trx
      .selectFrom("app.availability")
      .select(["day", "source", "request_id"])
      .where("listing_id", "=", listingId)
      .where("day", ">=", from)
      .where("day", "<=", to)
      .orderBy("day")
      .execute();
    const parts = await partsCalendar(trx, listingId, from, to, listing.sessions);
    return {
      from,
      to,
      busy: busy.map(toBusyDay),
      parts: parts.parts,
      bookings: parts.bookings,
      skipped,
      version: await calendarVersion(trx, listingId),
    };
  });
}

// ── заказов одновременно и время работы ─────────────────────────────────────

/** Сколько заказов витрина берёт одновременно: тело { parallelCapacity } (1–50) */
export function parseCapacity(body: unknown): number {
  const value =
    typeof body === "object" && body !== null
      ? (body as { parallelCapacity?: unknown }).parallelCapacity
      : undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 50) {
    throw invalid("parallelCapacity");
  }
  return value;
}

/** PUT /vendor/listings/:id/calendar/capacity: от версии календаря; версия растёт */
export async function setCapacity(
  db: Db,
  actor: VendorActor,
  listingId: string,
  capacity: number,
  version: number,
): Promise<VendorCapacityChange> {
  return withActor(db, actor, async (trx) => {
    await assertOwnListing(trx, actor, listingId);
    const { rows } = await sql<{ version: number }>`
      select app.listing_set_parallel_capacity(${listingId}::uuid, ${capacity}::int, ${version}::int) as version
    `.execute(trx);
    return { parallelCapacity: capacity, version: rows[0]?.version ?? version };
  });
}

/**
 * PUT /vendor/listings/:id/day-sessions: время работы витрины — только владелец кабинета, от
 * версии календаря; часть с будущими заявками — 409 part_in_use
 */
export async function setDaySessions(
  db: Db,
  actor: VendorActor,
  listingId: string,
  body: unknown,
  version: number,
  now: Date = new Date(),
): Promise<DaySessionsChange> {
  assertVendorCan(actor, "sessions.write");
  return withActor(db, actor, async (trx) => {
    const listing = await assertOwnListing(trx, actor, listingId);
    if (listing.mode !== "parts") throw notFound();
    return saveDaySessions(
      trx,
      { id: listing.id, category_code: listing.categoryCode, day_parts: listing.dayParts },
      body,
      version,
      tashkentToday(now),
    );
  });
}
