// Каталог без базы: под каким актором читается, порядок «занятые в конце» при
// любой сортировке, продолжение страницы по курсору, сборка карточки.
// С настоящим Postgres — test/integration/client-api.test.ts
import type { CatalogSort } from "@bayramm/shared/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type RecordedQuery } from "../testing/fake-db";
import { decodeCursor, encodeCursor, parseCatalogQuery } from "./query";
import { getConsentTexts, getDictionaries, getListingDetail, listCatalog } from "./service";

const ID = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;

function cardRow(n: number, patch: Record<string, unknown> = {}) {
  return {
    id: ID(n),
    slug: `hall-${n}`,
    name: `Hall ${n}`,
    category_code: "hall",
    district_code: "chilonzor",
    price_from_uzs: String(100_000 * n),
    price_unit: "per_guest",
    cap_min: 50,
    cap_max: 100 * n,
    cover_key: `listings/${ID(n)}/cover.webp`,
    cover_width: 1600,
    cover_height: 1200,
    photo_count: 3,
    busy: false,
    sort_key: String(100_000 * n),
    ...patch,
  };
}

const isCatalog = (q: RecordedQuery) => q.sql.includes('from "app"."listings" as "l"');

afterEach(() => vi.restoreAllMocks());

describe("listCatalog", () => {
  it("читается под гостем (актор не задан), в одной транзакции", async () => {
    const fake = fakeDb();
    await listCatalog(fake.db, parseCatalogQuery({}));
    expect(fake.log[0]).toBe("begin");
    expect(fake.queries[0]?.parameters).toEqual(["", "", ""]);
    expect(fake.log.at(-1)).toBe("commit");
  });

  it.each<[CatalogSort, string]>([
    ["price_asc", "l.price_from_uzs"],
    ["price_desc", "(-l.price_from_uzs)"],
    ["capacity_desc", "(-l.cap_max)::bigint"],
  ])("%s: занятые в конце, затем ключ сортировки, затем id", async (sort, key) => {
    const fake = fakeDb();
    await listCatalog(fake.db, parseCatalogQuery({ sort: [sort], date: ["2026-10-03"] }));
    const query = fake.queries.find(isCatalog);
    expect(query?.sql).toContain(`order by (av.listing_id is not null), ${key}, "l"."id" limit`);
    expect(query?.sql).toContain(`${key} as "sort_key"`);
  });

  it("только публичное: активный листинг включённой категории, цена, вместимость, ≥ 3 одобренных фото", async () => {
    const fake = fakeDb();
    await listCatalog(fake.db, parseCatalogQuery({}));
    const query = fake.queries.find(isCatalog);
    expect(query?.sql).toContain('"cat"."enabled" = $1');
    expect(query?.sql).toContain('"l"."status" = $');
    expect(query?.sql).toContain('"l"."price_from_uzs" is not null and "l"."cap_max" is not null');
    expect(query?.sql).toContain('"cv"."photo_count" >= $');
    expect(query?.sql).toContain('"p"."deleted_at" is null and "p"."status" = $2 and "p"."moderation" = $3');
    expect(query?.parameters).toEqual(expect.arrayContaining([true, "active", "ready", "approved", 3]));
    // Ни продвижения, ни рейтинга в запросе нет
    expect(query?.sql).not.toMatch(/promo|premium|rating|paid/);
  });

  it("guests отсекает по cap_max; date не отсекает, а только помечает занятых", async () => {
    const fake = fakeDb();
    await listCatalog(fake.db, parseCatalogQuery({ guests: ["300"], date: ["2026-10-03"] }));
    const query = fake.queries.find(isCatalog);
    expect(query?.sql).toContain('"l"."cap_max" >= $');
    expect(query?.sql).toContain('left join "app"."availability" as "av"');
    expect(query?.sql).toContain("av.day = $");
    expect(query?.parameters).toEqual(expect.arrayContaining([300, "2026-10-03"]));
    // В условиях отбора занятость не участвует — только в порядке
    const sql = query?.sql ?? "";
    const where = sql.slice(sql.indexOf('where "l"."status"'), sql.indexOf("order by (av."));
    expect(where).not.toContain("av");
  });

  it("limit + 1 строка: есть следующая страница — курсор с последней карточки страницы", async () => {
    const rows = [cardRow(1), cardRow(2), cardRow(3, { busy: true, sort_key: "300000" })];
    const fake = fakeDb((q) => (isCatalog(q) ? rows : []));
    const page = await listCatalog(fake.db, parseCatalogQuery({ limit: ["2"], date: ["2026-10-03"] }));

    expect(fake.queries.find(isCatalog)?.parameters.at(-1)).toBe(3);
    expect(page.items.map((i) => i.id)).toEqual([ID(1), ID(2)]);
    expect(page.nextCursor).not.toBeNull();
    expect(decodeCursor(page.nextCursor ?? "")).toEqual({
      sort: "price_asc",
      date: "2026-10-03",
      busy: false,
      key: 200_000,
      id: ID(2),
    });
  });

  it("последняя страница — nextCursor = null", async () => {
    const fake = fakeDb((q) => (isCatalog(q) ? [cardRow(1)] : []));
    const page = await listCatalog(fake.db, parseCatalogQuery({ limit: ["2"] }));
    expect(page).toMatchObject({ nextCursor: null });
    expect(page.items).toHaveLength(1);
  });

  it("курсор: строго после (занята, ключ, id) — значения параметрами", async () => {
    const fake = fakeDb();
    const cursor = encodeCursor({
      sort: "price_desc",
      date: "2026-10-03",
      busy: true,
      key: -500_000,
      id: ID(5),
    });
    await listCatalog(
      fake.db,
      parseCatalogQuery({ sort: ["price_desc"], date: ["2026-10-03"], cursor: [cursor] }),
    );
    const query = fake.queries.find(isCatalog);
    expect(query?.sql).toMatch(
      /\(\(av\.listing_id is not null\), \(-l\.price_from_uzs\), l\.id\) > \(\$\d+::boolean, \$\d+::bigint, \$\d+::uuid\)/,
    );
    expect(query?.parameters).toEqual(expect.arrayContaining([true, -500_000, ID(5)]));
    expect(query?.sql).not.toContain(ID(5));
  });

  it("карточка: числа из bigint, busyOnDate — null без даты", async () => {
    const fake = fakeDb((q) => (isCatalog(q) ? [cardRow(2, { busy: false })] : []));
    const page = await listCatalog(fake.db, parseCatalogQuery({}));
    expect(page.items[0]).toEqual({
      id: ID(2),
      slug: "hall-2",
      name: "Hall 2",
      categoryCode: "hall",
      districtCode: "chilonzor",
      priceFromUzs: 200_000,
      priceUnit: "per_guest",
      capMin: 50,
      capMax: 200,
      cover: { key: `listings/${ID(2)}/cover.webp`, width: 1600, height: 1200 },
      photoCount: 3,
      busyOnDate: null,
    });

    const dated = fakeDb((q) => (isCatalog(q) ? [cardRow(2, { busy: true })] : []));
    const withDate = await listCatalog(dated.db, parseCatalogQuery({ date: ["2026-10-03"] }));
    expect(withDate.items[0]?.busyOnDate).toBe(true);
  });
});

describe("getListingDetail", () => {
  it("нет такого опубликованного — null, дальше не читает", async () => {
    const fake = fakeDb();
    expect(await getListingDetail(fake.db, "nope", null, "2026-09-29")).toBeNull();
    expect(fake.queries.filter(isCatalog)).toHaveLength(1);
    expect(fake.queries.some((q) => q.sql.includes("listing_packages"))).toBe(false);
  });

  it("телефон — через pii.read_listing_phone; занятые даты — [сегодня, +180 дней)", async () => {
    const fake = fakeDb((q) => {
      if (isCatalog(q)) {
        return [
          {
            ...cardRow(1),
            description_ru: "Описание",
            description_uz: null,
            address_ru: "Адрес",
            address_uz: "Manzil",
            phone: "+998000000123",
          },
        ];
      }
      if (q.sql.includes("listing_packages")) {
        return [
          {
            kind: "weekday",
            name_ru: "Будни",
            name_uz: "Ish kuni",
            price_uzs: "150000",
            price_unit: "per_guest",
          },
        ];
      }
      if (q.sql.includes('from "app"."photos"')) {
        return [
          { storage_key: "a.webp", width: 10, height: 20 },
          { storage_key: "b.webp", width: null, height: null },
        ];
      }
      if (q.sql.includes('from "app"."availability"')) return [{ day: "2026-10-03" }];
      return [];
    });
    const detail = await getListingDetail(fake.db, "hall-1", null, "2026-09-29");

    expect(fake.queries.find(isCatalog)?.sql).toContain("pii.read_listing_phone(l.id)");
    expect(fake.queries.find((q) => q.sql.includes('from "app"."availability"'))?.parameters).toEqual([
      ID(1),
      "2026-09-29",
      "2027-03-28",
    ]);
    expect(detail).toMatchObject({
      id: ID(1),
      phone: "+998000000123",
      description: { ru: "Описание", uz: "" },
      address: { ru: "Адрес", uz: "Manzil" },
      packages: [
        { kind: "weekday", name: { ru: "Будни", uz: "Ish kuni" }, priceUzs: 150_000, priceUnit: "per_guest" },
      ],
      photos: [{ key: "a.webp", width: 10, height: 20 }],
      busyDates: ["2026-10-03"],
      busyOnDate: null,
    });
  });

  it("активный листинг без телефона — 404 и ошибка в лог (так быть не должно)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = fakeDb((q) =>
      isCatalog(q)
        ? [
            {
              ...cardRow(1),
              description_ru: "",
              description_uz: "",
              address_ru: "",
              address_uz: "",
              phone: null,
            },
          ]
        : [],
    );
    expect(await getListingDetail(fake.db, "hall-1", null, "2026-09-29")).toBeNull();
    expect(error).toHaveBeenCalledWith("catalog: active listing without public phone", { listingId: ID(1) });
  });
});

describe("справочники и тексты согласий", () => {
  it("справочники: только включённые категории, названия на двух языках", async () => {
    const fake = fakeDb((q) => {
      if (q.sql.includes("categories")) return [{ code: "hall", name_ru: "Площадка", name_uz: "Maydon" }];
      if (q.sql.includes("districts"))
        return [{ code: "chilonzor", name_ru: "Чиланзар", name_uz: "Chilonzor" }];
      if (q.sql.includes("occasions")) return [{ code: "toy", name_ru: "Свадьба", name_uz: "Toʻy" }];
      return [];
    });
    expect(await getDictionaries(fake.db)).toEqual({
      categories: [{ code: "hall", name: { ru: "Площадка", uz: "Maydon" } }],
      districts: [{ code: "chilonzor", name: { ru: "Чиланзар", uz: "Chilonzor" } }],
      occasions: [{ code: "toy", name: { ru: "Свадьба", uz: "Toʻy" } }],
    });
    expect(fake.queries.find((q) => q.sql.includes("categories"))?.sql).toContain('"enabled" = $1');
  });

  it("тексты: три цели клиента, действующие, старшая версия на цель и язык", async () => {
    const fake = fakeDb();
    await getConsentTexts(fake.db, "uz");
    const query = fake.queries.find((q) => q.sql.includes("consent_texts"));
    expect(query?.sql).toContain('select distinct on ("t"."purpose", "t"."locale")');
    expect(query?.sql).toContain('"t"."retired_at" is null or "t"."retired_at" > now()');
    expect(query?.sql).toContain('order by "t"."purpose", "t"."locale", "t"."version" desc');
    expect(query?.parameters).toEqual(
      expect.arrayContaining(["client_service", "request_transfer", "bot_notifications", "uz"]),
    );
    expect(query?.parameters).not.toContain("vendor_contact");
  });
});
