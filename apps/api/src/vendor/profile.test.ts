import { describe, expect, it } from "vitest";
import type { VendorActor } from "../db/actor";
import { ApiError } from "../errors";
import { fakeDb } from "../testing/fake-db";
import { getListing, getMe, parseLocale, setLocale } from "./profile";

const ACTOR: VendorActor = {
  kind: "vendor_user",
  id: "aaaaaaaa-0000-0000-0000-000000000011",
  vendorId: "aaaaaaaa-0000-0000-0000-000000000001",
};
const LISTING_ID = "aaaaaaaa-0000-0000-0000-000000000101";
const KEY = `listings/${LISTING_ID}/0b0c0d0e-0000-4000-8000-000000000001.webp`;

async function rejection(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("ожидался отказ");
}

const meRow = {
  id: ACTOR.id,
  locale: "uz",
  full_name: "Manager",
  vendor_id: ACTOR.vendorId,
  public_code: "V101",
  legal_name: "Test LLC",
};

describe("профиль", () => {
  it("язык — только ru или uz", () => {
    expect(parseLocale({ locale: "ru" })).toBe("ru");
    for (const body of [{}, { locale: "en" }, null, "uz"]) {
      expect(() => parseLocale(body)).toThrow(ApiError);
    }
  });

  it("GET /vendor/me: пользователь, вендор, листинги вендора сессии", async () => {
    const fake = fakeDb((q) => {
      if (q.sql.includes('from "app"."vendor_users"')) return [meRow];
      if (q.sql.includes('from "app"."listings"'))
        return [{ id: LISTING_ID, name: "Hall", status: "active" }];
      return [];
    });
    expect(await getMe(fake.db, ACTOR)).toEqual({
      user: { id: ACTOR.id, locale: "uz", fullName: "Manager" },
      vendor: { id: ACTOR.vendorId, code: "V101", name: "Test LLC" },
      listings: [{ id: LISTING_ID, name: "Hall", status: "active" }],
    });
    const listings = fake.queries.find((q) => q.sql.includes('from "app"."listings"'));
    expect(listings?.parameters).toEqual([ACTOR.vendorId]);
  });

  it("смена языка — только своей учётки", async () => {
    const fake = fakeDb((q) => (q.sql.includes('from "app"."vendor_users"') ? [meRow] : []));
    await setLocale(fake.db, ACTOR, "ru");
    const update = fake.queries.find((q) => q.sql.startsWith("update"));
    expect(update?.sql).toBe('update "app"."vendor_users" set "locale" = $1 where "id" = $2');
    expect(update?.parameters).toEqual(["ru", ACTOR.id]);
  });
});

describe("getListing", () => {
  const listing = {
    id: LISTING_ID,
    slug: "test-hall",
    name: "Test Hall",
    status: "draft",
    status_reason: null,
    category_code: "hall",
    district_code: "yunusobod",
    address_ru: "Адрес",
    address_uz: null,
    description_ru: "Описание",
    description_uz: "Tavsif",
    price_from_uzs: "150000",
    price_unit: "per_guest",
    cap_min: 50,
    cap_max: 300,
    blockers: ["photos", "contract"],
    phone: "+998000000999",
  };

  it("своя площадка: цены числом, фото — адреса воркера media окружения", async () => {
    const fake = fakeDb((q) => {
      if (q.sql.includes('from "app"."listings"')) return [listing];
      if (q.sql.includes("listing_packages"))
        return [
          {
            kind: "weekday",
            name_ru: "Будни",
            name_uz: "Ish kuni",
            price_uzs: "150000",
            price_unit: "per_guest",
          },
        ];
      if (q.sql.includes("app.photos") || q.sql.includes('"app"."photos"'))
        return [
          { id: "p1", storage_key: KEY, width: 1600, height: 1200, moderation: "pending", is_cover: true },
        ];
      return [];
    });
    const result = await getListing(fake.db, ACTOR, LISTING_ID, "staging");
    expect(result).toMatchObject({
      status: "draft",
      priceFromUzs: 150_000,
      address: { ru: "Адрес", uz: "" },
      packages: [
        { kind: "weekday", name: { ru: "Будни", uz: "Ish kuni" }, priceUzs: 150_000, priceUnit: "per_guest" },
      ],
      phone: "+998000000999",
      blockers: ["photos", "contract"],
    });
    expect(result.photos).toEqual([
      {
        id: "p1",
        width: 1600,
        height: 1200,
        moderation: "pending",
        isCover: true,
        src: `https://media-staging.bayramm.uz/640/${KEY}`,
        srcSet: [320, 640, 960].map((w) => `https://media-staging.bayramm.uz/${w}/${KEY} ${w}w`).join(", "),
      },
    ]);
    const main = fake.queries.find((q) => q.sql.includes('from "app"."listings"'));
    expect(main?.sql).toContain("pii.read_listing_phone(id)");
    expect(main?.parameters).toEqual([LISTING_ID, ACTOR.vendorId]);
    const photos = fake.queries.find((q) => q.sql.includes('"app"."photos"'));
    expect(photos?.sql).toContain('"deleted_at" is null');
  });

  it("чужая — 404, фото и пакеты не читаются", async () => {
    const fake = fakeDb(() => []);
    expect((await rejection(() => getListing(fake.db, ACTOR, LISTING_ID, "production"))).status).toBe(404);
    expect(fake.queries.some((q) => q.sql.includes("photos"))).toBe(false);
  });
});
