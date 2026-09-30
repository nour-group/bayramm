// Сверка фото: хранилище против базы, раз в день (шаг daily_maintenance cron,
// maintenance/index.ts — после того как база отметила дневное обслуживание).
//
//   1. Сроки хранения: строки фото, удалённые больше 30 дней назад, — сначала их
//      объекты (одним запросом, отсутствующий объект — не ошибка), затем сами строки
//      (app.purge_deleted_photos, актор system). Хранилище не ответило — строки
//      остаются до следующего раза.
//   2. Сироты: объекты под listings/ без строки в app.photos (ни живой, ни удалённой)
//      и старше суток — загрузка, после которой строка не записалась, а откат объекта
//      не удался (photos/service.ts пишет это в лог), или строка, уже вычищенная
//      шагом 1, чей объект тогда не удалился. Сутки — чтобы не задеть загрузку,
//      которая идёт прямо сейчас: объект кладётся раньше строки. Трогаем только ключи
//      формата фото листинга.
//   3. Всё ограничено за запуск: строк — PURGE_LIMIT, просмотренных объектов —
//      SCAN_LIMIT, удалённых сирот — ORPHAN_LIMIT. Остальное — в следующий раз. В лог —
//      только числа: ни ключей, ни id.

import { isListingPhotoKey } from "@bayramm/media";
import { sql } from "kysely";
import { SYSTEM, withActor } from "../db/actor";
import type { Db } from "../db/client";
import { MAX_REMOVE_BATCH, type ObjectSweeper } from "../storage/supabase";

/** Сколько дней хранится строка удалённого фото (как в app.purge_deleted_photos) */
export const DELETED_RETENTION_DAYS = 30;
/** Объект без строки моложе этого — возможно, загрузка ещё идёт */
export const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;
export const PURGE_LIMIT = 500;
export const SCAN_PAGE = 1000;
export const SCAN_LIMIT = 5000;
export const ORPHAN_LIMIT = 500;

export const PHOTOS_PREFIX = "listings/";

export interface PhotoSweepDeps {
  readonly db: Db;
  readonly storage: ObjectSweeper;
}

export interface PhotoSweepReport {
  /** Строк удалённых фото вычищено */
  readonly purgedRows: number;
  /** Объектов удалённых фото удалено хранилищем */
  readonly purgedObjects: number;
  /** Объектов просмотрено в хранилище */
  readonly scannedObjects: number;
  /** Сирот удалено */
  readonly orphanObjects: number;
  /** Хранилище просмотрено до конца (иначе упёрлись в предел — продолжим в следующий раз) */
  readonly complete: boolean;
}

/** Шаг 1: строки, удалённые больше 30 дней назад, и их объекты */
async function purgeDeleted(deps: PhotoSweepDeps): Promise<{ rows: number; objects: number }> {
  const rows = await withActor(deps.db, SYSTEM, (trx) =>
    trx
      .selectFrom("app.photos")
      .select(["id", "storage_key"])
      .where("deleted_at", "<", sql<Date>`now() - make_interval(days => ${DELETED_RETENTION_DAYS})`)
      .orderBy("deleted_at")
      .limit(PURGE_LIMIT)
      .execute(),
  );
  if (rows.length === 0) return { rows: 0, objects: 0 };

  let objects = 0;
  for (let i = 0; i < rows.length; i += MAX_REMOVE_BATCH) {
    const keys = rows.slice(i, i + MAX_REMOVE_BATCH).map((row) => row.storage_key);
    objects += await deps.storage.removeMany(keys);
  }
  const ids = rows.map((row) => row.id);
  const purged = await withActor(deps.db, SYSTEM, async (trx) => {
    const { rows: result } = await sql<{ purged: number }>`
      select app.purge_deleted_photos(${ids}::uuid[]) as purged`.execute(trx);
    return result[0]?.purged ?? 0;
  });
  return { rows: purged, objects };
}

/** Какие из ключей есть в app.photos (живые и удалённые строки) */
async function knownKeys(db: Db, keys: readonly string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await withActor(db, SYSTEM, (trx) =>
    trx
      .selectFrom("app.photos")
      .select("storage_key")
      .where("storage_key", "in", [...keys])
      .execute(),
  );
  return new Set(rows.map((row) => row.storage_key));
}

/** Шаг 2: объекты без строки старше суток */
async function removeOrphans(
  deps: PhotoSweepDeps,
  now: Date,
): Promise<{ scanned: number; removed: number; complete: boolean }> {
  const cutoff = now.getTime() - ORPHAN_MIN_AGE_MS;
  const orphans: string[] = [];
  let scanned = 0;
  let cursor: string | null = null;
  let complete = false;

  while (scanned < SCAN_LIMIT && orphans.length < ORPHAN_LIMIT) {
    const page = await deps.storage.list(PHOTOS_PREFIX, cursor, Math.min(SCAN_PAGE, SCAN_LIMIT - scanned));
    scanned += page.objects.length;
    const old = page.objects
      .filter((object) => isListingPhotoKey(object.key))
      .filter((object) => object.createdAt !== null && object.createdAt.getTime() < cutoff)
      .map((object) => object.key);
    const known = await knownKeys(deps.db, old);
    for (const key of old) {
      if (!known.has(key) && orphans.length < ORPHAN_LIMIT) orphans.push(key);
    }
    cursor = page.cursor;
    if (cursor === null) {
      complete = true;
      break;
    }
  }

  let removed = 0;
  for (let i = 0; i < orphans.length; i += MAX_REMOVE_BATCH) {
    removed += await deps.storage.removeMany(orphans.slice(i, i + MAX_REMOVE_BATCH));
  }
  return { scanned, removed, complete: complete && orphans.length < ORPHAN_LIMIT };
}

/** Сверка целиком. Ошибка хранилища или базы — наружу: шаг cron запишет её в лог */
export async function sweepPhotoStorage(
  deps: PhotoSweepDeps,
  now: Date = new Date(),
): Promise<PhotoSweepReport> {
  const purged = await purgeDeleted(deps);
  const orphans = await removeOrphans(deps, now);
  return {
    purgedRows: purged.rows,
    purgedObjects: purged.objects,
    scannedObjects: orphans.scanned,
    orphanObjects: orphans.removed,
    complete: orphans.complete,
  };
}
