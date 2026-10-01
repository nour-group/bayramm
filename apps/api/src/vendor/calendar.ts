// Календарь занятости листинга в кабинете вендора.
//
// Строка app.availability = день занят целиком. У витрин с режимом parts (фото и видео,
// кортеж, декор) день делится на утро, день и вечер: строка app.availability_parts —
// часть дня занята; часть занята и тогда, когда договорённостей (заявки deal) на неё
// столько же, сколько заказов витрина берёт одновременно (parallel_capacity).
// Вендор отмечает и снимает свои дни и части; закрытое сотрудником снять не может
// (триггеры availability_guard и availability_parts_guard → 403). Прошедшие дни не
// меняются: календарь — обещание клиентам на будущее (так же решает база — никому,
// по дате Ташкента).
//
// Календарь ведут владелец кабинета и сотрудник площадки, а в панели — менеджер:
// правка идёт только от версии, которую человек видел (If-Match, calendar/version.ts),
// иначе 409 calendar_conflict — кабинет перечитает месяц и скажет, что его изменили.
// Сколько заказов одновременно — тоже часть календаря (app.listing_set_parallel_capacity).
//
// Занятость активных листингов публична (каталог), поэтому RLS отдал бы
// вендору и чужой активный календарь. Здесь листинг проверяется явно: только
// свой, чужой — 404.

import type {
  AvailabilityMode,
  BusyDay,
  BusyPart,
  BusySource,
  DayPart,
  PartBookings,
  VendorCalendar,
  VendorCalendarChange,
  VendorCapacityChange,
} from "@bayramm/shared/api/vendor";
import { DAY_PARTS } from "@bayramm/shared/categories";
import { sql } from "kysely";
import { calendarVersion, lockCalendar } from "../calendar/version";
import { type Tx, type VendorActor, withActor } from "../db/actor";
import type { Db } from "../db/client";
import { ApiError, notFound } from "../errors";
import { addDays, isIsoDate, monthRange, tashkentToday } from "./dates";

/** Насколько вперёд можно отмечать дни: два года */
export const CALENDAR_HORIZON_DAYS = 730;

const invalid = (field: string) => new ApiError(422, "invalid_input", "Invalid input", [field]);
const outOfRange = () => new ApiError(422, "date_out_of_range", "Date is in the past or too far ahead");

interface OwnListing {
  readonly mode: AvailabilityMode;
  readonly parallelCapacity: number;
}

async function assertOwnListing(trx: Tx, actor: VendorActor, listingId: string): Promise<OwnListing> {
  const listing = await trx
    .selectFrom("app.listings as l")
    .innerJoin("app.categories as c", "c.code", "l.category_code")
    .select(["l.id", "l.parallel_capacity", "c.availability_mode"])
    .where("l.id", "=", listingId)
    .where("l.vendor_id", "=", actor.vendorId)
    .executeTakeFirst();
  if (listing === undefined) throw notFound();
  return { mode: listing.availability_mode, parallelCapacity: listing.parallel_capacity };
}

const toBusyDay = (row: { day: string; source: string; request_id: string | null }): BusyDay => ({
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

/** Часть дня из адреса (?part=): только у режима parts; нет — весь день */
export function parsePart(value: string | undefined): DayPart | null {
  if (value === undefined || value === "") return null;
  if (!(DAY_PARTS as readonly string[]).includes(value)) throw invalid("part");
  return value as DayPart;
}

/** Части дня и договорённости по ним в [first, last] — для календарей кабинета и панели */
export async function partsCalendar(
  trx: Tx,
  listingId: string,
  first: string,
  last: string,
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
  const bookings = await trx
    .selectFrom("app.requests")
    .select(["event_date", "day_part", sql<number>`count(*)::int`.as("count")])
    .where("listing_id", "=", listingId)
    .where("status", "=", "deal")
    .where("day_part", "is not", null)
    .where("event_date", ">=", first)
    .where("event_date", "<=", last)
    .groupBy(["event_date", "day_part"])
    .orderBy("event_date")
    .orderBy("day_part")
    .execute();
  return {
    parts: parts.map(toBusyPart),
    bookings: bookings.map((b) => ({ day: b.event_date, part: b.day_part as DayPart, count: b.count })),
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
    // Дни открытых заявок и сделок — чтобы не отметить занятым день, о котором уже договорились
    const requestDays = await trx
      .selectFrom("app.requests")
      .select("event_date")
      .distinct()
      .where("listing_id", "=", listingId)
      .where("vendor_id", "=", actor.vendorId)
      .where("status", "in", ["new", "viewed", "contacted", "deal"])
      .where("event_date", ">=", range.first)
      .where("event_date", "<=", range.last)
      .orderBy("event_date")
      .execute();
    const parts =
      listing.mode === "parts"
        ? await partsCalendar(trx, listingId, range.first, range.last)
        : { parts: [], bookings: [] };
    return {
      listingId,
      mode: listing.mode,
      parallelCapacity: listing.parallelCapacity,
      parts: parts.parts,
      bookings: parts.bookings,
      month: shown,
      today,
      maxDay: addDays(today, CALENDAR_HORIZON_DAYS),
      busy: busy.map(toBusyDay),
      requestDays: requestDays.map((row) => row.event_date),
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
    if (part !== null && listing.mode !== "parts") throw invalid("part");
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
