// Занятые дни карточки: сотрудник помогает вендору заполнить календарь при
// подключении. Строка app.availability — день занят; нет строки — свободен.
//
//   GET /staff/listings/:id/availability?from=YYYY-MM-DD&to=YYYY-MM-DD
//   PUT /staff/listings/:id/availability  { busy: [дни], free: [дни] }
//
// Отметка сотрудника — source = staff. Снять можно любую отметку, в том числе
// вендора: сотрудник правит календарь по его просьбе.

import type { Availability, BusyDay } from "@bayramm/shared/api/staff";
import { Hono } from "hono";
import { staffOf } from "../auth/session";
import { type Tx, withActor } from "../db/actor";
import type { AppEnv } from "../env";
import { notFound } from "../errors";
import { requirePermission } from "./access";
import { invalidInput, limitJson, readBody } from "./input";
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

async function busyDays(trx: Tx, listingId: string, from: string, to: string): Promise<BusyDay[]> {
  const rows = await trx
    .selectFrom("app.availability")
    .select(["day", "source"])
    .where("listing_id", "=", listingId)
    .where("day", ">=", from)
    .where("day", "<=", to)
    .orderBy("day")
    .execute();
  return rows.map((row) => ({
    day: row.day,
    source: row.source === "vendor" || row.source === "request_decline" ? row.source : "staff",
  }));
}

async function listingExists(trx: Tx, id: string): Promise<void> {
  const found = await trx.selectFrom("app.listings").select("id").where("id", "=", id).executeTakeFirst();
  if (!found) throw notFound();
}

availability.get("/:id/availability", requirePermission("catalog.read"), async (c) => {
  const id = pathId(c.req.param("id"));
  const from = c.req.query("from") ?? tashkentToday();
  const to = c.req.query("to") ?? addDays(from, 365);
  if (!isDay(from) || !isDay(to)) throw invalidInput(["from", "to"]);
  const span = (Date.parse(to) - Date.parse(from)) / DAY_MS;
  if (span < 0 || span > MAX_RANGE_DAYS) throw invalidInput(["to"]);

  const busy = await withActor(c.var.db, staffOf(c), async (trx) => {
    await listingExists(trx, id);
    return busyDays(trx, id, from, to);
  });
  const body: Availability = { from, to, busy };
  return c.json(body);
});

function dayList(value: unknown, key: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_CHANGES || !value.every(isDay)) throw invalidInput([key]);
  return [...new Set(value)];
}

availability.put("/:id/availability", requirePermission("listings.write"), limitJson, async (c) => {
  const id = pathId(c.req.param("id"));
  const body = await readBody(c.req.raw);
  const busy = dayList(body.busy, "busy");
  const free = dayList(body.free, "free");
  if (busy.some((day) => free.includes(day))) throw invalidInput(["busy", "free"]);
  const all = [...busy, ...free].sort();

  const result = await withActor(c.var.db, staffOf(c), async (trx) => {
    await listingExists(trx, id);
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
    const from = all[0] ?? tashkentToday();
    const to = all.at(-1) ?? from;
    return { from, to, busy: await busyDays(trx, id, from, to) };
  });
  const response: Availability = result;
  return c.json(response);
});
