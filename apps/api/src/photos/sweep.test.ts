// Сверка фото без базы и без хранилища: что удаляется, в каком порядке и в каких
// пределах. С настоящими Postgres и Storage — test/integration/photo-sweep.test.ts
import { describe, expect, it } from "vitest";
import { type ObjectPage, type ObjectSweeper, StorageError, type StoredObject } from "../storage/supabase";
import { fakeDb, type RecordedQuery } from "../testing/fake-db";
import { ORPHAN_LIMIT, PHOTOS_PREFIX, SCAN_LIMIT, sweepPhotoStorage } from "./sweep";

const NOW = new Date("2026-10-02T21:00:00Z");
const HOUR = 3_600_000;
const LISTING = "aaaaaaaa-0000-4000-8000-000000000101";
const key = (n: number) => `listings/${LISTING}/00000000-0000-4000-8000-${String(n).padStart(12, "0")}.webp`;
const object = (n: number, ageHours: number): StoredObject => ({
  key: key(n),
  createdAt: new Date(NOW.getTime() - ageHours * HOUR),
});

/** Хранилище в памяти: страницы по pageSize, удаление пачкой — с журналом вызовов */
function fakeStorage(objects: StoredObject[], pageSize = 1000, failRemove = false) {
  const calls: string[] = [];
  const removed: string[][] = [];
  const store: ObjectSweeper = {
    async list(prefix, cursor, limit): Promise<ObjectPage> {
      calls.push(`list ${prefix} ${cursor ?? "-"} ${limit}`);
      const start = cursor === null ? 0 : Number(cursor);
      const size = Math.min(limit, pageSize);
      const page = objects.slice(start, start + size);
      const next = start + size < objects.length ? String(start + size) : null;
      return { objects: page, cursor: next };
    },
    async removeMany(keys) {
      calls.push(`remove ${keys.length}`);
      if (failRemove) throw new StorageError("unavailable", 503, "storage remove many: 503");
      removed.push([...keys]);
      return keys.length;
    },
  };
  return { store, calls, removed };
}

const isPurgeSelect = (q: RecordedQuery) =>
  q.sql.startsWith('select "id", "storage_key" from "app"."photos"') && q.sql.includes('"deleted_at" <');
const isPurge = (q: RecordedQuery) => q.sql.includes("app.purge_deleted_photos");
const isKnown = (q: RecordedQuery) => q.sql.startsWith('select "storage_key" from "app"."photos"');

describe("sweepPhotoStorage", () => {
  it("строки, удалённые больше 30 дней назад: сначала объекты, потом строки — под system", async () => {
    const fake = fakeDb((q) => {
      if (isPurgeSelect(q))
        return [
          { id: "p1", storage_key: key(1) },
          { id: "p2", storage_key: key(2) },
        ];
      if (isPurge(q)) return [{ purged: 2 }];
      return [];
    });
    const storage = fakeStorage([]);
    const report = await sweepPhotoStorage({ db: fake.db, storage: storage.store }, NOW);

    expect(report).toMatchObject({ purgedRows: 2, purgedObjects: 2, orphanObjects: 0, complete: true });
    expect(storage.removed[0]).toEqual([key(1), key(2)]);
    const select = fake.queries.find(isPurgeSelect);
    expect(select?.sql).toContain("make_interval(days => $1)");
    expect(select?.parameters[0]).toBe(30);
    const purge = fake.queries.find(isPurge);
    expect(purge?.parameters).toEqual([["p1", "p2"]]);
    // Каждое обращение к базе — под system
    const actors = fake.queries.filter((q) => q.sql.includes("set_config('app.actor_kind'"));
    expect(actors.every((q) => q.parameters[0] === "system")).toBe(true);
  });

  it("хранилище не удалило объекты — строки остаются до следующего раза", async () => {
    const fake = fakeDb((q) => (isPurgeSelect(q) ? [{ id: "p1", storage_key: key(1) }] : []));
    const storage = fakeStorage([], 1000, true);
    await expect(sweepPhotoStorage({ db: fake.db, storage: storage.store }, NOW)).rejects.toBeInstanceOf(
      StorageError,
    );
    expect(fake.queries.some(isPurge)).toBe(false);
  });

  it("сироты: без строки и старше суток; свежие, со строкой и чужого формата — не трогаются", async () => {
    const objects = [
      object(1, 48), // есть строка
      object(2, 48), // сирота
      object(3, 23), // моложе суток — загрузка может ещё идти
      { key: "listings/readme.txt", createdAt: new Date(NOW.getTime() - 48 * HOUR) },
      { key: key(4), createdAt: null }, // возраст неизвестен
    ];
    const fake = fakeDb((q) => (isKnown(q) ? [{ storage_key: key(1) }] : []));
    const storage = fakeStorage(objects);
    const report = await sweepPhotoStorage({ db: fake.db, storage: storage.store }, NOW);

    expect(storage.removed).toEqual([[key(2)]]);
    expect(report).toMatchObject({ scannedObjects: 5, orphanObjects: 1, complete: true });
    const known = fake.queries.find(isKnown);
    expect(known?.parameters).toEqual([key(1), key(2)]);
    expect(storage.calls[0]).toBe(`list ${PHOTOS_PREFIX} - 1000`);
  });

  it("список — страницами до конца; за запуск не больше SCAN_LIMIT объектов", async () => {
    const objects = Array.from({ length: 7 }, (_, n) => object(n, 1));
    const storage = fakeStorage(objects, 3);
    const report = await sweepPhotoStorage({ db: fakeDb().db, storage: storage.store }, NOW);
    expect(storage.calls.filter((c) => c.startsWith("list"))).toEqual([
      `list ${PHOTOS_PREFIX} - 1000`,
      `list ${PHOTOS_PREFIX} 3 1000`,
      `list ${PHOTOS_PREFIX} 6 1000`,
    ]);
    expect(report).toMatchObject({ scannedObjects: 7, orphanObjects: 0, complete: true });

    const many = Array.from({ length: SCAN_LIMIT + 10 }, (_, n) => object(n, 1));
    const bounded = fakeStorage(many);
    const limited = await sweepPhotoStorage({ db: fakeDb().db, storage: bounded.store }, NOW);
    expect(limited).toMatchObject({ scannedObjects: SCAN_LIMIT, complete: false });
  });

  it("сирот за запуск — не больше ORPHAN_LIMIT; остальное — в следующий раз", async () => {
    const orphans = Array.from({ length: ORPHAN_LIMIT + 5 }, (_, n) => object(n, 48));
    const storage = fakeStorage(orphans);
    const report = await sweepPhotoStorage({ db: fakeDb().db, storage: storage.store }, NOW);
    expect(storage.removed.flat()).toHaveLength(ORPHAN_LIMIT);
    expect(report).toMatchObject({ orphanObjects: ORPHAN_LIMIT, complete: false });
  });
});
