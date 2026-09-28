// Фото листинга на настоящем Postgres: роль API, RLS, photos_guard, «готово»
// от system, откат объекта при неудачной вставке. Две части:
//
//   · база + хранилище в памяти — работает везде, где есть `supabase db start`
//     (в том числе в CI);
//   · база + настоящий Storage локального стека — нужен полный стек
//     (`npx supabase start`: Storage API не входит в `db start`) и ключ:
//       TEST_SUPABASE_SERVICE_ROLE_KEY — SERVICE_ROLE_KEY из `npx supabase status -o env`
//       TEST_SUPABASE_URL              — по умолчанию http://127.0.0.1:54321
//     Без них эта часть пропускается с сообщением, почему.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { LISTING_PHOTOS_BUCKET } from "@bayramm/media";
import { exifSegment, jpegFixture, webpFixture } from "@bayramm/media/testing";
import { trimTrailingSlashes } from "@bayramm/shared";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/db/actor";
import { createDb, type Db } from "../../src/db/client";
import { type ApiError, toApiError } from "../../src/errors";
import { addListingPhoto, removeListingPhoto } from "../../src/photos/service";
import { type ObjectStorage, StorageError, supabaseStorage } from "../../src/storage/supabase";
import { adminClient, apiDatabaseUrl } from "./helpers";

const STORAGE_URL = trimTrailingSlashes(process.env.TEST_SUPABASE_URL ?? "http://127.0.0.1:54321");
const SERVICE_KEY = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY ?? "";

/** Причина пропустить тесты настоящего Storage; null — можно запускать. */
async function storageSkipReason(): Promise<string | null> {
  if (!SERVICE_KEY) {
    return "не задан TEST_SUPABASE_SERVICE_ROLE_KEY (npx supabase start; npx supabase status -o env)";
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(STORAGE_URL).hostname)) {
    return `тесты пишут и удаляют объекты — только локальный Storage, а не ${STORAGE_URL}`;
  }
  try {
    const res = await fetch(`${STORAGE_URL}/storage/v1/bucket/${LISTING_PHOTOS_BUCKET}`, {
      headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` },
    });
    if (res.status !== 200)
      return `Storage ответил ${res.status}: нет бакета ${LISTING_PHOTOS_BUCKET} или ключ неверный`;
  } catch {
    return `нет Storage на ${STORAGE_URL} — нужен полный стек: npx supabase start (db start его не поднимает)`;
  }
  return null;
}

const skipStorage = await storageSkipReason();
if (skipStorage) console.warn(`[photos] тесты с настоящим Storage пропущены: ${skipStorage}`);

/** Хранилище в памяти: что положили, то и лежит */
function memoryStorage() {
  const objects = new Map<string, { body: Uint8Array; type: string }>();
  const storage: ObjectStorage = {
    async put(key, body, type) {
      if (objects.has(key)) throw new StorageError("exists", 409, "exists");
      objects.set(key, { body, type });
    },
    async remove(key) {
      objects.delete(key);
    },
  };
  return { storage, objects };
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest();

let admin: Client;
let db: Db;
const vendorA = randomUUID();
const vendorB = randomUUID();
const userA = randomUUID();
const userB = randomUUID();
const listing = randomUUID();
const A: Actor = { kind: "vendor_user", id: userA, vendorId: vendorA };
const B: Actor = { kind: "vendor_user", id: userB, vendorId: vendorB };
const ACK = { noFacesAck: true } as const;

beforeAll(async () => {
  admin = await adminClient();
  db = createDb(apiDatabaseUrl);
  // Под postgres (без актора триггеры считают его system): два вендора и черновик листинга A
  await admin.query("insert into app.vendor_accounts (id) values ($1), ($2)", [vendorA, vendorB]);
  await admin.query(
    "insert into app.vendor_users (id, vendor_id, phone_hash) values ($1, $2, $3), ($4, $5, $6)",
    [userA, vendorA, randomBytes(32), userB, vendorB, randomBytes(32)],
  );
  await admin.query(
    "insert into app.listings (id, vendor_id, slug, category_code, name) values ($1, $2, $3, 'hall', 'Photo Test')",
    [listing, vendorA, `test-photos-${randomBytes(4).toString("hex")}`],
  );
});

afterAll(async () => {
  await db?.destroy();
  if (!admin) return;
  await admin.query("delete from app.photos where listing_id = $1", [listing]);
  await admin.query("delete from app.listings where id = $1", [listing]);
  await admin.query("delete from app.vendor_users where vendor_id = any($1::uuid[])", [[vendorA, vendorB]]);
  await admin.query("delete from app.vendor_accounts where id = any($1::uuid[])", [[vendorA, vendorB]]);
  await admin.end();
});

async function row(id: string) {
  const { rows } = await admin.query(
    `select status, moderation, storage_key, mime, bytes, width, height, sha256, uploaded_by,
            processed_at is not null as processed, deleted_at is not null as deleted
     from app.photos where id = $1`,
    [id],
  );
  return rows[0];
}

async function rejection(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run();
  } catch (err) {
    return toApiError(err);
  }
  throw new Error("ожидался отказ");
}

describe("фото листинга: Postgres (хранилище в памяти)", () => {
  const mem = memoryStorage();
  const deps = () => ({ db, storage: mem.storage });
  const photo = webpFixture({ width: 640, height: 480 });
  let photoId = "";

  it("вендор загружает фото в свой листинг: строка готова, автор — вендор, объект лежит", async () => {
    const added = await addListingPhoto(deps(), A, listing, photo, ACK);
    photoId = added.id;
    expect(added).toMatchObject({
      listingId: listing,
      storageKey: `listings/${listing}/${added.id}.webp`,
      mime: "image/webp",
      width: 640,
      height: 480,
      bytes: photo.length,
      status: "ready",
      moderation: "pending",
    });
    expect(mem.objects.get(added.storageKey)).toEqual({ body: photo, type: "image/webp" });
    expect(await row(added.id)).toMatchObject({
      status: "ready",
      processed: true,
      deleted: false,
      uploaded_by: userA,
      sha256: sha256(photo),
    });
  });

  it("тот же файл второй раз — 409 duplicate_photo, в хранилище ничего нового", async () => {
    const before = mem.objects.size;
    expect(await rejection(() => addListingPhoto(deps(), A, listing, photo, ACK))).toMatchObject({
      status: 409,
      code: "duplicate_photo",
    });
    expect(mem.objects.size).toBe(before);
  });

  it("чужой вендор — 404, в хранилище ничего", async () => {
    const before = mem.objects.size;
    const other = webpFixture({ width: 800, height: 600 });
    expect(await rejection(() => addListingPhoto(deps(), B, listing, other, ACK))).toMatchObject({
      status: 404,
    });
    expect(mem.objects.size).toBe(before);
  });

  it("JPEG с EXIF — 422 metadata_present", async () => {
    const jpeg = jpegFixture({ width: 640, height: 480, segments: [exifSegment()] });
    expect(await rejection(() => addListingPhoto(deps(), A, listing, jpeg, ACK))).toMatchObject({
      status: 422,
      code: "invalid_image",
      details: ["metadata_present"],
    });
  });

  it("вставка проиграла гонку уже после загрузки — объект удалён, ответ 409", async () => {
    const racing = webpFixture({ width: 700, height: 500 });
    // Пока файл «грузится», тот же файл успевает записаться другим запросом
    const storage: ObjectStorage = {
      async put(key, body, type) {
        await mem.storage.put(key, body, type);
        await admin.query(
          `insert into app.photos (listing_id, storage_key, sha256, no_faces_ack)
           values ($1, $2, $3, true)`,
          [listing, `listings/${listing}/${randomUUID()}.webp`, sha256(racing)],
        );
      },
      remove: (key) => mem.storage.remove(key),
    };
    const before = mem.objects.size;
    expect(await rejection(() => addListingPhoto({ db, storage }, A, listing, racing, ACK))).toMatchObject({
      status: 409,
      code: "duplicate_photo",
    });
    expect(mem.objects.size).toBe(before);
  });

  it("чужой вендор не удаляет; свой — строка помечена удалённой, объекта нет", async () => {
    expect(await rejection(() => removeListingPhoto(deps(), B, listing, photoId))).toMatchObject({
      status: 404,
    });
    const removed = await removeListingPhoto(deps(), A, listing, photoId);
    expect(removed).toMatchObject({ id: photoId, objectRemoved: true });
    expect(mem.objects.has(removed.storageKey)).toBe(false);
    expect(await row(photoId)).toMatchObject({ deleted: true });
    expect(await rejection(() => removeListingPhoto(deps(), A, listing, photoId))).toMatchObject({
      status: 404,
    });
  });
});

describe.skipIf(skipStorage !== null)("фото листинга: Postgres + Storage локального стека", () => {
  const storage = () =>
    supabaseStorage({ url: STORAGE_URL, serviceKey: SERVICE_KEY, bucket: LISTING_PHOTOS_BUCKET });
  const publicUrl = (key: string) =>
    `${STORAGE_URL}/storage/v1/object/public/${LISTING_PHOTOS_BUCKET}/${key}`;
  const created: string[] = [];

  async function listed(): Promise<string[]> {
    const res = await fetch(`${STORAGE_URL}/storage/v1/object/list/${LISTING_PHOTOS_BUCKET}`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        authorization: `Bearer ${SERVICE_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ prefix: `listings/${listing}/`, limit: 100 }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { name: string }[]).map((o) => o.name);
  }

  afterAll(async () => {
    for (const key of created) await storage().remove(key);
  });

  it("WebP загружается в бакет, строка готова, объект отдаётся публично как есть", async () => {
    const photo = webpFixture({ width: 1024, height: 768 });
    const added = await addListingPhoto({ db, storage: storage() }, A, listing, photo, ACK);
    created.push(added.storageKey);
    expect(await row(added.id)).toMatchObject({ status: "ready", storage_key: added.storageKey });

    const res = await fetch(publicUrl(added.storageKey));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("cache-control")).toContain("max-age=31536000");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(photo);
  });

  it("файл с EXIF не доходит до бакета", async () => {
    const before = await listed();
    const jpeg = jpegFixture({ width: 1024, height: 768, segments: [exifSegment()] });
    expect(
      await rejection(() => addListingPhoto({ db, storage: storage() }, A, listing, jpeg, ACK)),
    ).toMatchObject({
      code: "invalid_image",
      details: ["metadata_present"],
    });
    expect(await listed()).toEqual(before);
  });

  it("бакет сам не принимает не-картинки и не перезаписывает объекты", async () => {
    const key = `listings/${listing}/${randomUUID()}.webp`;
    const html = new TextEncoder().encode("<script>alert(1)</script>");
    await expect(storage().put(key, html, "text/html")).rejects.toMatchObject({ reason: "rejected" });

    const photo = webpFixture({ width: 900, height: 600 });
    await storage().put(key, photo, "image/webp");
    created.push(key);
    await expect(storage().put(key, photo, "image/webp")).rejects.toMatchObject({ reason: "exists" });
  });

  it("удаление убирает и строку из выдачи, и объект", async () => {
    const photo = webpFixture({ width: 1000, height: 700 });
    const added = await addListingPhoto({ db, storage: storage() }, A, listing, photo, ACK);
    created.push(added.storageKey);
    expect((await fetch(publicUrl(added.storageKey))).status).toBe(200);

    expect(await removeListingPhoto({ db, storage: storage() }, A, listing, added.id)).toMatchObject({
      objectRemoved: true,
    });
    const gone = await fetch(publicUrl(added.storageKey));
    expect([400, 404]).toContain(gone.status);
  });
});
