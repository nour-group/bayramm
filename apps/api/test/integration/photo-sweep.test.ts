// Сверка фото с хранилищем на настоящем Postgres (роль API) и настоящем Storage
// локального стека: строки, удалённые больше 30 дней назад, уходят вместе с объектами,
// объекты без строки старше суток — удаляются, остальное не трогается.
//
// Нужен полный стек и ключ, как у photos.test.ts (TEST_SUPABASE_SERVICE_ROLE_KEY);
// без них тест пропускается. Возраст объектов подделывается прямо в storage.objects.

import { randomBytes, randomUUID } from "node:crypto";
import { LISTING_PHOTOS_BUCKET } from "@bayramm/media";
import { trimTrailingSlashes } from "@bayramm/shared";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../../src/db/client";
import { sweepPhotoStorage } from "../../src/photos/sweep";
import { supabaseStorage } from "../../src/storage/supabase";
import { adminClient, apiDatabaseUrl } from "./helpers";

const STORAGE_URL = trimTrailingSlashes(process.env.TEST_SUPABASE_URL ?? "http://127.0.0.1:54321");
const SERVICE_KEY = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY ?? "";
const LOCAL = ["127.0.0.1", "localhost", "[::1]"].includes(new URL(STORAGE_URL).hostname);
const ENABLED = Boolean(SERVICE_KEY) && LOCAL;
if (!ENABLED)
  console.warn("[photo-sweep] пропущено: нужен локальный Storage и TEST_SUPABASE_SERVICE_ROLE_KEY");

const vendor = randomUUID();
const listing = randomUUID();
const key = () => `listings/${listing}/${randomUUID()}.webp`;
const keys = {
  live: key(),
  oldDeleted: key(),
  recentDeleted: key(),
  oldOrphan: key(),
  newOrphan: key(),
};
const ids = { live: randomUUID(), oldDeleted: randomUUID(), recentDeleted: randomUUID() };

let admin: Client;
let db: Db;
const storage = ENABLED
  ? supabaseStorage({ url: STORAGE_URL, serviceKey: SERVICE_KEY, bucket: LISTING_PHOTOS_BUCKET })
  : null;

async function stored(): Promise<string[]> {
  if (!storage) return [];
  const page = await storage.list(`listings/${listing}/`, null, 100);
  return page.objects.map((object) => object.key).sort();
}

describe.skipIf(!ENABLED)("сверка фото с хранилищем", () => {
  beforeAll(async () => {
    admin = await adminClient();
    db = createDb(apiDatabaseUrl);
    await admin.query("insert into app.vendor_accounts (id) values ($1)", [vendor]);
    await admin.query(
      "insert into app.listings (id, vendor_id, slug, category_code, name) values ($1, $2, $3, 'hall', 'Sweep Test')",
      [listing, vendor, `test-sweep-${randomBytes(4).toString("hex")}`],
    );
    for (const k of Object.values(keys)) await storage?.put(k, new Uint8Array([1, 2, 3]), "image/webp");
    for (const [name, id] of Object.entries(ids)) {
      await admin.query(
        `insert into app.photos (id, listing_id, status, storage_key, mime, bytes, width, height, sha256, no_faces_ack)
         values ($1, $2, 'ready', $3, 'image/webp', 3, 10, 10, $4, true)`,
        [id, listing, keys[name as keyof typeof ids], randomBytes(32)],
      );
    }
    await admin.query("update app.photos set deleted_at = now() - interval '40 days' where id = $1", [
      ids.oldDeleted,
    ]);
    await admin.query("update app.photos set deleted_at = now() - interval '10 days' where id = $1", [
      ids.recentDeleted,
    ]);
    // Все объекты, кроме свежей сироты, положили «позавчера»
    await admin.query(
      `update storage.objects set created_at = now() - interval '2 days'
       where bucket_id = $1 and name = any($2::text[])`,
      [LISTING_PHOTOS_BUCKET, Object.values(keys).filter((k) => k !== keys.newOrphan)],
    );
  });

  afterAll(async () => {
    const left = await stored().catch(() => []);
    if (storage && left.length > 0) await storage.removeMany(left).catch(() => 0);
    await db?.destroy();
    if (!admin) return;
    await admin.query("delete from app.photos where listing_id = $1", [listing]);
    await admin.query("delete from app.listings where id = $1", [listing]);
    await admin.query("delete from app.vendor_accounts where id = $1", [vendor]);
    await admin.end();
  });

  it("удалённые больше 30 дней назад — вместе с объектом; сироты старше суток — удалены", async () => {
    expect(await stored()).toEqual(Object.values(keys).sort());
    const report = await sweepPhotoStorage({ db, storage: storage as NonNullable<typeof storage> });
    expect(report.purgedRows).toBeGreaterThanOrEqual(1);
    expect(report.purgedObjects).toBeGreaterThanOrEqual(1);
    expect(report.orphanObjects).toBeGreaterThanOrEqual(1);
    expect(report.scannedObjects).toBeGreaterThanOrEqual(Object.keys(keys).length);

    // Остались: живое фото, недавно удалённое (строка ещё хранится) и свежая сирота
    expect(await stored()).toEqual([keys.live, keys.recentDeleted, keys.newOrphan].sort());
    const { rows } = await admin.query<{ id: string }>(
      "select id from app.photos where listing_id = $1 order by id",
      [listing],
    );
    expect(rows.map((r) => r.id)).toEqual([ids.live, ids.recentDeleted].sort());
  });

  it("повтор ничего не трогает", async () => {
    const before = await stored();
    await sweepPhotoStorage({ db, storage: storage as NonNullable<typeof storage> });
    expect(await stored()).toEqual(before);
  });
});
