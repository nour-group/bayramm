import { describe, expect, it } from "vitest";
import type { VendorActor } from "../db/actor";
import { ApiError } from "../errors";
import { fakeDb } from "../testing/fake-db";
import { getListing, getMe, parseLocale, setLocale } from "./profile";

const ACTOR: VendorActor = {
  kind: "vendor_user",
  id: "aaaaaaaa-0000-0000-0000-000000000011",
  vendorId: "aaaaaaaa-0000-0000-0000-000000000001",
  role: "owner",
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
  role: "owner",
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

  /** Запрос значков: у него «count(*)» подзапросами по услугам, фото и предложениям витрины */
  const isAttention = (q: { sql: string }) => q.sql.includes("from app.listing_services s");

  const meDb = (user: Record<string, unknown>, counts: Record<string, unknown> = {}) =>
    fakeDb((q) => {
      if (q.sql.includes('from "app"."vendor_users"')) return [user];
      if (isAttention(q)) return [{ id: LISTING_ID, services: 0, photos: 0, proposals: 0, ...counts }];
      if (q.sql.includes('from "app"."listings"'))
        return [{ id: LISTING_ID, name: "Hall", status: "active", category_code: "hall" }];
      return [];
    });

  it("GET /vendor/me: пользователь, вендор, листинги вендора сессии", async () => {
    const fake = meDb(meRow);
    expect(await getMe(fake.db, ACTOR)).toEqual({
      user: { id: ACTOR.id, locale: "uz", fullName: "Manager", role: "owner" },
      vendor: { id: ACTOR.vendorId, code: "V101", name: "Test LLC" },
      listings: [
        {
          id: LISTING_ID,
          name: "Hall",
          status: "active",
          categoryCode: "hall",
          attention: { services: 0, photos: 0, proposals: 0 },
        },
      ],
    });
    const listings = fake.queries.find((q) => q.sql.includes('from "app"."listings"') && !isAttention(q));
    expect(listings?.parameters).toEqual([ACTOR.vendorId]);
  });

  it("GET /vendor/me: владелец — числа «ждёт действия» по каждой витрине, считает база", async () => {
    const other = "aaaaaaaa-0000-0000-0000-000000000102";
    const fake = fakeDb((q) => {
      if (q.sql.includes('from "app"."vendor_users"')) return [meRow];
      if (isAttention(q))
        return [
          // Драйвер отдаёт int4 числом, но bigint и строку тоже читаем как число
          { id: LISTING_ID, services: 2, photos: "1", proposals: 1 },
          { id: other, services: 0, photos: 0, proposals: 0 },
        ];
      if (q.sql.includes('from "app"."listings"'))
        return [
          { id: LISTING_ID, name: "Hall", status: "active", category_code: "hall" },
          { id: other, name: "Cars", status: "draft", category_code: "car" },
        ];
      return [];
    });
    const me = await getMe(fake.db, ACTOR);
    expect(me.listings.map((l) => l.attention)).toEqual([
      { services: 2, photos: 1, proposals: 1 },
      { services: 0, photos: 0, proposals: 0 },
    ]);
    const counted = fake.queries.find(isAttention);
    // Только свой вендор; правила — отклонённые услуги, отклонённые фото в кабинете, последнее
    // предложение партнёра отклонено
    expect(counted?.parameters).toEqual([ACTOR.vendorId]);
    expect(counted?.sql).toContain("s.status = 'rejected'");
    expect(counted?.sql).toContain("p.moderation = 'declined' and p.deleted_at is null");
    expect(counted?.sql).toContain("order by r.submitted_at desc, r.id limit 1");
    expect(counted?.sql).toContain("last.status = 'declined'");
    expect(counted?.sql).toContain("from app.vendor_users u where u.id = last.submitted_by");
  });

  it("GET /vendor/me: сотрудник площадки — нули, и база для них ничего не считает", async () => {
    const fake = meDb({ ...meRow, role: "member" }, { services: 3, photos: 3, proposals: 1 });
    const me = await getMe(fake.db, { ...ACTOR, role: "member" });
    expect(me.user.role).toBe("member");
    expect(me.listings[0]?.attention).toEqual({ services: 0, photos: 0, proposals: 0 });
    expect(fake.queries.some(isAttention)).toBe(false);
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
    attributes: { kitchen: "own", parking_spaces: "много" },
    video_links: [],
    parallel_capacity: 1,
    blockers: ["photos", "contract"],
    phone: "+998000000999",
    min_photos: 3,
    max_photos: 10,
  };

  it("своя площадка: цены числом, фото — адреса воркера media окружения", async () => {
    const fake = fakeDb((q) => {
      if (q.sql.includes('from "app"."listings"')) return [listing];
      if (q.sql.includes('from "app"."listing_services"'))
        return [
          {
            id: "s1",
            listing_id: LISTING_ID,
            category_code: "hall",
            service_type: "banquet_weekday",
            status: "active",
            name_ru: null,
            name_uz: null,
            price_uzs: "150000",
            price_unit: "per_guest",
            min_qty: null,
            lead_days: null,
            includes_ru: null,
            includes_uz: null,
            options: [],
            proposal: null,
            proposal_at: null,
            decision: "approved",
            decision_reason: null,
            decided_at: new Date("2026-09-30T10:00:00Z"),
            submitted_at: null,
            sort: 0,
            updated_at: new Date("2026-09-30T10:00:00Z"),
          },
        ];
      if (q.sql.includes("app.photos") || q.sql.includes('"app"."photos"'))
        return [
          {
            id: "p1",
            storage_key: KEY,
            width: 1600,
            height: 1200,
            moderation: "pending",
            moderation_reason: null,
            is_cover: true,
          },
          {
            id: "p2",
            storage_key: KEY,
            width: 1600,
            height: 1200,
            moderation: "declined",
            moderation_reason: "На фото виден человек",
            is_cover: false,
          },
          // Причина осталась от прошлого отказа, а фото уже одобрено — партнёру её не показываем
          {
            id: "p3",
            storage_key: KEY,
            width: 1600,
            height: 1200,
            moderation: "approved",
            moderation_reason: "Прошлый отказ",
            is_cover: false,
          },
        ];
      return [];
    });
    const result = await getListing(fake.db, ACTOR, LISTING_ID, "staging");
    expect(result).toMatchObject({
      status: "draft",
      priceFromUzs: 150_000,
      address: { ru: "Адрес", uz: "" },
      // Поля витрины — только прошедшие проверку конфигурации
      attributes: { kitchen: "own" },
      missingAttributes: [],
      services: [
        { id: "s1", type: "banquet_weekday", status: "active", priceUzs: 150_000, customName: false },
      ],
      phone: "+998000000999",
      blockers: ["photos", "contract"],
      photoLimits: { min: 3, max: 10 },
    });
    expect(result).not.toHaveProperty("packages");
    const variants = {
      src: `https://media-staging.bayramm.uz/640/${KEY}`,
      srcSet: [320, 640, 960].map((w) => `https://media-staging.bayramm.uz/${w}/${KEY} ${w}w`).join(", "),
    };
    expect(result.photos).toEqual([
      {
        id: "p1",
        width: 1600,
        height: 1200,
        moderation: "pending",
        declineReason: null,
        isCover: true,
        ...variants,
      },
      {
        id: "p2",
        width: 1600,
        height: 1200,
        moderation: "declined",
        declineReason: "На фото виден человек",
        isCover: false,
        ...variants,
      },
      {
        id: "p3",
        width: 1600,
        height: 1200,
        moderation: "approved",
        declineReason: null,
        isCover: false,
        ...variants,
      },
    ]);
    const main = fake.queries.find((q) => q.sql.includes('from "app"."listings"'));
    expect(main?.sql).toContain('pii.read_listing_phone("id")');
    expect(main?.parameters).toEqual([LISTING_ID, ACTOR.vendorId]);
    const photos = fake.queries.find((q) => q.sql.includes('"app"."photos"'));
    expect(photos?.sql).toContain('"deleted_at" is null');
  });

  it("чужая — 404, фото и услуги не читаются", async () => {
    const fake = fakeDb(() => []);
    expect((await rejection(() => getListing(fake.db, ACTOR, LISTING_ID, "production"))).status).toBe(404);
    expect(fake.queries.some((q) => q.sql.includes('"app"."photos"'))).toBe(false);
  });
});
