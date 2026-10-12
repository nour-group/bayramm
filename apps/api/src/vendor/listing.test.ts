// PATCH /vendor/listings/:id без базы: выбор пути (сразу / предложением), проверки полей,
// версия и роль. С настоящей базой (триггеры, журнал, RLS) — test/integration/vendor.test.ts
// и supabase/tests/28_vendor_listing_facts.test.sql
import { describe, expect, it } from "vitest";
import type { VendorActor } from "../db/actor";
import { ApiError } from "../errors";
import { fakeDb, type RecordedQuery } from "../testing/fake-db";
import { patchListing } from "./listing";

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

interface Setup {
  /** Статус витрины; null — чужая или нет такой */
  readonly status: string | null;
  readonly category?: string;
  readonly version?: number;
  readonly capMin?: number | null;
  readonly capMax?: number | null;
  /** Районы справочника */
  readonly districts?: readonly string[];
}

function db(setup: Setup) {
  const {
    status,
    category = "hall",
    version = 3,
    capMin = 50,
    capMax = 300,
    districts = ["sergeli", "chilonzor"],
  } = setup;
  const row = {
    id: LISTING_ID,
    version,
    status,
    category_code: category,
    name: "Lola zali",
    description_ru: "Зал на 300 гостей",
    description_uz: "300 mehmonga zal",
    attributes: { halls_count: 2 },
    video_links: [],
    cap_min: capMin,
    cap_max: capMax,
    district_code: "chilonzor",
    address_ru: null,
    address_uz: null,
  };
  return fakeDb((q: RecordedQuery) => {
    if (q.sql.includes("for update")) return status === null ? [] : [row];
    if (q.sql.includes('from "app"."districts"'))
      return districts.includes(String(q.parameters[0])) ? [{ code: q.parameters[0] }] : [];
    if (q.sql.startsWith('insert into "app"."listing_revisions"'))
      return [
        {
          id: "99999999-0000-0000-0000-000000000001",
          status: "pending",
          payload: q.parameters[1],
          submitted_at: new Date("2026-10-12T08:00:00Z"),
          decided_at: null,
          decision_reason: null,
          by_team: false,
        },
      ];
    // Чтение витрины после сохранения (как GET)
    if (q.sql.includes('from "app"."listings"'))
      return [
        {
          ...row,
          slug: "lola-zali",
          status_reason: null,
          price_from_uzs: "150000",
          price_unit: "per_guest",
          parallel_capacity: 1,
          blockers: [],
          review_blockers: [],
          phone: "+998000000998",
          min_photos: 3,
          max_photos: 10,
        },
      ];
    return [];
  });
}

const listingUpdates = (fake: ReturnType<typeof db>) =>
  fake.queries.filter((q) => q.sql.startsWith('update "app"."listings"'));
const revisionInserts = (fake: ReturnType<typeof db>) =>
  fake.queries.filter((q) => q.sql.startsWith('insert into "app"."listing_revisions"'));

describe("PATCH /vendor/listings/:id: витрины нет на сайте — сохраняется сразу", () => {
  for (const status of ["draft", "rejected", "lead"]) {
    it(`${status}: вместимость, район и адрес — столбцами карточки, без предложения`, async () => {
      const fake = db({ status });
      const saved = await patchListing(
        fake.db,
        OWNER,
        LISTING_ID,
        { version: 3, capMin: 80, capMax: 350, districtCode: "sergeli", addressRu: " ул. Навои, 1 " },
        "staging",
      );
      expect(saved.sentForModeration).toEqual([]);
      expect(saved.listing.id).toBe(LISTING_ID);
      expect(revisionInserts(fake)).toEqual([]);
      const [update] = listingUpdates(fake);
      expect(update?.sql).toMatch(
        /"address_ru" = \$1.*"district_code" = \$2.*"cap_min" = \$3.*"cap_max" = \$4/s,
      );
      expect(update?.parameters.slice(0, 4)).toEqual(["ул. Навои, 1", "sergeli", 80, 350]);
      // Версия — условие записи; одной транзакцией с чтением ответа
      expect(update?.sql).toContain('"version" = $');
      expect(fake.log[0]).toBe("begin");
      expect(fake.log.at(-1)).toBe("commit");
    });
  }

  it("в запись идёт только изменённое: совпадающее с карточкой не пишется", async () => {
    const fake = db({ status: "draft" });
    await patchListing(fake.db, OWNER, LISTING_ID, { version: 3, name: "Lola zali", capMax: 400 }, "staging");
    const [update] = listingUpdates(fake);
    expect(update?.sql).toContain('"cap_max"');
    expect(update?.sql).not.toContain('"name"');
    expect(update?.sql).not.toContain('"cap_min"');
  });

  it("поля витрины сливаются с текущими, пустой текст — NULL", async () => {
    const fake = db({ status: "draft" });
    await patchListing(
      fake.db,
      OWNER,
      LISTING_ID,
      { version: 3, attributes: { stage: true }, descriptionUz: "", addressUz: "Navoiy k., 1" },
      "staging",
    );
    const [update] = listingUpdates(fake);
    expect(update?.sql).toContain('"attributes"');
    expect(update?.parameters).toContain(JSON.stringify({ halls_count: 2, stage: true }));
    expect(update?.parameters).toContain(null);
    expect(update?.parameters).toContain("Navoiy k., 1");
  });

  it("ничего не изменилось — 422 no_changes, записи нет", async () => {
    const fake = db({ status: "draft" });
    const err = await rejection(() =>
      patchListing(fake.db, OWNER, LISTING_ID, { version: 3, name: "Lola zali", capMin: 50 }, "staging"),
    );
    expect([err.status, err.code]).toEqual([422, "no_changes"]);
    expect(listingUpdates(fake)).toEqual([]);
  });
});

describe("PATCH /vendor/listings/:id: витрина на проверке, на сайте или приостановлена — предложением", () => {
  for (const status of ["review", "active", "suspended"]) {
    it(`${status}: изменённые поля — в предложение, карточка не пишется`, async () => {
      const fake = db({ status });
      const saved = await patchListing(
        fake.db,
        OWNER,
        LISTING_ID,
        { version: 3, capMin: 80, capMax: 350, name: "Lola zali", addressRu: "ул. Навои, 1" },
        "staging",
      );
      expect(listingUpdates(fake)).toEqual([]);
      const [insert] = revisionInserts(fake);
      // Только изменённое (название совпало), основа — версия, которую видел партнёр
      expect(insert?.parameters[1]).toEqual({
        cap_min: 80,
        cap_max: 350,
        address_ru: "ул. Навои, 1",
      });
      expect(insert?.parameters[2]).toBe(3);
      expect(saved.sentForModeration).toEqual(["capacity", "addressRu"]);
    });
  }

  it("районы и описание — тоже предложением; вместимость двумя ключами — одна строка", async () => {
    const fake = db({ status: "active" });
    const saved = await patchListing(
      fake.db,
      OWNER,
      LISTING_ID,
      { version: 3, districtCode: "sergeli", descriptionRu: "Новое описание", capMax: 320 },
      "staging",
    );
    expect(saved.sentForModeration).toEqual(["descriptionRu", "capacity", "districtCode"]);
  });

  it("описание на проверке не очистить — без него витрина не готова", async () => {
    const fake = db({ status: "active" });
    const err = await rejection(() =>
      patchListing(fake.db, OWNER, LISTING_ID, { version: 3, descriptionUz: "" }, "staging"),
    );
    expect([err.status, err.code, err.details]).toEqual([422, "invalid_input", ["descriptionUz"]]);
    expect(revisionInserts(fake)).toEqual([]);
  });

  it("ничего не изменилось — 422 no_changes, предложения нет", async () => {
    const fake = db({ status: "active" });
    const err = await rejection(() =>
      patchListing(fake.db, OWNER, LISTING_ID, { version: 3, capMax: 300 }, "staging"),
    );
    expect([err.status, err.code]).toEqual([422, "no_changes"]);
    expect(revisionInserts(fake)).toEqual([]);
  });
});

describe("PATCH /vendor/listings/:id: проверки", () => {
  it("сотрудник площадки — 403 vendor_owner_required до базы", async () => {
    const fake = db({ status: "draft" });
    const err = await rejection(() =>
      patchListing(fake.db, { ...OWNER, role: "member" }, LISTING_ID, { version: 3, capMax: 350 }, "staging"),
    );
    expect([err.status, err.code]).toEqual([403, "vendor_owner_required"]);
    expect(fake.queries).toEqual([]);
  });

  it("«до» меньше «от» — 422 по capMax, без базы", async () => {
    const fake = db({ status: "draft" });
    const err = await rejection(() =>
      patchListing(fake.db, OWNER, LISTING_ID, { version: 3, capMin: 300, capMax: 100 }, "staging"),
    );
    expect([err.status, err.code, err.details]).toEqual([422, "invalid_input", ["capMax"]]);
    expect(fake.queries).toEqual([]);
  });

  it("«до» меньше «от», которое уже в карточке, — тоже; и «от» больше «до» карточки", async () => {
    for (const body of [{ capMax: 40 }, { capMin: 400 }]) {
      const fake = db({ status: "draft" });
      const err = await rejection(() =>
        patchListing(fake.db, OWNER, LISTING_ID, { version: 3, ...body }, "staging"),
      );
      expect([err.code, err.details]).toEqual(["invalid_input", ["capMax"]]);
      expect(listingUpdates(fake)).toEqual([]);
    }
  });

  it("границы: 0 и 5001 — ошибка поля; не число — тоже", async () => {
    for (const body of [{ capMax: 0 }, { capMax: 5001 }, { capMin: "50" }, { capMax: 12.5 }]) {
      const fake = db({ status: "draft" });
      const err = await rejection(() =>
        patchListing(fake.db, OWNER, LISTING_ID, { version: 3, ...body }, "staging"),
      );
      expect(err.code).toBe("invalid_input");
    }
  });

  it("вместимость у категории без guest_capacity и район у категории без district — 422", async () => {
    const car = db({ status: "draft", category: "car" });
    const err = await rejection(() =>
      patchListing(
        car.db,
        OWNER,
        LISTING_ID,
        { version: 3, capMin: 1, capMax: 5, districtCode: "sergeli" },
        "staging",
      ),
    );
    expect([err.code, err.details]).toEqual(["invalid_input", ["capMin", "capMax", "districtCode"]]);
    expect(listingUpdates(car)).toEqual([]);

    // Студия: район есть, вместимости нет
    const studio = db({ status: "draft", category: "studio" });
    const only = await rejection(() =>
      patchListing(
        studio.db,
        OWNER,
        LISTING_ID,
        { version: 3, capMax: 5, districtCode: "sergeli" },
        "staging",
      ),
    );
    expect(only.details).toEqual(["capMax"]);
  });

  it("неизвестный район — 422 по districtCode; убрать район и вместимость нельзя", async () => {
    const unknown = await rejection(() =>
      patchListing(
        db({ status: "draft" }).db,
        OWNER,
        LISTING_ID,
        { version: 3, districtCode: "atlantida" },
        "staging",
      ),
    );
    expect([unknown.code, unknown.details]).toEqual(["invalid_input", ["districtCode"]]);
    for (const body of [{ districtCode: null }, { districtCode: "" }, { capMax: null }, { capMin: null }]) {
      const fake = db({ status: "draft" });
      const err = await rejection(() =>
        patchListing(fake.db, OWNER, LISTING_ID, { version: 3, ...body }, "staging"),
      );
      expect(err.code).toBe("invalid_input");
      expect(fake.queries).toEqual([]);
    }
  });

  it("адрес страницы, категория, цена и чужие ключи — 422 по имени ключа", async () => {
    const fake = db({ status: "draft" });
    const err = await rejection(() =>
      patchListing(
        fake.db,
        OWNER,
        LISTING_ID,
        { version: 3, slug: "x", categoryCode: "car", priceFromUzs: 1, status: "active" },
        "staging",
      ),
    );
    expect(err.details).toEqual(["slug", "categoryCode", "priceFromUzs", "status"]);
    expect(fake.queries).toEqual([]);
  });

  it("поля витрины — по категории: неизвестное поле и неверное значение", async () => {
    const fake = db({ status: "draft" });
    const err = await rejection(() =>
      patchListing(
        fake.db,
        OWNER,
        LISTING_ID,
        { version: 3, attributes: { nonsense: 1, halls_count: -4 } },
        "staging",
      ),
    );
    expect(err.code).toBe("invalid_input");
    expect(err.details?.some((d) => d.startsWith("attributes"))).toBe(true);
  });

  it("версия обязательна; устарела — 409 version_conflict, записи нет", async () => {
    const missing = await rejection(() =>
      patchListing(db({ status: "draft" }).db, OWNER, LISTING_ID, { capMax: 350 }, "staging"),
    );
    expect([missing.code, missing.details]).toEqual(["invalid_input", ["version"]]);

    const fake = db({ status: "draft", version: 5 });
    const err = await rejection(() =>
      patchListing(fake.db, OWNER, LISTING_ID, { version: 3, capMax: 350 }, "staging"),
    );
    expect([err.status, err.code]).toEqual([409, "version_conflict"]);
    expect(listingUpdates(fake)).toEqual([]);
    expect(revisionInserts(fake)).toEqual([]);
  });

  it("чужая или несуществующая витрина — 404; тело не объект — 400", async () => {
    const missing = await rejection(() =>
      patchListing(db({ status: null }).db, OWNER, LISTING_ID, { version: 3, capMax: 350 }, "staging"),
    );
    expect(missing.status).toBe(404);
    const bad = await rejection(() =>
      patchListing(db({ status: "draft" }).db, OWNER, LISTING_ID, [], "staging"),
    );
    expect([bad.status, bad.code]).toEqual([400, "invalid_request"]);
  });

  it("витрина — своя: блокировка строки по id и вендору актора", async () => {
    const fake = db({ status: "draft" });
    await patchListing(fake.db, OWNER, LISTING_ID, { version: 3, capMax: 350 }, "staging");
    const lock = fake.queries.find((q) => q.sql.includes("for update"));
    expect(lock?.parameters).toEqual([LISTING_ID, OWNER.vendorId]);
    expect(fake.queries[0]?.parameters).toEqual(["vendor_user", OWNER.id, OWNER.vendorId]);
  });
});
