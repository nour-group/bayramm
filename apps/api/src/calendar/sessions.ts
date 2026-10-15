// «Время работы» витрины и занятость по частям дня — общее для кабинета, панели, каталога и
// заявок (правила — packages/shared/src/categories/availability.ts и миграция
// 20261015100000_day_sessions.sql).
//
//   · время работы — столбцы витрины part_mode, day_parts, part_windows, parallel_capacity;
//     окна — свои поверх окон категории (daySessionsOf);
//   · договорённости по частям — заявки deal: заявка на весь день и любая заявка витрины с
//     одним мероприятием в день — в каждой части (так же считает база);
//   · правка — PUT …/day-sessions: проверка по конфигурации категории (validateDaySessions),
//     свои окна — только у рабочих частей, часть с будущими заявками не убирается (409
//     part_in_use { inUse }), затем app.listing_set_day_sessions — от версии календаря.
//
// pg отдаёт массивы перечислений (app.day_part[]) строкой «{morning,evening}» — их разбирает
// dayPartsOf.

import type {
  CalendarRequest,
  DaySessionsChange,
  PartBookings,
  PartInUse,
  RequestStatus,
} from "@bayramm/shared/api/vendor";
import {
  type AvailabilityMode,
  categoryConfig,
  DAY_PARTS,
  type DayPart,
  type DayPartWindow,
  type DayPartWindows,
  type DaySessions,
  DEFAULT_DAY_PARTS,
  daySessionsOf,
  defaultDaySessions,
  isDayPart,
  type PartMode,
  sortParts,
  validateDaySessions,
} from "@bayramm/shared/categories";
import { sql } from "kysely";
import type { Tx } from "../db/actor";
import { ApiError, notFound } from "../errors";

/** Части дня из ответа базы: массив или запись массива «{morning,evening}» */
export function dayPartsOf(value: unknown): DayPart[] {
  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value
          .replace(/^\{|\}$/g, "")
          .split(",")
          .map((item) => item.trim().replace(/^"|"$/g, ""))
      : [];
  return sortParts(items.filter(isDayPart));
}

const TIME_RE = /^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$/;

/** Свои окна витрины из базы (jsonb): только известные части с «ЧЧ:ММ» */
export function customWindowsOf(value: unknown): Partial<DayPartWindows> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out: Partial<Record<DayPart, DayPartWindow>> = {};
  for (const part of DAY_PARTS) {
    const raw = (value as Record<string, unknown>)[part];
    if (typeof raw !== "object" || raw === null) continue;
    const { from, to } = raw as Record<string, unknown>;
    if (typeof from === "string" && typeof to === "string" && TIME_RE.test(from) && TIME_RE.test(to))
      out[part] = { from, to };
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Столбцы витрины со временем работы */
export interface SessionsRow {
  readonly category_code: string;
  readonly part_mode: PartMode;
  readonly day_parts: unknown;
  readonly part_windows: unknown;
  readonly parallel_capacity: number;
}

/** Время работы витрины из её строки */
export function sessionsOfRow(row: SessionsRow): DaySessions {
  const category = categoryConfig(row.category_code);
  const parts = dayPartsOf(row.day_parts);
  if (category === undefined) {
    return {
      mode: row.part_mode,
      parts: parts.length > 0 ? parts : [...DAY_PARTS],
      windows: DEFAULT_DAY_PARTS,
      custom: null,
      parallelCapacity: row.parallel_capacity,
    };
  }
  return daySessionsOf(category, {
    mode: row.part_mode,
    parts: parts.length > 0 ? parts : defaultDaySessions(category).parts,
    custom: customWindowsOf(row.part_windows),
    parallelCapacity: row.parallel_capacity,
  });
}

/** Модель занятости категории для ответа: календарь по частям дня или срок заказа */
export const availabilityModeOf = (mode: string): AvailabilityMode => (mode === "lead" ? "lead" : "parts");

/**
 * Договорённости (deal) по частям дня в [first, last]: заявка на весь день и любая заявка витрины
 * с одним мероприятием в день — в каждой части
 */
export async function partBookings(
  trx: Tx,
  listingId: string,
  first: string,
  last: string,
  mode: PartMode,
): Promise<PartBookings[]> {
  const { rows } = await sql<{ day: string; part: DayPart; count: number }>`
    select r.event_date::text as day, p.part::text as part, count(*)::int as count
    from app.requests r
    cross join lateral unnest(
      case when ${mode === "whole"} or cardinality(r.day_parts) = 0
           then enum_range(null::app.day_part) else r.day_parts end) as p(part)
    where r.listing_id = ${listingId}::uuid and r.status = 'deal'
      and r.event_date >= ${first}::date and r.event_date <= ${last}::date
    group by r.event_date, p.part
    order by r.event_date, p.part
  `.execute(trx);
  return rows.map((row) => ({ day: row.day, part: row.part, count: row.count }));
}

/** Открытые заявки и договорённости на дни [first, last] — ссылки из дня на заявку (без данных клиента) */
export async function calendarRequests(
  trx: Tx,
  listingId: string,
  first: string,
  last: string,
): Promise<CalendarRequest[]> {
  const rows = await trx
    .selectFrom("app.requests")
    .select(["id", "public_no", "event_date", "day_parts", "status"])
    .where("listing_id", "=", listingId)
    .where("status", "in", ["new", "viewed", "contacted", "deal"])
    .where("event_date", ">=", first)
    .where("event_date", "<=", last)
    .orderBy("event_date")
    .orderBy("public_no")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    publicNo: Number(row.public_no),
    day: row.event_date,
    parts: dayPartsOf(row.day_parts),
    status: row.status as RequestStatus,
  }));
}

/** Часть дня правки календаря: только рабочая часть витрины с несколькими мероприятиями */
export function assertMarkablePart(sessions: DaySessions, part: DayPart | null, field: string): void {
  if (part === null) return;
  if (sessions.mode === "whole" || !sessions.parts.includes(part)) {
    throw new ApiError(422, "invalid_input", "Invalid input", [field]);
  }
}

export interface SessionsListing {
  readonly id: string;
  readonly category_code: string;
  readonly day_parts: unknown;
}

/**
 * Правка времени работы: проверка по категории, часть с будущими заявками — 409 part_in_use с
 * числом заявок по частям, затем app.listing_set_day_sessions от версии календаря
 */
export async function saveDaySessions(
  trx: Tx,
  listing: SessionsListing,
  body: unknown,
  version: number,
  today: string,
): Promise<DaySessionsChange> {
  const category = categoryConfig(listing.category_code);
  if (category === undefined || category.availability === "lead") throw notFound();
  const parsed = validateDaySessions(category, body);
  if (!parsed.ok) throw new ApiError(422, "invalid_input", "Invalid input", parsed.errors);
  const value = parsed.value;
  // Свои окна — только у рабочих частей: окно нерабочей части ни на что не влияет
  const custom = value.custom
    ? Object.fromEntries(
        Object.entries(value.custom).filter(([part]) => value.parts.includes(part as DayPart)),
      )
    : null;
  const windows = custom && Object.keys(custom).length > 0 ? custom : null;

  if (value.mode === "parts") {
    const removed = dayPartsOf(listing.day_parts).filter((part) => !value.parts.includes(part));
    if (removed.length > 0) {
      const { rows } = await sql<{ part: DayPart; count: number }>`
        select p.part::text as part, count(*)::int as count
        from app.requests r cross join lateral unnest(r.day_parts) as p(part)
        where r.listing_id = ${listing.id}::uuid and r.event_date >= ${today}::date
          and r.status in ('new', 'viewed', 'contacted', 'deal')
          and p.part::text = any (${removed}::text[])
        group by p.part order by p.part
      `.execute(trx);
      if (rows.length > 0) {
        const inUse: PartInUse[] = rows.map((row) => ({ part: row.part, count: row.count }));
        throw new ApiError(
          409,
          "part_in_use",
          "This part of the day has upcoming requests",
          inUse.map((p) => p.part),
          { inUse },
        );
      }
    }
  }

  const { rows } = await sql<{ version: number }>`
    select app.listing_set_day_sessions(${listing.id}::uuid, ${value.mode}::app.part_mode,
      ${value.parts}::text[]::app.day_part[], ${windows === null ? null : JSON.stringify(windows)}::jsonb,
      ${value.parallelCapacity}::int, ${version}::int) as version
  `.execute(trx);
  const sessions = daySessionsOf(category, {
    mode: value.mode,
    parts: value.parts,
    custom: windows,
    parallelCapacity: value.parallelCapacity,
  });
  return { sessions, version: rows[0]?.version ?? version };
}
