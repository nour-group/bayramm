import { describe, expect, it } from "vitest";
import type { VendorActor } from "../db/actor";
import { ApiError } from "../errors";
import { fakeDb, type RecordedQuery } from "../testing/fake-db";
import { submitListing } from "./submit";

const OWNER: VendorActor = {
  kind: "vendor_user",
  id: "aaaaaaaa-0000-0000-0000-000000000011",
  vendorId: "aaaaaaaa-0000-0000-0000-000000000001",
  role: "owner",
};
const LISTING_ID = "aaaaaaaa-0000-0000-0000-000000000102";

async function rejection(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("ожидался отказ");
}

/** База: витрина в этом статусе (null — чужая или нет такой); смена статуса — в ней же */
function db(status: string | null) {
  let current = status;
  return fakeDb((q: RecordedQuery) => {
    if (q.sql.startsWith('update "app"."listings"')) {
      current = String(q.parameters[0]);
      return [];
    }
    if (q.sql.includes("for update")) return current === null ? [] : [{ status: current }];
    if (q.sql.includes('from "app"."listings"'))
      return [
        {
          id: LISTING_ID,
          slug: "draft-hall",
          name: "Draft Hall",
          status: current,
          status_reason: null,
          category_code: "hall",
          district_code: "yunusobod",
          address_ru: null,
          address_uz: null,
          description_ru: "Описание",
          description_uz: "Tavsif",
          price_from_uzs: "150000",
          price_unit: "per_guest",
          cap_min: 50,
          cap_max: 200,
          attributes: {},
          video_links: [],
          parallel_capacity: 1,
          blockers: ["contract"],
          review_blockers: [],
          phone: "+998000000998",
          min_photos: 3,
          max_photos: 10,
        },
      ];
    return [];
  });
}

const updates = (fake: ReturnType<typeof db>) =>
  fake.queries.filter((q) => q.sql.startsWith('update "app"."listings"')).map((q) => q.parameters[0]);

describe("POST /vendor/listings/:id/submit", () => {
  it("черновик — на проверку под актором партнёра; ответ — витрина как GET", async () => {
    const fake = db("draft");
    const listing = await submitListing(fake.db, OWNER, LISTING_ID, "staging");
    expect(updates(fake)).toEqual(["review"]);
    expect(listing).toMatchObject({ id: LISTING_ID, status: "review", reviewBlockers: [] });
    // Своя витрина, под блокировкой строки, одной транзакцией с чтением ответа
    const lock = fake.queries.find((q) => q.sql.includes("for update"));
    expect(lock?.parameters).toEqual([LISTING_ID, OWNER.vendorId]);
    expect(fake.log[0]).toBe("begin");
    expect(fake.log.at(-1)).toBe("commit");
    expect(fake.queries[0]?.parameters).toEqual(["vendor_user", OWNER.id, OWNER.vendorId]);
  });

  it("отклонённая — через черновик, одной транзакцией", async () => {
    const fake = db("rejected");
    await submitListing(fake.db, OWNER, LISTING_ID, "staging");
    expect(updates(fake)).toEqual(["draft", "review"]);
  });

  it("уже на проверке, опубликована или лид — 409 illegal_transition, ничего не меняется", async () => {
    for (const status of ["review", "active", "suspended", "lead"]) {
      const fake = db(status);
      const err = await rejection(() => submitListing(fake.db, OWNER, LISTING_ID, "staging"));
      expect([err.status, err.code]).toEqual([409, "illegal_transition"]);
      expect(updates(fake)).toEqual([]);
    }
  });

  it("чужая — 404; сотрудник площадки — 403 vendor_owner_required до базы", async () => {
    const missing = await rejection(() => submitListing(db(null).db, OWNER, LISTING_ID, "staging"));
    expect(missing.status).toBe(404);
    const fake = db("draft");
    const member = await rejection(() =>
      submitListing(fake.db, { ...OWNER, role: "member" }, LISTING_ID, "staging"),
    );
    expect([member.status, member.code]).toEqual([403, "vendor_owner_required"]);
    expect(fake.queries).toEqual([]);
  });
});
