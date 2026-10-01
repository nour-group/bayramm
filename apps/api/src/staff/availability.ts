// Занятые дни карточки: сотрудник помогает вендору заполнить календарь при
// подключении. Строка app.availability — день занят; нет строки — свободен. У витрин с
// режимом parts — ещё части дня (app.availability_parts) и договорённости по ним.
//
//   GET /staff/listings/:id/availability?from=YYYY-MM-DD&to=YYYY-MM-DD
//   PUT /staff/listings/:id/availability  { version, busy: [дни], free: [дни],
//                                           busyParts: [{ day, part }], freeParts: [...] }
//
// Отметка сотрудника — source = staff. Снять можно любую отметку, в том числе
// вендора: сотрудник правит календарь по его просьбе. Прошедшие дни (по Ташкенту)
// не меняются — ни здесь, ни в базе (availability_guard): 422 date_out_of_range.
// Календарь ведут и партнёр, и сотрудник: правка — только от версии, которую видел
// сотрудник (calendar/version.ts), иначе 409 calendar_conflict — перечитать.

import type { Availability, BusyDay, DayPartRef } from "@bayramm/shared/api/staff";
import { DAY_PARTS, type DayPart } from "@bayramm/shared/categories";
import { Hono } from "hono";
import { staffOf } from "../auth/session";
import { calendarVersion, lockCalendar, MAX_VERSION } from "../calendar/version";
import { type Tx, withActor } from "../db/actor";
import type { AppEnv } from "../env";
import { ApiError, notFound } from "../errors";
import { partsCalendar } from "../vendor/calendar";
import { requirePermission } from "./access";
import { Input, invalidInput, limitJson, readBody } from "./input";
import { pathId } from "./shared";

export const availability = new Hono<AppEnv>();

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 400;
const MAX_CHANGES = 400;
const DAY_MS = 86_400_000;

/** Настоящая дата в виде YYYY-MM-DD (2026-02-30 — нет) */
export function isDay(value: unknown): value is string {
  if (typeof value !== "string" || !DAY_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** «Сегодня» по Ташкенту (UTC+5 круглый год) */
export function tashkentToday(now = new Date()): string {
  return new Date(now.getTime() + 5 * 3600_000).toISOString().slice(0, 10);
}

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

const sourceOf = (source: string): BusyDay["source"] =>
  source === "vendor" || source === "request_decline" ? source : "staff";

async function readAvailability(
  trx: Tx,
  listing: ListingCalendar,
  from: string,
  to: string,
): Promise<Availability> {
  const rows = await trx
    .selectFrom("app.availability")
    .select(["day", "source"])
    .where("listing_id", "=", listing.id)
    .where("day", ">=", from)
    .where("day", "<=", to)
    .orderBy("day")
    .execute();
  const parts =
    listing.mode === "parts" ? await partsCalendar(trx, listing.id, from, to) : { parts: [], bookings: [] };
  return {
    from,
    to,
    mode: listing.mode,
    parallelCapacity: listing.parallelCapacity,
    busy: rows.map((row) => ({ day: row.day, source: sourceOf(row.source) })),
    parts: parts.parts.map((p) => ({ day: p.day, part: p.part, source: sourceOf(p.source) })),
    bookings: parts.bookings,
    version: await calendarVersion(trx, listing.id),
  };
}

interface ListingCalendar {
  readonly id: string;
  readonly mode: Availability["mode"];
  readonly parallelCapacity: number;
}

async function listingCalendar(trx: Tx, id: string): Promise<ListingCalendar> {
  const found = await trx
    .selectFrom("app.listings as l")
    .innerJoin("app.categories as c", "c.code", "l.category_code")
    .select(["l.id", "l.parallel_capacity", "c.availability_mode"])
    .where("l.id", "=", id)
    .executeTakeFirst();
  if (!found) throw notFound();
  return { id: found.id, mode: found.availability_mode, parallelCapacity: found.parallel_capacity };
}

availability.get("/:id/availability", requirePermission("catalog.read"), async (c) => {
  const id = pathId(c.req.param("id"));
  const from = c.req.query("from") ?? tashkentToday();
  const to = c.req.query("to") ?? addDays(from, 365);
  if (!isDay(from) || !isDay(to)) throw invalidInput(["from", "to"]);
  const span = (Date.parse(to) - Date.parse(from)) / DAY_MS;
  if (span < 0 || span > MAX_RANGE_DAYS) throw invalidInput(["to"]);

  const body: Availability = await withActor(c.var.db, staffOf(c), async (trx) =>
    readAvailability(trx, await listingCalendar(trx, id), from, to),
  );
  return c.json(body);
});

function dayList(value: unknown, key: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_CHANGES || !value.every(isDay)) throw invalidInput([key]);
  return [...new Set(value)];
}

function partList(value: unknown, key: string): DayPartRef[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_CHANGES) throw invalidInput([key]);
  const refs = value.map((item) => {
    const { day, part } = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    if (!isDay(day) || !(DAY_PARTS as readonly unknown[]).includes(part)) throw invalidInput([key]);
    return { day, part: part as DayPart };
  });
  const seen = new Set<string>();
  return refs.filter((r) => {
    const k = `${r.day}/${r.part}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

availability.put("/:id/availability", requirePermission("listings.write"), limitJson, async (c) => {
  const id = pathId(c.req.param("id"));
  const body = await readBody(c.req.raw);
  const version = new Input(body).int("version", { min: 0, max: MAX_VERSION, required: true });
  if (typeof version !== "number") throw invalidInput(["version"]);
  const busy = dayList(body.busy, "busy");
  const free = dayList(body.free, "free");
  const busyParts = partList(body.busyParts, "busyParts");
  const freeParts = partList(body.freeParts, "freeParts");
  if (busy.some((day) => free.includes(day))) throw invalidInput(["busy", "free"]);
  if (busyParts.some((b) => freeParts.some((f) => f.day === b.day && f.part === b.part))) {
    throw invalidInput(["busyParts", "freeParts"]);
  }
  // Прошлое не правится: база ответила бы так же, но без указания поля
  const today = tashkentToday();
  const past = [
    ...(busy.some((day) => day < today) ? ["busy"] : []),
    ...(free.some((day) => day < today) ? ["free"] : []),
    ...(busyParts.some((p) => p.day < today) ? ["busyParts"] : []),
    ...(freeParts.some((p) => p.day < today) ? ["freeParts"] : []),
  ];
  if (past.length > 0) throw new ApiError(422, "date_out_of_range", "Date is in the past", past);
  const all = [...busy, ...free, ...busyParts.map((p) => p.day), ...freeParts.map((p) => p.day)].sort();

  const result = await withActor(c.var.db, staffOf(c), async (trx) => {
    const listing = await listingCalendar(trx, id);
    if ((busyParts.length > 0 || freeParts.length > 0) && listing.mode !== "parts") {
      throw invalidInput(busyParts.length > 0 ? ["busyParts"] : ["freeParts"]);
    }
    await lockCalendar(trx, id, version);
    if (busy.length > 0) {
      await trx
        .insertInto("app.availability")
        .values(busy.map((day) => ({ listing_id: id, day, source: "staff" })))
        .onConflict((oc) => oc.columns(["listing_id", "day"]).doNothing())
        .execute();
    }
    if (free.length > 0) {
      await trx
        .deleteFrom("app.availability")
        .where("listing_id", "=", id)
        .where("day", "in", free)
        .execute();
    }
    if (busyParts.length > 0) {
      await trx
        .insertInto("app.availability_parts")
        .values(busyParts.map((p) => ({ listing_id: id, day: p.day, part: p.part, source: "staff" })))
        .onConflict((oc) => oc.columns(["listing_id", "day", "part"]).doNothing())
        .execute();
    }
    for (const p of freeParts) {
      await trx
        .deleteFrom("app.availability_parts")
        .where("listing_id", "=", id)
        .where("day", "=", p.day)
        .where("part", "=", p.part)
        .execute();
    }
    const from = all[0] ?? today;
    const to = all.at(-1) ?? from;
    return readAvailability(trx, listing, from, to);
  });
  const response: Availability = result;
  return c.json(response);
});
