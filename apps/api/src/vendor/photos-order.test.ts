// Порядок и обложка фото из кабинета без базы: что считается, что пишется, кто может.
// Защита обложки в базе (photos_vendor_guard) — pgTAP 29, RLS владельца — pgTAP 19 и 29
import { describe, expect, it } from "vitest";
import type { VendorActor } from "../db/actor";
import { ApiError } from "../errors";
import { fakeDb, type RecordedQuery } from "../testing/fake-db";
import { reorderPhotos, setCoverPhoto } from "./photos";

const OWNER: VendorActor = {
  kind: "vendor_user",
  id: "aaaaaaaa-0000-0000-0000-000000000011",
  vendorId: "aaaaaaaa-0000-0000-0000-000000000001",
  role: "owner",
};
const LISTING_ID = "aaaaaaaa-0000-0000-0000-000000000101";
const A = "aaaaaaaa-0000-4000-8000-0000000000a1";
const B = "aaaaaaaa-0000-4000-8000-0000000000b2";
const C = "aaaaaaaa-0000-4000-8000-0000000000c3";
const PENDING = "aaaaaaaa-0000-4000-8000-0000000000d4";

async function rejection(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("ожидался отказ");
}

interface Approved {
  readonly id: string;
  readonly sort: number;
  readonly is_cover: boolean;
}

/** База: одобренные фото витрины (под блокировкой строк), остальные фото — только в ответе-списке */
function db(approved: readonly Approved[], { own = true, known = [PENDING] as readonly string[] } = {}) {
  return fakeDb((q: RecordedQuery) => {
    if (q.sql.startsWith('select "id" from "app"."listings"')) return own ? [{ id: LISTING_ID }] : [];
    if (q.sql.includes('"app"."photos"') && q.sql.includes("for update")) return [...approved];
    // Есть ли такое фото среди неудалённых (ждущее решения) — для понятного отказа
    if (q.sql.startsWith('select "id" from "app"."photos"'))
      return known.includes(String(q.parameters[0])) ? [{ id: q.parameters[0] }] : [];
    if (q.sql.startsWith('select "id", "storage_key"'))
      return approved.map((p) => ({
        id: p.id,
        storage_key: `listings/${LISTING_ID}/${p.id}.webp`,
        width: 1600,
        height: 1200,
        moderation: "approved",
        moderation_reason: null,
        is_cover: p.is_cover,
      }));
    return [];
  });
}

const sortUpdates = (fake: ReturnType<typeof db>) =>
  fake.queries
    .filter((q) => q.sql.startsWith('update "app"."photos" set "sort"'))
    .map((q) => [q.parameters[1], q.parameters[0]]);
const audits = (fake: ReturnType<typeof db>) =>
  fake.queries.filter((q) => q.sql.startsWith('insert into "app"."audit_log"'));

const THREE: readonly Approved[] = [
  { id: A, sort: 0, is_cover: true },
  { id: B, sort: 1, is_cover: false },
  { id: C, sort: 2, is_cover: false },
];

describe("PUT /vendor/listings/:id/photos/order", () => {
  it("одобренные фото получают места по порядку: каждое — sort, который был на его новом месте", async () => {
    // Места занимают 3, 5 и 9: ждущее фото между ними (sort 4) и после (sort 10) не трогаем
    const fake = db([
      { id: A, sort: 3, is_cover: true },
      { id: B, sort: 5, is_cover: false },
      { id: C, sort: 9, is_cover: false },
    ]);
    const result = await reorderPhotos(fake.db, OWNER, LISTING_ID, [A, C, B], "staging");
    expect(sortUpdates(fake)).toEqual([
      [A, 3],
      [C, 5],
      [B, 9],
    ]);
    expect(result.photos).toHaveLength(3);
    // Под актором партнёра, одной транзакцией
    expect(fake.log[0]).toBe("begin");
    expect(fake.log.at(-1)).toBe("commit");
    expect(fake.queries[0]?.parameters).toEqual(["vendor_user", OWNER.id, OWNER.vendorId]);
    // Выбирает только одобренные, готовые, не удалённые
    const select = fake.queries.find((q) => q.sql.includes("for update"));
    expect(select?.sql).toContain('"moderation" = $');
    expect(select?.sql).toContain('"deleted_at" is null');
    expect(select?.parameters).toContain("approved");
  });

  it("обложка остаётся первой, даже если её поставили не первой", async () => {
    const fake = db(THREE);
    await reorderPhotos(fake.db, OWNER, LISTING_ID, [C, B, A], "staging");
    expect(sortUpdates(fake)).toEqual([
      [A, 0],
      [C, 1],
      [B, 2],
    ]);
  });

  it("в журнал — id витрины и число фото, без ПДн", async () => {
    const fake = db(THREE);
    await reorderPhotos(fake.db, OWNER, LISTING_ID, [A, C, B], "staging");
    expect(audits(fake)).toHaveLength(1);
    expect(audits(fake)[0]?.parameters).toEqual([
      "photo.order",
      "listing",
      LISTING_ID,
      JSON.stringify({ count: 3 }),
      "vendor_cabinet",
    ]);
  });

  it("не тот набор — 422 invalid_input ids, ничего не пишется: лишнее, пропущенное, повтор, ждущее решения", async () => {
    for (const ids of [[A, B], [A, B, C, PENDING], [A, A, B], [A, B, PENDING], []]) {
      const fake = db(THREE);
      const err = await rejection(() => reorderPhotos(fake.db, OWNER, LISTING_ID, ids, "staging"));
      expect([err.status, err.code, err.details], JSON.stringify(ids)).toEqual([
        422,
        "invalid_input",
        ["ids"],
      ]);
      expect(sortUpdates(fake)).toEqual([]);
      expect(audits(fake)).toEqual([]);
    }
  });

  it("сотрудник площадки — 403 до базы; чужая витрина — 404", async () => {
    const fake = db(THREE);
    const member = await rejection(() =>
      reorderPhotos(fake.db, { ...OWNER, role: "member" }, LISTING_ID, [A, B, C], "staging"),
    );
    expect([member.status, member.code]).toEqual([403, "vendor_owner_required"]);
    expect(fake.queries).toEqual([]);
    const other = db(THREE, { own: false });
    expect(
      (await rejection(() => reorderPhotos(other.db, OWNER, LISTING_ID, [A, B, C], "staging"))).status,
    ).toBe(404);
  });
});

describe("POST /vendor/listings/:id/photos/:photoId/cover", () => {
  it("одобренное фото — обложка и первое в порядке; прежняя обложка снята; в журнал — id фото", async () => {
    const fake = db(THREE);
    await setCoverPhoto(fake.db, OWNER, LISTING_ID, C, "staging");
    const cover = fake.queries.filter((q) => q.sql.startsWith('update "app"."photos" set "is_cover"'));
    // Сначала снять старую (у всей витрины), потом поставить новую
    expect(cover.map((q) => [q.sql.includes('where "listing_id"'), q.parameters[0]])).toEqual([
      [true, false],
      [false, true],
    ]);
    expect(cover[1]?.parameters).toEqual([true, C]);
    expect(sortUpdates(fake)).toEqual([
      [C, 0],
      [A, 1],
      [B, 2],
    ]);
    expect(audits(fake)[0]?.parameters).toEqual([
      "photo.cover",
      "listing",
      LISTING_ID,
      JSON.stringify({ photo_id: C }),
      "vendor_cabinet",
    ]);
  });

  it("ждущее решения или отклонённое — 422 invalid_input photoId; нет такого — 404; ничего не пишется", async () => {
    const fake = db(THREE);
    const pending = await rejection(() => setCoverPhoto(fake.db, OWNER, LISTING_ID, PENDING, "staging"));
    expect([pending.status, pending.code, pending.details]).toEqual([422, "invalid_input", ["photoId"]]);
    const missing = await rejection(() =>
      setCoverPhoto(fake.db, OWNER, LISTING_ID, "aaaaaaaa-0000-4000-8000-0000000000ff", "staging"),
    );
    expect(missing.status).toBe(404);
    expect(fake.queries.some((q) => q.sql.startsWith('update "app"."photos"'))).toBe(false);
  });

  it("сотрудник площадки — 403 до базы", async () => {
    const fake = db(THREE);
    const member = await rejection(() =>
      setCoverPhoto(fake.db, { ...OWNER, role: "member" }, LISTING_ID, B, "staging"),
    );
    expect([member.status, member.code]).toEqual([403, "vendor_owner_required"]);
    expect(fake.queries).toEqual([]);
  });
});
