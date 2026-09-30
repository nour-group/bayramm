// Календарь занятости листинга в кабинете вендора.
//
// Строка app.availability = день занят. Вендор отмечает и снимает свои дни;
// день, закрытый сотрудником, снять не может (триггер availability_guard → 403).
// Прошедшие дни не меняются: календарь — обещание клиентам на будущее (так же
// решает база — никому, по дате Ташкента).
//
// Календарь ведут владелец кабинета и сотрудник площадки, а в панели — менеджер:
// правка идёт только от версии, которую человек видел (If-Match, calendar/version.ts),
// иначе 409 calendar_conflict — кабинет перечитает месяц и скажет, что его изменили.
//
// Занятость активных листингов публична (каталог), поэтому RLS отдал бы
// вендору и чужой активный календарь. Здесь листинг проверяется явно: только
// свой, чужой — 404.

import type { BusyDay, BusySource, VendorCalendar, VendorCalendarChange } from "@bayramm/shared/api/vendor";
import { calendarVersion, lockCalendar } from "../calendar/version";
import { type Tx, type VendorActor, withActor } from "../db/actor";
import type { Db } from "../db/client";
import { ApiError, notFound } from "../errors";
import { addDays, isIsoDate, monthRange, tashkentToday } from "./dates";

/** Насколько вперёд можно отмечать дни: два года */
export const CALENDAR_HORIZON_DAYS = 730;

const invalid = (field: string) => new ApiError(422, "invalid_input", "Invalid input", [field]);
const outOfRange = () => new ApiError(422, "date_out_of_range", "Date is in the past or too far ahead");

async function assertOwnListing(trx: Tx, actor: VendorActor, listingId: string): Promise<void> {
  const listing = await trx
    .selectFrom("app.listings")
    .select("id")
    .where("id", "=", listingId)
    .where("vendor_id", "=", actor.vendorId)
    .executeTakeFirst();
  if (listing === undefined) throw notFound();
}

const toBusyDay = (row: { day: string; source: string; request_id: string | null }): BusyDay => ({
  day: row.day,
  source: row.source as BusySource,
  requestId: row.request_id,
});

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
    await assertOwnListing(trx, actor, listingId);
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
    return {
      listingId,
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

/** PUT /vendor/listings/:id/calendar/:day: день занят. Уже занятый — остаётся как был */
export async function markBusy(
  db: Db,
  actor: VendorActor,
  listingId: string,
  day: string,
  version: number,
): Promise<VendorCalendarChange> {
  return withActor(db, actor, async (trx) => {
    await assertOwnListing(trx, actor, listingId);
    await lockCalendar(trx, listingId, version);
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
    return { day, busy: toBusyDay(row), version: await calendarVersion(trx, listingId) };
  });
}

/** DELETE /vendor/listings/:id/calendar/:day: день свободен. Свободный — остаётся свободным */
export async function markFree(
  db: Db,
  actor: VendorActor,
  listingId: string,
  day: string,
  version: number,
): Promise<VendorCalendarChange> {
  return withActor(db, actor, async (trx) => {
    await assertOwnListing(trx, actor, listingId);
    await lockCalendar(trx, listingId, version);
    await trx
      .deleteFrom("app.availability")
      .where("listing_id", "=", listingId)
      .where("day", "=", day)
      .execute();
    return { day, busy: null, version: await calendarVersion(trx, listingId) };
  });
}
