// Сервис фото без базы и хранилища: порядок шагов, отказы до хранилища, откат
// объекта при неудачной вставке. С настоящими Postgres и Storage —
// test/integration/photos.test.ts
import { exifSegment, jpegFixture, webpFixture } from "@bayramm/media/testing";
import { DatabaseError } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../db/actor";
import { ApiError } from "../errors";
import type { ObjectStorage } from "../storage/supabase";
import { StorageError } from "../storage/supabase";
import { fakeDb, type RecordedQuery } from "../testing/fake-db";
import { addListingPhoto, removeListingPhoto } from "./service";

const LISTING = "aaaaaaaa-0000-4000-8000-000000000101";
const VENDOR: Actor = {
  kind: "vendor_user",
  id: "aaaaaaaa-0000-4000-8000-000000000011",
  vendorId: "aaaaaaaa-0000-4000-8000-000000000001",
};
const WEBP = webpFixture({ width: 1600, height: 1200 });
const KEY_RE = new RegExp(`^listings/${LISTING}/([0-9a-f-]{36})\\.webp$`);

function fakeStorage(fail: { put?: Error; remove?: Error } = {}) {
  const calls: { op: "put" | "remove"; key: string; type?: string; bytes?: number }[] = [];
  const storage: ObjectStorage = {
    async put(key, body, contentType) {
      calls.push({ op: "put", key, type: contentType, bytes: body.length });
      if (fail.put) throw fail.put;
    },
    async remove(key) {
      calls.push({ op: "remove", key });
      if (fail.remove) throw fail.remove;
    },
  };
  return { storage, calls };
}

interface DbScript {
  precheck?: unknown[];
  insertError?: Error;
  update?: unknown[];
}

function photoRow(query: RecordedQuery) {
  const id = query.parameters.at(-1) as string;
  return {
    id,
    listing_id: LISTING,
    storage_key: `listings/${LISTING}/${id}.webp`,
    mime: "image/webp",
    bytes: WEBP.length,
    width: 1600,
    height: 1200,
    sort: 3,
    status: "ready",
    moderation: "pending",
  };
}

function scriptedDb(script: DbScript = {}) {
  return fakeDb((query) => {
    if (query.sql.includes("app.setting_int('max_photos')")) {
      return script.precheck ?? [{ photos: 2, duplicate: false, max_photos: 10 }];
    }
    if (query.sql.startsWith('insert into "app"."photos"')) {
      if (script.insertError) throw script.insertError;
      return [];
    }
    if (query.sql.startsWith('update "app"."photos"')) return script.update ?? [photoRow(query)];
    return [];
  });
}

function pgError(code: string, constraint?: string): DatabaseError {
  const err = new DatabaseError("db error", 0, "error");
  Object.assign(err, { severity: "ERROR", code, constraint });
  return err;
}

async function apiError(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("ожидалась ApiError");
}

const setConfigs = (queries: RecordedQuery[]) =>
  queries.filter((q) => q.sql.includes("set_config('app.actor_kind'")).map((q) => q.parameters[0]);

afterEach(() => vi.restoreAllMocks());

describe("addListingPhoto", () => {
  it("проверка → предпроверка под актором → объект → строка под актором → «готово» от system", async () => {
    const db = scriptedDb();
    const { storage, calls } = fakeStorage();
    const photo = await addListingPhoto({ db: db.db, storage }, VENDOR, LISTING, WEBP, { noFacesAck: true });

    // Объект: ключ под листингом, тип из байтов
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ op: "put", type: "image/webp", bytes: WEBP.length });
    const [, id] = KEY_RE.exec(calls[0]?.key ?? "") ?? [];
    expect(id).toBeDefined();

    // Две транзакции: предпроверка и запись; во второй актор меняется на system перед update
    expect(db.log.filter((entry) => entry === "begin")).toHaveLength(2);
    expect(db.log.filter((entry) => entry === "commit")).toHaveLength(2);
    expect(setConfigs(db.queries)).toEqual(["vendor_user", "vendor_user", "system"]);
    const insert = db.queries.find((q) => q.sql.startsWith('insert into "app"."photos"'));
    expect(insert?.parameters).toEqual(
      expect.arrayContaining([id, LISTING, calls[0]?.key, "image/webp", WEBP.length, 1600, 1200, true]),
    );
    const updateAt = db.queries.findIndex((q) => q.sql.startsWith('update "app"."photos"'));
    expect(db.queries[updateAt - 1]?.parameters[0]).toBe("system");
    expect(db.queries[updateAt]?.sql).toContain('"status" = $1');

    expect(photo).toEqual({
      id,
      listingId: LISTING,
      storageKey: calls[0]?.key,
      mime: "image/webp",
      bytes: WEBP.length,
      width: 1600,
      height: 1200,
      sort: 3,
      status: "ready",
      moderation: "pending",
    });
  });

  it("файл с EXIF — 422 invalid_image, ни базы, ни хранилища", async () => {
    const db = scriptedDb();
    const { storage, calls } = fakeStorage();
    const jpeg = jpegFixture({ width: 1600, height: 1200, segments: [exifSegment()] });
    const err = await apiError(() =>
      addListingPhoto({ db: db.db, storage }, VENDOR, LISTING, jpeg, { noFacesAck: true }),
    );
    expect(err).toMatchObject({ status: 422, code: "invalid_image", details: ["metadata_present"] });
    expect(db.queries).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("не картинка, мелкое фото, больше 10 МБ", async () => {
    const deps = { db: scriptedDb().db, storage: fakeStorage().storage };
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    expect(
      await apiError(() => addListingPhoto(deps, VENDOR, LISTING, html, { noFacesAck: true })),
    ).toMatchObject({
      status: 422,
      details: ["unsupported_format"],
    });
    const small = webpFixture({ width: 300, height: 200 });
    expect(
      await apiError(() => addListingPhoto(deps, VENDOR, LISTING, small, { noFacesAck: true })),
    ).toMatchObject({
      details: ["dimensions_too_small"],
    });
    const huge = new Uint8Array(10 * 1024 * 1024 + 1);
    expect(
      await apiError(() => addListingPhoto(deps, VENDOR, LISTING, huge, { noFacesAck: true })),
    ).toMatchObject({
      status: 413,
      code: "payload_too_large",
    });
  });

  it("чужой листинг, лимит, повтор — отказ до хранилища", async () => {
    const cases: [unknown[], number, string][] = [
      [[], 404, "not_found"],
      [[{ photos: 10, duplicate: false, max_photos: 10 }], 409, "too_many_photos"],
      [[{ photos: 3, duplicate: true, max_photos: 10 }], 409, "duplicate_photo"],
    ];
    for (const [precheck, status, code] of cases) {
      const db = scriptedDb({ precheck });
      const { storage, calls } = fakeStorage();
      const err = await apiError(() =>
        addListingPhoto({ db: db.db, storage }, VENDOR, LISTING, WEBP, { noFacesAck: true }),
      );
      expect(err).toMatchObject({ status, code });
      expect(calls).toHaveLength(0);
      expect(db.queries.some((q) => q.sql.startsWith("insert"))).toBe(false);
    }
  });

  it("хранилище недоступно — 503, в базу ничего", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = scriptedDb();
    const { storage } = fakeStorage({ put: new StorageError("unavailable", 0, "down") });
    const err = await apiError(() =>
      addListingPhoto({ db: db.db, storage }, VENDOR, LISTING, WEBP, { noFacesAck: true }),
    );
    expect(err).toMatchObject({ status: 503, code: "storage_unavailable" });
    expect(db.queries.some((q) => q.sql.startsWith("insert"))).toBe(false);
  });

  it("вставка не удалась (гонка за лимит, RLS) — объект удаляется, ошибка базы уходит дальше", async () => {
    const insertError = pgError("BR011");
    const db = scriptedDb({ insertError });
    const { storage, calls } = fakeStorage();
    await expect(
      addListingPhoto({ db: db.db, storage }, VENDOR, LISTING, WEBP, { noFacesAck: true }),
    ).rejects.toBe(insertError);
    expect(calls.map((c) => c.op)).toEqual(["put", "remove"]);
    expect(calls[1]?.key).toBe(calls[0]?.key);
    expect(db.log.at(-1)).toBe("rollback");
  });

  it("и если удалить объект не вышло — наружу всё равно исходная ошибка", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const insertError = pgError("23505", "photos_dedupe");
    const db = scriptedDb({ insertError });
    const { storage } = fakeStorage({ remove: new StorageError("unavailable", 0, "down") });
    await expect(
      addListingPhoto({ db: db.db, storage }, VENDOR, LISTING, WEBP, { noFacesAck: true }),
    ).rejects.toBe(insertError);
    expect(error).toHaveBeenCalled();
  });

  it("клиент — 403, гость — 401, кривой id листинга — 404, без подтверждения «нет лиц» — 422", async () => {
    const deps = { db: scriptedDb().db, storage: fakeStorage().storage };
    const client: Actor = { kind: "client", id: "cccccccc-0000-4000-8000-000000000001" };
    expect(
      (await apiError(() => addListingPhoto(deps, client, LISTING, WEBP, { noFacesAck: true }))).status,
    ).toBe(403);
    expect(
      (await apiError(() => addListingPhoto(deps, { kind: "guest" }, LISTING, WEBP, { noFacesAck: true })))
        .status,
    ).toBe(401);
    expect(
      (await apiError(() => addListingPhoto(deps, VENDOR, "1 or 1=1", WEBP, { noFacesAck: true }))).status,
    ).toBe(404);
    const noAck = { noFacesAck: false } as unknown as { noFacesAck: true };
    expect((await apiError(() => addListingPhoto(deps, VENDOR, LISTING, WEBP, noAck))).status).toBe(422);
  });

  it("сотрудник загружает тем же путём", async () => {
    const db = scriptedDb();
    const { storage } = fakeStorage();
    const staff: Actor = { kind: "staff", id: "00000000-0000-4000-8000-00000000a001" };
    await addListingPhoto({ db: db.db, storage }, staff, LISTING, WEBP, { noFacesAck: true });
    expect(setConfigs(db.queries)).toEqual(["staff", "staff", "system"]);
  });
});

describe("removeListingPhoto", () => {
  const PHOTO = "7f0e6d5c-2222-4b3a-8d4e-0000000000f1";
  const KEY = `listings/${LISTING}/${PHOTO}.webp`;
  const removedDb = (rows: unknown[]) =>
    fakeDb((query) => (query.sql.startsWith('update "app"."photos"') ? rows : []));

  it("помечает удалённым под актором, затем удаляет объект", async () => {
    const db = removedDb([{ id: PHOTO, storage_key: KEY }]);
    const { storage, calls } = fakeStorage();
    const result = await removeListingPhoto({ db: db.db, storage }, VENDOR, LISTING, PHOTO);
    expect(result).toEqual({ id: PHOTO, storageKey: KEY, objectRemoved: true });
    expect(setConfigs(db.queries)).toEqual(["vendor_user"]);
    const update = db.queries.find((q) => q.sql.startsWith('update "app"."photos"'));
    expect(update?.sql).toContain('"deleted_at" = now()');
    expect(update?.parameters).toEqual([PHOTO, LISTING]);
    expect(calls).toEqual([{ op: "remove", key: KEY }]);
  });

  it("нет такого (или чужое, или уже удалено) — 404, хранилище не трогаем", async () => {
    const { storage, calls } = fakeStorage();
    const err = await apiError(() =>
      removeListingPhoto({ db: removedDb([]).db, storage }, VENDOR, LISTING, PHOTO),
    );
    expect(err.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("объект не удалился — строка всё равно удалена, objectRemoved: false", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = removedDb([{ id: PHOTO, storage_key: KEY }]);
    const { storage } = fakeStorage({ remove: new StorageError("unavailable", 0, "down") });
    expect(await removeListingPhoto({ db: db.db, storage }, VENDOR, LISTING, PHOTO)).toMatchObject({
      objectRemoved: false,
    });
  });

  it("опубликованный листинг не остаётся меньше чем с 3 фото — ошибка базы, объект цел", async () => {
    const blocked = pgError("BR004");
    const db = fakeDb((query) => {
      if (query.sql.startsWith('update "app"."photos"')) throw blocked;
      return [];
    });
    const { storage, calls } = fakeStorage();
    await expect(removeListingPhoto({ db: db.db, storage }, VENDOR, LISTING, PHOTO)).rejects.toBe(blocked);
    expect(calls).toHaveLength(0);
  });
});
