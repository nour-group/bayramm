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

  const PER_GUEST_OR_EVENT =
    "(case when l.price_unit = 'per_event' and l.cap_max is not null then (l.price_from_uzs + l.cap_max - 1) / l.cap_max else l.price_from_uzs end)";
  // Загрузка выдачи на дату — одним запросом на категорию (app.catalog_day_load), не на строку
  const BUSY = "coalesce(dl.load = 'busy', false)";

  it.each<[CatalogSort, string]>([
    ["price_asc", PER_GUEST_OR_EVENT],
    ["price_desc", `(-${PER_GUEST_OR_EVENT})`],
    ["capacity_desc", "(-coalesce(l.cap_max, 0))::bigint"],
  ])("%s: занятые целиком в конце, затем ключ сортировки, затем id", async (sort, key) => {
    const fake = fakeDb();
    await listCatalog(fake.db, parseCatalogQuery({ sort: [sort], date: ["2026-10-03"] }));
    const query = fake.queries.find(isCatalog);
    const sql = query?.sql ?? "";
    const order = sql.slice(sql.lastIndexOf("order by"));
    expect(order).toContain(`order by ${BUSY}, ${key}, "l"."id" limit`);
    expect(sql).toContain(`${key} as "sort_key"`);
    expect(sql).toMatch(/left join app\.catalog_day_load\(\$\d+, \$\d+::date\) as "dl" on "dl"\."listing_id" = "l"\."id"/);
    expect(sql).not.toContain("listing_day_load");
    expect(query?.parameters).toEqual(expect.arrayContaining(["hall", "2026-10-03"]));
  });

  it("без даты занятость не считается", async () => {
    const fake = fakeDb();
    await listCatalog(fake.db, parseCatalogQuery({}));
    const sql = fake.queries.find(isCatalog)?.sql ?? "";
    expect(sql).not.toContain("day_load");
    expect(sql).toContain("order by false::boolean,");
  });

  it("с числом гостей цена сравнивается как сумма на них: за гостя × гости, остальное как есть", async () => {
    const fake = fakeDb();
    await listCatalog(fake.db, parseCatalogQuery({ guests: ["300"] }));
    const query = fake.queries.find(isCatalog);
    expect(query?.sql).toMatch(
      /order by false::boolean, \(case when l\.price_unit = 'per_guest' then l\.price_from_uzs \* \$(\d+)::bigint else l\.price_from_uzs end\), "l"\."id"/,
    );
    const placeholder = Number(/l\.price_from_uzs \* \$(\d+)::bigint/.exec(query?.sql ?? "")?.[1]);
    expect(query?.parameters[placeholder - 1]).toBe(300);
  });

  it("курсор страницы с гостями помнит их число", async () => {
    const rows = [cardRow(1), cardRow(2)];
    const fake = fakeDb((q) => (isCatalog(q) ? rows : []));
    const page = await listCatalog(fake.db, parseCatalogQuery({ limit: ["1"], guests: ["120"] }));
    expect(decodeCursor(page.nextCursor ?? "")).toMatchObject({ guests: 120, id: ID(1) });
  });

  it("только публичное: активная витрина включённой категории, цена, вместимость категории, минимум фото", async () => {
    const fake = fakeDb();
    await listCatalog(fake.db, parseCatalogQuery({}));
    const query = fake.queries.find(isCatalog);
    expect(query?.sql).toContain('"cat"."enabled" = $1');
    expect(query?.sql).toContain('"l"."status" = $');
    expect(query?.sql).toContain('"l"."price_from_uzs" is not null');
    expect(query?.sql).toContain(
      "(l.cap_max is not null or not 'guest_capacity' = any (cat.required_fields))",
    );
    expect(query?.sql).toMatch(/cv\.photo_count >= greatest\(\$\d+, cat\.min_photos\)/);
    expect(query?.sql).toContain('"p"."deleted_at" is null and "p"."status" = $2 and "p"."moderation" = $3');
    expect(query?.parameters).toEqual(expect.arrayContaining([true, "active", "ready", "approved", 3]));
    // Без category — залы, как в v0.1
    expect(query?.sql).toContain('"l"."category_code" = $');
    expect(query?.parameters).toContain("hall");
    // Ни продвижения, ни рейтинга, ни тарифа в запросе нет
    expect(query?.sql).not.toMatch(/promo|premium|rating|paid|tier|service_allowed/);
  });

  it("guests отсекает по cap_max (у категорий без вместимости — нет); date не отсекает", async () => {
    const fake = fakeDb();
    await listCatalog(fake.db, parseCatalogQuery({ guests: ["300"], date: ["2026-10-03"] }));
    const query = fake.queries.find(isCatalog);
    expect(query?.sql).toMatch(/\(l\.cap_max is null or l\.cap_max >= \$\d+\)/);
    expect(query?.parameters).toEqual(expect.arrayContaining([300, "2026-10-03"]));
    // В условиях отбора занятость не участвует — только в порядке и в карточке
    const sql = query?.sql ?? "";
    const where = sql.slice(sql.indexOf('where "l"."status"'), sql.lastIndexOf("order by"));
    expect(where).not.toContain("dl.load");
  });

  it("фильтры по полям витрины — параметрами: вхождение и jsonb_path_exists", async () => {
    const fake = fakeDb();
    await listCatalog(
      fake.db,
      parseCatalogQuery({
        category: ["car"],
        "a.decoration": ["1"],
        "a.fleet.class": ["premium,suv"],
        "a.fleet.seats": ["6"],
      }),
    );
    const query = fake.queries.find(isCatalog);
    const sql = query?.sql ?? "";
    expect(sql).toMatch(/l\.attributes @> \$\d+::jsonb/);
    expect(sql).toMatch(/jsonb_path_exists\(l\.attributes, \$\d+::jsonpath, \$\d+::jsonb\)/);
    expect(query?.parameters).toEqual(
      expect.arrayContaining([
        "car",
        '{"decoration":true}',
        '$."fleet"[*]."class" ? (@ == $v[*])',
        '{"v":["premium","suv"]}',
        '$."fleet"[*]."seats" ? (@ >= $n)',
        '{"n":6}',
      ]),
    );
    // Значения не попадают в текст запроса
    expect(sql).not.toContain("premium");
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
      guests: null,
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
      guests: null,
      busy: true,
      key: -500_000,
      id: ID(5),
    });
    await listCatalog(
      fake.db,
      parseCatalogQuery({ sort: ["price_desc"], date: ["2026-10-03"], cursor: [cursor] }),
    );
    const query = fake.queries.find(isCatalog);
    expect(query?.sql).toContain(`, (-${PER_GUEST_OR_EVENT}), l.id) > ($`);
    expect(query?.sql).toMatch(/\) > \(\$\d+::boolean, \$\d+::bigint, \$\d+::uuid\)/);
    expect(query?.parameters).toEqual(expect.arrayContaining([true, -500_000, ID(5)]));
    expect(query?.sql).not.toContain(ID(5));
  });

  it("карточка: числа из bigint, busyOnDate и dateLoad — null без даты", async () => {
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
      dateLoad: null,
    });

    const dated = fakeDb((q) => (isCatalog(q) ? [cardRow(2, { busy: false, load: "partial" })] : []));
    const withDate = await listCatalog(dated.db, parseCatalogQuery({ date: ["2026-10-03"] }));
    expect(withDate.items[0]).toMatchObject({ busyOnDate: false, dateLoad: "partial" });
  });
});

describe("getListingDetail", () => {
  it("нет такого опубликованного — null, дальше не читает", async () => {
    const fake = fakeDb();
    expect(await getListingDetail(fake.db, "nope", null, "2026-09-29")).toBeNull();
    expect(fake.queries.filter(isCatalog)).toHaveLength(1);
    expect(fake.queries.some((q) => q.sql.includes("listing_services"))).toBe(false);
  });

  it("телефон — через pii.read_listing_phone; услуги — из одобренных; занятость — [сегодня, +180 дней)", async () => {
    const service = {
      id: ID(91),
      listing_id: ID(1),
      category_code: "hall",
      service_type: "banquet_weekday",
      status: "active",
      name_ru: null,
      name_uz: null,
      price_uzs: "150000",
      price_unit: "per_guest",
      min_qty: null,
      lead_days: null,
      includes_ru: "Меню",
      includes_uz: null,
      options: [],
      proposal: null,
      proposal_at: null,
      decision: "approved",
      decision_reason: null,
      decided_at: new Date("2026-09-01T00:00:00Z"),
      submitted_at: null,
      sort: 0,
      updated_at: new Date("2026-09-01T00:00:00Z"),
    };
    const fake = fakeDb((q) => {
      if (isCatalog(q)) {
        return [
          {
            ...cardRow(1),
            description_ru: "Описание",
            description_uz: null,
            address_ru: "Адрес",
            address_uz: "Manzil",
            attributes: { kitchen: "own", unknown: 1, parking_spaces: "много" },
            video_links: [],
            parallel_capacity: 1,
            phone: "+998000000123",
          },
        ];
      }
      if (q.sql.includes('from "app"."listing_services"')) return [service];
      if (q.sql.includes('from "app"."photos"')) {
        return [
          { storage_key: "a.webp", width: 10, height: 20 },
          { storage_key: "b.webp", width: null, height: null },
        ];
      }
      if (q.sql.includes("app.listing_busy")) {
        return [
          { day: "2026-10-03", parts: ["all"] },
          { day: "2026-10-05", parts: ["evening"] },
        ];
      }
      return [];
    });
    const detail = await getListingDetail(fake.db, "hall-1", null, "2026-09-29");

    expect(fake.queries.find(isCatalog)?.sql).toContain('pii.read_listing_phone("l"."id")');
    expect(fake.queries.find((q) => q.sql.includes("app.listing_busy"))?.parameters).toEqual([
      ID(1),
      "2026-09-29",
      "2027-03-28",
    ]);
    const services = fake.queries.filter((q) => q.sql.includes('from "app"."listing_services"'));
    expect(services.every((q) => q.parameters.includes("active"))).toBe(true);
    expect(detail).toMatchObject({
      id: ID(1),
      phone: "+998000000123",
      description: { ru: "Описание", uz: "" },
      address: { ru: "Адрес", uz: "Manzil" },
      // Только известные конфигурации и прошедшие проверку
      attributes: { kitchen: "own" },
      services: [
        {
          id: ID(91),
          type: "banquet_weekday",
          name: { ru: "Банкет — будни", uz: "Banket — ish kunlari" },
          priceUzs: 150_000,
          priceUnit: "per_guest",
          includes: { ru: "Меню", uz: "Меню" },
          options: [],
        },
      ],
      photos: [{ key: "a.webp", width: 10, height: 20 }],
      busyDates: ["2026-10-03"],
      busyParts: [{ date: "2026-10-05", parts: ["evening"] }],
      busyOnDate: null,
    });
    expect(detail).not.toHaveProperty("packages");
  });

  it("с датой — загрузка одной витрины (app.listing_day_load), без выборки всей категории", async () => {
    const fake = fakeDb();
    await getListingDetail(fake.db, "hall-1", "2026-10-03", "2026-09-29");
    const sql = fake.queries.find(isCatalog)?.sql ?? "";
    expect(sql).toMatch(/app\.listing_day_load\(l\.id, \$\d+::date\) as "load"/);
    expect(sql).not.toContain("catalog_day_load");
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
