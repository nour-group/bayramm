// Версия календаря занятости листинга — оптимистичная блокировка правок.
//
// База ведёт app.availability_versions: версия растёт на каждой правке
// app.availability, кто бы её ни сделал (партнёр, сотрудник, отказ «занято»); строки
// нет — версия 0. Правка из кабинета и панели передаёт версию, которую видел человек:
// app.availability_lock сверяет её и держит строку версии до конца транзакции, так
// что две одновременные правки одного календаря не проходят обе от одной версии.
// Устарела — 409 calendar_conflict (BR025): интерфейс перечитывает календарь и
// говорит человеку, что его изменили.

import { sql } from "kysely";
import type { Tx } from "../db/actor";
import { ApiError } from "../errors";

/** Версия календаря листинга (под актором: чужой листинг — 0, его проверяют раньше) */
export async function calendarVersion(trx: Tx, listingId: string): Promise<number> {
  const row = await trx
    .selectFrom("app.availability_versions")
    .select("version")
    .where("listing_id", "=", listingId)
    .executeTakeFirst();
  return row?.version ?? 0;
}

/** Правка — только от этой версии: иначе база ответит calendar_conflict */
export async function lockCalendar(trx: Tx, listingId: string, version: number): Promise<void> {
  await sql`select app.availability_lock(${listingId}::uuid, ${version}::int)`.execute(trx);
}

export const MAX_VERSION = 2_147_483_647;

export const versionRequired = () =>
  new ApiError(428, "version_required", "Calendar version is required (If-Match)");

/**
 * Версия из заголовка If-Match: 12, "12" или W/"12". Нет заголовка — 428
 * version_required; не число — 422 invalid_input
 */
export function versionFromIfMatch(header: string | undefined): number {
  if (header === undefined || header.trim() === "") throw versionRequired();
  const match = /^(?:W\/)?(?:"(\d{1,10})"|(\d{1,10}))$/.exec(header.trim());
  const version = match ? Number(match[1] ?? match[2]) : Number.NaN;
  if (!Number.isInteger(version) || version > MAX_VERSION) {
    throw new ApiError(422, "invalid_input", "Invalid input", ["If-Match"]);
  }
  return version;
}

/** Значение ETag для версии календаря */
export const calendarEtag = (version: number) => `"${version}"`;
