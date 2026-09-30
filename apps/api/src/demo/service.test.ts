// Демо-данные без базы (fakeDb): повторный seed только читает, нехватка фото
// останавливает до публикации, reset убирает объекты раньше строк. С настоящим
// Postgres — test/integration/demo.test.ts
import { describe, expect, it, vi } from "vitest";
import { toApiError } from "../errors";
import { type ObjectStorage, StorageError } from "../storage/supabase";
import { fakeDb, type RecordedQuery } from "../testing/fake-db";
import { resetDemo, seedDemo } from "./service";
import { DEMO_VENUES } from "./venues";

const TODAY = "2026-10-03";

function spyStorage(remove: ObjectStorage["remove"] = async () => {}) {
  return {
    put: vi.fn<ObjectStorage["put"]>(async () => {}),
    remove: vi.fn<ObjectStorage["remove"]>(remove),
  };
}

const writes = (queries: readonly RecordedQuery[]) =>
  queries.filter((q) => /^\s*(insert|update|delete)\b/i.test(q.sql)).map((q) => q.sql);

interface ListingRow {
  status: string;
  version: number;
  photos: number;
}

/** База, где демо-залы уже заведены: вендор проверен, карточка в статусе listing, дни заняты */
function seededDb(listing: ListingRow) {
  const checked = new Date("2026-10-01T00:00:00Z");
  return fakeDb((query) => {
    if (query.sql.includes('from "app"."vendor_accounts"')) {
      return [
        {
          id: query.parameters[0],
          contract_signed_at: checked,
          stir_verified_at: checked,
          contacts_confirmed_at: checked,
          pd_consent_signed_at: checked,
        },
      ];
    }
    if (query.sql.includes('from "app"."availability"')) return [{ day: TODAY }];
    if (query.sql.includes('from "app"."listings"')) return [{ id: query.parameters[0], ...listing }];
    return [];
  });
}

describe("seedDemo", () => {
  it("всё уже заведено и опубликовано: только чтение — ни одной записи, хранилище не трогается", async () => {
    const { db, queries } = seededDb({ status: "active", version: 5, photos: 3 });
    const storage = spyStorage();

    const summary = await seedDemo({ db, storage, today: TODAY }, []);

    expect(summary).toEqual({
      mode: "seed",
      venues: 3,
      seeded: 3,
      active: 3,
      created: { vendors: 0, listings: 0, photos: 0, busyDays: 0 },
      published: 0,
    });
    expect(writes(queries)).toEqual([]);
    expect(storage.put).not.toHaveBeenCalled();
    // Каждый зал — по своим id
    for (const venue of DEMO_VENUES) {
      expect(queries.some((q) => q.parameters.includes(venue.vendorId))).toBe(true);
      expect(queries.some((q) => q.parameters.includes(venue.listingId))).toBe(true);
    }
  });

  it("один зал (venue): только его вендор и карточка, в итоге — один зал", async () => {
    const { db, queries } = seededDb({ status: "active", version: 5, photos: 3 });
    const [first, second] = DEMO_VENUES;

    const summary = await seedDemo({ db, storage: spyStorage(), today: TODAY }, [], 2);

    expect(summary).toMatchObject({ venues: 3, seeded: 1, active: 1, published: 0 });
    const ids = queries.flatMap((q) => q.parameters);
    expect(ids).toContain(second?.vendorId);
    expect(ids).toContain(second?.listingId);
    expect(ids).not.toContain(first?.vendorId);
    expect(ids).not.toContain(first?.listingId);
  });

  it("фото не хватает, а их не передали — 422 demo_photos_required до публикации", async () => {
    const { db, queries } = seededDb({ status: "draft", version: 2, photos: 1 });
    const storage = spyStorage();

    const err = await seedDemo({ db, storage, today: TODAY }, []).catch(toApiError);

    expect(err).toMatchObject({ status: 422, code: "demo_photos_required", details: [DEMO_VENUES[0]?.slug] });
    expect(writes(queries)).toEqual([]);
    expect(storage.put).not.toHaveBeenCalled();
  });
});

describe("resetDemo", () => {
  const KEYS = ["listings/a/1.webp", "listings/a/2.webp"];
  const PURGED = { vendors: 3, listings: 3, photos: 2, requests: 1, vendorUsers: 0 };

  function demoDb() {
    return fakeDb((query) => {
      if (query.sql.includes('from "app"."photos"')) return KEYS.map((storage_key) => ({ storage_key }));
      if (query.sql.includes("app.demo_purge()")) return [{ purged: PURGED }];
      return [];
    });
  }

  it("сначала объекты фото, потом строки — одной функцией базы, под актором system", async () => {
    const { db, queries } = demoDb();
    const storage = spyStorage();

    const summary = await resetDemo({ db, storage });

    expect(summary).toEqual({ mode: "reset", removed: PURGED, storageObjects: 2 });
    expect(storage.remove.mock.calls.map(([key]) => key)).toEqual(KEYS);
    // Фото ищутся по диапазону демо-вендоров, а не по списку id
    const select = queries.find((q) => q.sql.includes('from "app"."photos"'));
    expect(select?.sql).toContain('"l"."vendor_id"::text like $1');
    expect(select?.parameters).toEqual(["00000000-0000-4000-8000-de%"]);
    // Актор system: set_config('app.actor_kind', 'system') прямо перед функцией уборки
    const purge = queries.findIndex((q) => q.sql.includes("app.demo_purge()"));
    const actor = queries[purge - 1];
    expect(actor?.sql).toContain("set_config('app.actor_kind'");
    expect(actor?.parameters[0]).toBe("system");
  });

  it("хранилище не ответило — 503, строки в базе не тронуты (повтор reset доделает)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, log } = demoDb();
    const storage = spyStorage(async () => {
      throw new StorageError("unavailable", 0, "storage remove: нет ответа");
    });

    const err = await resetDemo({ db, storage }).catch(toApiError);

    expect(err).toMatchObject({ status: 503, code: "storage_unavailable" });
    expect(log.some((sql) => sql.includes("app.demo_purge()"))).toBe(false);
    vi.restoreAllMocks();
  });
});
