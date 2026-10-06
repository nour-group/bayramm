// Категории и услуги (v0.2) на настоящем Postgres, ролью bayramm_api:
//
//   · сид базы (app.categories, app.service_types) совпадает с конфигурацией
//     @bayramm/shared/categories — как сверка типов Kysely: правка конфигурации без
//     миграции с новым сидом — красный тест;
//   · панель: вендор с категорией, вторая витрина в другой категории, поля витрины,
//     услуги (менеджер — на проверку, модератор — сразу), публикация, очередь
//     модерации, решения, смена категории (пока нет заявок);
//   · кабинет: витрины с категориями, услуги и предложения правок, части дня и
//     одновременные заказы;
//   · клиент: категории каталога, фильтры по полям витрины, карточка с услугами,
//     заявка с полями категории (часть дня, выбранные услуги — снимком, срок подготовки).
//
// Данные — со случайными названиями; витрины прогона в конце снимаются с публикации
// (как в client-api: заявки и журналы остаются в локальной базе).

import { randomBytes, randomInt, randomUUID } from "node:crypto";
import type {
  ApiErrorBody,
  CatalogCategories,
  CatalogPage,
  ClientRequests,
  ListingDetail as PublicListing,
  RequestCreated,
} from "@bayramm/shared/api";
import type { ListingService, ListingServices } from "@bayramm/shared/api/services";
import type {
  ListingDetail,
  ServiceQueue,
  StaffRequestList,
  VendorDetail,
  VendorList,
} from "@bayramm/shared/api/staff";
import type { VendorCalendar, VendorListing, VendorMe, VendorRequestPage } from "@bayramm/shared/api/vendor";
import { CATEGORIES, categoriesRu, categoriesUz, requiredAttributeKeys } from "@bayramm/shared/categories";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import app from "../../src/index";
import { initDataFor, type TestTelegramUser } from "../../src/testing/init-data";
import {
  adminClient,
  BOT_TOKEN,
  bearer,
  call,
  inviteStaff,
  loginToken,
  makeEnv,
  newStaffUsername,
  newTelegramUser,
  staffLoginToken,
  tgIdHash,
} from "./helpers";

let admin: Client;
const run = randomBytes(3).toString("hex");
const tokens = { admin: "", manager: "", moderator: "" };
type Who = keyof typeof tokens;

const day = (n: number) => {
  const today = new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
  return new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
};

// Немедленная отправка уведомлений (outboxKick) не должна ходить в настоящий Telegram
const realFetch = globalThis.fetch;
vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input instanceof Request ? input.url : input).startsWith("https://api.telegram.org/")) {
    throw new TypeError("Telegram is offline in tests");
  }
  return realFetch(input, init);
});

async function request(token: string, method: string, path: string, body?: unknown): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  const init: RequestInit = { method, headers: { Authorization: `Bearer ${token}` } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  const res = await app.request(path, init, makeEnv(), ctx);
  await Promise.all(pending);
  return res;
}

const api = (who: Who, method: string, path: string, body?: unknown) =>
  request(tokens[who], method, path, body);

async function ok<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  const text = await r.text();
  if (r.status !== status) throw new Error(`ожидался ${status}, пришёл ${r.status}: ${text}`);
  return JSON.parse(text) as T;
}

async function error(res: Response | Promise<Response>) {
  const r = await res;
  const body = (await r.json()) as ApiErrorBody;
  return { status: r.status, code: body.error.code, details: body.error.details };
}

// ── сид базы = конфигурация ─────────────────────────────────────────────────

describe("сид категорий и каталога услуг = @bayramm/shared/categories", () => {
  beforeAll(async () => {
    admin = await adminClient();
  });

  it("категории: названия, включение, порядок, режим занятости, правило фото, обязательное", async () => {
    const { rows } = await admin.query(
      `select code, name_ru, name_uz, enabled, sort, availability_mode::text as availability,
              photo_policy::text as photo_policy, min_photos, max_video_links, required_fields,
              required_attributes, required_services
         from app.categories order by sort, code`,
    );
    expect(rows).toEqual(
      CATEGORIES.map((c) => ({
        code: c.code,
        name_ru: categoriesRu[c.label],
        name_uz: categoriesUz[c.label],
        enabled: c.enabled,
        sort: c.sort,
        availability: c.availability,
        photo_policy: c.photoPolicy,
        min_photos: c.minPhotos,
        max_video_links: c.maxVideoLinks,
        required_fields: [...c.listingFields],
        required_attributes: requiredAttributeKeys(c),
        required_services: [...c.requiredServices],
      })),
    );
  });

  it("типы услуг: коды, названия, единицы, уровень, цена «от», свободное название, шаблоны опций", async () => {
    const { rows } = await admin.query(
      `select category_code, code, name_ru, name_uz, units::text[] as units, tier::text as tier, in_price_from,
              free_name, sort, options
         from app.service_types where enabled order by category_code, sort, code`,
    );
    const expected = CATEGORIES.flatMap((c) =>
      c.services.map((s, index) => ({
        category_code: c.code,
        code: s.code,
        name_ru: categoriesRu[s.label],
        name_uz: categoriesUz[s.label],
        units: [...s.units],
        tier: s.tier,
        in_price_from: s.inPriceFrom,
        free_name: s.freeName,
        sort: index + 1,
        options: s.options.map((o) => ({
          code: o.code,
          name_ru: categoriesRu[o.label],
          name_uz: categoriesUz[o.label],
          unit: o.unit,
        })),
      })),
    ).sort((a, b) => a.category_code.localeCompare(b.category_code) || a.sort - b.sort);
    expect(rows).toEqual(expected);
  });
});

// ── сквозной сценарий ───────────────────────────────────────────────────────

const vendorTelegram: TestTelegramUser = {
  id: 6_000_000_000 + randomInt(0, 999_999_999),
  first_name: "Vendor",
  language_code: "ru",
};
let vendorToken = "";
let vendor: VendorDetail;
let car: ListingDetail;
let photo: ListingDetail;
let transferText = "";
let vendorContactText = "";
let clientToken = "";

async function photos(listingId: string, peopleConsent = false): Promise<void> {
  for (const n of [1, 2, 3]) {
    await admin.query(
      `insert into app.photos (listing_id, status, moderation, storage_key, mime, bytes, width, height, sha256,
                               sort, is_cover, no_faces_ack, people_consent_ack)
       values ($1, 'ready', 'pending', $2, 'image/webp', 1000, 1600, 1200, $3, $4, $5, $6, $7)`,
      [
        listingId,
        `listings/${listingId}/${randomUUID()}.webp`,
        randomBytes(32),
        n,
        n === 1,
        !peopleConsent,
        peopleConsent,
      ],
    );
  }
}

beforeAll(async () => {
  admin ??= await adminClient();
  for (const role of ["admin", "manager", "moderator"] as const) {
    const username = newStaffUsername();
    const id = await inviteStaff(admin, { username, role, displayName: `Test ${role}` });
    tokens[role] = await staffLoginToken(username);
    // Модератору — оповещения команды в боте (ops.service_submitted)
    if (role === "moderator") {
      await admin.query("update pii.staff_profiles set telegram_chat_id = $2 where staff_id = $1", [
        id,
        5_000_000_000 + randomInt(0, 999_999_999),
      ]);
    }
  }
  transferText = randomUUID();
  vendorContactText = randomUUID();
  const version = 2_000_000_000 + randomInt(0, 147_000_000);
  await admin.query(
    `insert into app.consent_texts (id, purpose, version, locale, body) values
       ($1, 'request_transfer', $3, 'ru', 'Тест: передать контакты'),
       ($2, 'vendor_contact', $3, 'ru', 'Тест: данные контактного лица')`,
    [transferText, vendorContactText, version],
  );
  clientToken = await loginToken(newTelegramUser());
});

afterAll(async () => {
  vi.unstubAllGlobals();
  if (!admin) return;
  if (vendor) {
    await admin.query(
      "update app.listings set status = 'suspended', status_reason = 'integration test cleanup' where vendor_id = $1 and status = 'active'",
      [vendor.id],
    );
  }
  await admin.query(
    "update app.consent_texts set retired_at = now() where id = any($1::uuid[]) and retired_at is null",
    [[transferText, vendorContactText]],
  );
  await admin.end();
});

describe("панель: вендор в нескольких категориях", () => {
  it("вендор с категорией — сразу первая витрина; вторая — в другой категории", async () => {
    vendor = await ok<VendorDetail>(
      api("manager", "POST", "/staff/vendors", { name: `Кортеж ${run}`, categoryCode: "car" }),
      201,
    );
    expect(vendor.listings).toMatchObject([{ categoryCode: "car", status: "draft", name: `Кортеж ${run}` }]);
    car = await ok<ListingDetail>(api("manager", "GET", `/staff/listings/${vendor.listings[0]?.id}`));
    expect(car).toMatchObject({ categoryCode: "car", parallelCapacity: 1, services: [], attributes: {} });
    expect(car.missingAttributes).toEqual(["fleet", "service_area"]);

    photo = await ok<ListingDetail>(
      api("manager", "POST", `/staff/vendors/${vendor.id}/listings`, {
        categoryCode: "photo",
        name: `Кадр ${run}`,
      }),
      201,
    );
    expect(photo).toMatchObject({ categoryCode: "photo", status: "draft", vendor: { id: vendor.id } });
    const { rows } = await admin.query(
      "select detail from app.audit_log where action = 'vendor.listing_add' and object_id = $1 order by id",
      [vendor.id],
    );
    expect(rows.map((r) => r.detail.category)).toEqual(["car", "photo"]);

    // Категория — у витрины: у вендора её не сменить
    expect(
      await error(api("manager", "PATCH", `/staff/vendors/${vendor.id}`, { categoryCode: "photo" })),
    ).toEqual({ status: 422, code: "invalid_input", details: ["categoryCode"] });
    // Выключенная категория — нет; модератор витрин не заводит
    expect(
      await error(api("manager", "POST", `/staff/vendors/${vendor.id}/listings`, { categoryCode: "music" })),
    ).toMatchObject({ status: 422 });
    expect(
      (await api("moderator", "POST", `/staff/vendors/${vendor.id}/listings`, { categoryCode: "cake" }))
        .status,
    ).toBe(403);
  });

  it("поля витрины — по конфигурации категории; ссылки на видео — только YouTube и Instagram", async () => {
    expect(
      await error(
        api("manager", "PATCH", `/staff/listings/${car.id}`, {
          version: car.version,
          attributes: { fleet: [{ model: "", class: "rocket" }], parking_spaces: 3 },
        }),
      ),
    ).toEqual({
      status: 422,
      code: "invalid_input",
      details: ["attributes.fleet.0.model", "attributes.fleet.0.class", "attributes.parking_spaces"],
    });
    car = await ok<ListingDetail>(
      api("manager", "PATCH", `/staff/listings/${car.id}`, {
        version: car.version,
        descriptionRu: "Машины для свадьбы",
        descriptionUz: "Toʻy mashinalari",
        parallelCapacity: 2,
        attributes: {
          fleet: [
            { model: "Mercedes-Benz S", class: "premium", color: "black", seats: 4 },
            { model: "Hyundai H-1", class: "minivan", seats: 11 },
          ],
          decoration: true,
          service_area: "tashkent",
        },
        phone: "+998000000555",
      }),
    );
    expect(car.missingAttributes).toEqual([]);
    expect(car.parallelCapacity).toBe(2);

    expect(
      await error(
        api("manager", "PATCH", `/staff/listings/${photo.id}`, {
          version: photo.version,
          videoLinks: ["https://example.com/watch?v=abcdefghijk"],
        }),
      ),
    ).toMatchObject({ status: 422, details: ["videoLinks.0"] });
    photo = await ok<ListingDetail>(
      api("manager", "PATCH", `/staff/listings/${photo.id}`, {
        version: photo.version,
        descriptionRu: "Съёмка свадьбы",
        descriptionUz: "Toʻyni suratga olish",
        videoLinks: ["https://youtu.be/abcdefghijk"],
        attributes: { team: ["photographer", "videographer"], delivery_days: 30 },
        phone: "+998000000556",
      }),
    );
    expect(photo.videoLinks).toEqual(["https://www.youtube.com/watch?v=abcdefghijk"]);
    expect(
      await error(
        api("manager", "PATCH", `/staff/listings/${car.id}`, {
          version: car.version,
          videoLinks: [photo.videoLinks[0]],
        }),
      ),
    ).toMatchObject({ status: 422, details: ["videoLinks"] });
  });

  it("услуги: менеджер — на проверку, администратор — сразу; единица и опции — из каталога", async () => {
    expect(
      await error(
        api("manager", "POST", `/staff/listings/${car.id}/services`, {
          type: "bride_car",
          priceUzs: 300_000,
          priceUnit: "per_kg",
        }),
      ),
    ).toEqual({ status: 422, code: "invalid_input", details: ["priceUnit"] });
    expect(
      await error(
        api("manager", "POST", `/staff/listings/${car.id}/services`, { type: "wedding_cake", priceUzs: 1 }),
      ),
    ).toMatchObject({ status: 422, details: ["type"] });

    const bride = await ok<ListingService>(
      api("manager", "POST", `/staff/listings/${car.id}/services`, {
        type: "bride_car",
        priceUzs: 300_000,
        minQty: 3,
        includes: { ru: "Водитель и топливо", uz: "Haydovchi va yoqilgʻi" },
        options: [
          {
            code: "extra_hour",
            name: { ru: "Ещё час", uz: "Yana soat" },
            priceUzs: 300_000,
            priceUnit: "per_hour",
          },
        ],
      }),
      201,
    );
    expect(bride).toMatchObject({
      type: "bride_car",
      status: "review",
      priceUnit: "per_hour",
      name: { ru: "Машина для молодожёнов" },
      customName: false,
    });
    expect(bride.options[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    const other = await ok<ListingService>(
      api("admin", "POST", `/staff/listings/${car.id}/services`, {
        type: "other",
        name: { ru: "Фотосессия у машины", uz: "Mashina yonida fotosessiya" },
        priceUzs: 150_000,
        priceUnit: "per_event",
      }),
      201,
    );
    expect(other).toMatchObject({ status: "active", customName: true, decision: { outcome: "approved" } });

    for (const s of ["photo_shoot", "drone"] as const) {
      await ok(
        api("admin", "POST", `/staff/listings/${photo.id}/services`, {
          type: s,
          priceUzs: s === "drone" ? 1_200_000 : 400_000,
          priceUnit: s === "drone" ? "per_event" : "per_hour",
        }),
        201,
      );
    }
    car = await ok<ListingDetail>(api("manager", "GET", `/staff/listings/${car.id}`));
    // Цена «от» неопубликованной витрины — и из услуг на проверке: банкета у кортежа нет,
    // «другая услуга» в «от» не входит — значит, машина для молодожёнов
    expect(car).toMatchObject({ priceFromUzs: 300_000, priceUnit: "per_hour" });
    expect(car.blockers.review).toEqual(["photos"]);
  });

  it("публикация одобряет услуги и фото; без обязательного поля витрины — нельзя", async () => {
    await photos(car.id);
    await photos(photo.id, true);
    await ok(
      api("manager", "PATCH", `/staff/vendors/${vendor.id}`, {
        stir: String(randomInt(100_000_000, 999_999_999)),
      }),
    );
    for (const item of ["contract", "stir", "contacts"]) {
      await ok(api("manager", "POST", `/staff/vendors/${vendor.id}/checklist`, { item, done: true }));
    }
    await ok(
      api("manager", "POST", `/staff/vendors/${vendor.id}/checklist`, { item: "pdConsent", done: true }),
    );

    for (const { id } of [car, photo]) {
      // Услуги меняют цену «от» — версия карточки другая
      const listing = await ok<ListingDetail>(api("manager", "GET", `/staff/listings/${id}`));
      const submitted = await ok<ListingDetail>(
        api("manager", "POST", `/staff/listings/${listing.id}/submit`, { version: listing.version }),
      );
      const published = await ok<ListingDetail>(
        api("moderator", "POST", `/staff/listings/${listing.id}/publish`, { version: submitted.version }),
      );
      expect(published.status).toBe("active");
      expect(published.services.every((s) => s.status === "active")).toBe(true);
      if (listing.id === car.id) car = published;
      else photo = published;
    }
    // Обязательное поле опубликованной витрины не убрать
    expect(
      await error(
        api("admin", "PATCH", `/staff/listings/${car.id}`, {
          version: car.version,
          attributes: { service_area: null },
        }),
      ),
    ).toMatchObject({ status: 422, code: "publish_blocked", details: ["attributes"] });
  });
});

describe("клиент: категории, фильтры, карточка, заявка", () => {
  it("категории каталога — включённые, с числом витрин", async () => {
    const body = await ok<CatalogCategories>(call("/catalog/categories"));
    // В порядке показа (sort), а не кодов
    expect(body.items.map((c) => c.code)).toEqual(
      CATEGORIES.filter((c) => c.enabled)
        .sort((a, b) => a.sort - b.sort)
        .map((c) => c.code),
    );
    expect(body.items.find((c) => c.code === "car")?.listings).toBeGreaterThanOrEqual(1);
  });

  it("фильтры по полям витрины: класс и места машин, да/нет, команда", async () => {
    const ids = async (query: string) =>
      (await ok<CatalogPage>(call(`/catalog/listings?${query}&limit=50`))).items.map((i) => i.id);
    expect(await ids("category=car&a.fleet.class=premium")).toContain(car.id);
    expect(await ids("category=car&a.fleet.class=bus")).not.toContain(car.id);
    expect(await ids("category=car&a.fleet.seats=10")).toContain(car.id);
    expect(await ids("category=car&a.fleet.seats=20")).not.toContain(car.id);
    expect(await ids("category=car&a.decoration=1")).toContain(car.id);
    expect(await ids("category=photo&a.team=photographer,videographer")).toContain(photo.id);
    expect(await ids("category=photo&a.team=photographer,drone_operator")).not.toContain(photo.id);
    // Без категории — залы: кортежа там нет
    expect(await ids("district=")).not.toContain(car.id);
    expect(await error(call("/catalog/listings?category=car&a.kitchen=own"))).toEqual({
      status: 400,
      code: "invalid_request",
      details: ["a.kitchen"],
    });
  });

  it("карточка: услуги с опциями, поля витрины, ссылки на видео; без вместимости", async () => {
    const detail = await ok<PublicListing>(call(`/catalog/listings/${car.slug}`));
    expect(detail).toMatchObject({ categoryCode: "car", capMax: null, parallelCapacity: 2 });
    expect(detail).not.toHaveProperty("packages");
    expect(detail.services.map((s) => s.type).sort()).toEqual(["bride_car", "other"]);
    expect(detail.attributes).toMatchObject({ decoration: true, service_area: "tashkent" });
    const photoDetail = await ok<PublicListing>(call(`/catalog/listings/${photo.slug}`));
    expect(photoDetail.videoLinks).toEqual(["https://www.youtube.com/watch?v=abcdefghijk"]);
  });

  let requestId = "";

  it("заявка: поля категории, часть дня из времени начала, выбранные услуги — снимком", async () => {
    const detail = await ok<PublicListing>(call(`/catalog/listings/${car.slug}`));
    const bride = detail.services.find((s) => s.type === "bride_car");
    const send = (body: Record<string, unknown>) =>
      request(clientToken, "POST", "/requests", {
        listingId: car.id,
        occasionCode: "toy",
        eventDate: day(20),
        contactName: "Тест",
        contactPhone: "+998000000123",
        requestTransferConsentId: transferText,
        ...body,
      });

    expect(
      await error(send({ guests: 100, details: { start_time: "18:00", hours: 3, cars_count: 2 } })),
    ).toEqual({
      status: 400,
      code: "invalid_request",
      details: ["guests"],
    });
    expect(await error(send({ details: { start_time: "25:00", hours: 3, extra: 1 } }))).toEqual({
      status: 400,
      code: "invalid_request",
      details: ["details.extra", "details.start_time", "details.cars_count"],
    });
    expect(
      await error(
        send({ details: { start_time: "18:00", hours: 3, cars_count: 2, services: [{ id: randomUUID() }] } }),
      ),
    ).toEqual({ status: 400, code: "invalid_request", details: ["details.services.0.id"] });
    expect(
      await error(
        send({
          details: { start_time: "18:00", hours: 3, cars_count: 2, services: [{ id: bride?.id, qty: 1 }] },
        }),
      ),
    ).toEqual({ status: 400, code: "invalid_request", details: ["details.services.0.qty"] });

    const created = await ok<RequestCreated>(
      send({
        details: {
          start_time: "18:30",
          hours: 4,
          cars_count: 2,
          car_class: "premium",
          services: [{ id: bride?.id, qty: 4, options: [bride?.options[0]?.id] }],
        },
      }),
      201,
    );
    requestId = created.id;
    const mine = await ok<ClientRequests>(request(clientToken, "GET", "/requests"));
    const item = mine.items.find((r) => r.id === created.id);
    expect(item).toMatchObject({ guests: null, dayPart: "evening", listing: { categoryCode: "car" } });
    expect(item?.details).toMatchObject({
      start_time: "18:30",
      hours: 4,
      cars_count: 2,
      services: [
        {
          id: bride?.id,
          type: "bride_car",
          name: { ru: "Машина для молодожёнов" },
          priceUzs: 300_000,
          qty: 4,
          options: [{ id: bride?.options[0]?.id, priceUzs: 300_000 }],
        },
      ],
    });
    // Уведомление вендору ставит база — с id заявки, без полей
    const { rows } = await admin.query("select payload from app.outbox where request_id = $1", [created.id]);
    for (const row of rows) expect(Object.keys(row.payload)).toEqual(["request_id"]);
  });

  it("категорию витрины с заявками не сменить — новая витрина", async () => {
    car = await ok<ListingDetail>(api("manager", "GET", `/staff/listings/${car.id}`));
    expect(
      await error(
        api("admin", "POST", `/staff/listings/${car.id}/category`, {
          categoryCode: "decor",
          version: car.version,
        }),
      ),
    ).toEqual({ status: 409, code: "category_locked", details: undefined });
    expect(requestId).not.toBe("");
  });

  it("списки панели: категория у витрин вендора, фильтры вендоров и заявок по категории", async () => {
    const q = encodeURIComponent(`Кортеж ${run}`);
    const vendors = await ok<VendorList>(api("manager", "GET", `/staff/vendors?q=${q}&category=photo`));
    expect(vendors.items.map((v) => v.id)).toEqual([vendor.id]);
    expect(vendors.items[0]?.listings.map((l) => l.categoryCode)).toEqual(["car", "photo"]);
    expect(
      (await ok<VendorList>(api("manager", "GET", `/staff/vendors?q=${q}&category=cake`))).items,
    ).toEqual([]);

    const cars = await ok<StaffRequestList>(api("manager", "GET", "/staff/requests?category=car&limit=100"));
    expect(cars.items.some((r) => r.id === requestId)).toBe(true);
    expect(cars.items.every((r) => r.listing.categoryCode === "car")).toBe(true);
    const photos = await ok<StaffRequestList>(
      api("manager", "GET", "/staff/requests?category=photo&limit=100"),
    );
    expect(photos.items.some((r) => r.id === requestId)).toBe(false);
  });
});

describe("кабинет: витрины, услуги, предложения, части дня", () => {
  beforeAll(async () => {
    // Владелец кабинета вендора — привязан к Telegram, как это делает бот
    const userId = randomUUID();
    await admin.query(
      `insert into app.vendor_users (id, vendor_id, phone_hash, tg_user_hash, tg_linked_at) values ($1, $2, $3, $4, now())`,
      [userId, vendor.id, randomBytes(32), tgIdHash(vendorTelegram.id)],
    );
    await admin.query(
      "insert into pii.vendor_user_profiles (vendor_user_id, phone, telegram_chat_id) values ($1, '+998000000112', $2)",
      [userId, vendorTelegram.id],
    );
    const res = await call("/auth/telegram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        initData: await initDataFor(vendorTelegram, { botToken: BOT_TOKEN }),
        app: "vendor",
      }),
    });
    vendorToken = ((await res.json()) as { token: string }).token;
  });

  it("витрины вендора — с категорией; заявки — по витрине", async () => {
    const me = await ok<VendorMe>(call("/vendor/me", bearer(vendorToken)));
    expect(
      me.listings.map((l) => [l.id, l.categoryCode]).sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    ).toEqual([
      [car.id, "car"],
      [photo.id, "photo"],
    ]);
    const forCar = await ok<VendorRequestPage>(
      call(`/vendor/requests?tab=new&listingId=${car.id}`, bearer(vendorToken)),
    );
    expect(forCar.items.map((r) => r.listing.categoryCode)).toEqual(["car"]);
    expect(forCar.items[0]).toMatchObject({ guests: null, dayPart: "evening", details: { cars_count: 2 } });
    const forPhoto = await ok<VendorRequestPage>(
      call(`/vendor/requests?tab=new&listingId=${photo.id}`, bearer(vendorToken)),
    );
    expect(forPhoto.items).toEqual([]);
    const listing = await ok<VendorListing>(call(`/vendor/listings/${car.id}`, bearer(vendorToken)));
    expect(listing).toMatchObject({ categoryCode: "car", parallelCapacity: 2, missingAttributes: [] });
    expect(listing.services).toHaveLength(2);
  });

  let proposed: ListingService;

  it("новая услуга — на проверку, правка активной — предложением; клиент видит одобренное", async () => {
    const limo = await ok<ListingService>(
      request(vendorToken, "POST", `/vendor/listings/${car.id}/services`, {
        type: "limousine",
        priceUzs: 700_000,
      }),
      201,
    );
    expect(limo.status).toBe("review");
    const services = await ok<ListingServices>(
      call(`/vendor/listings/${car.id}/services`, bearer(vendorToken)),
    );
    const bride = services.items.find((s) => s.type === "bride_car");
    proposed = await ok<ListingService>(
      request(vendorToken, "PATCH", `/vendor/listings/${car.id}/services/${bride?.id}`, {
        priceUzs: 280_000,
      }),
    );
    expect(proposed).toMatchObject({
      status: "active",
      priceUzs: 300_000,
      proposal: { changes: { priceUzs: 280_000 } },
    });
    expect(
      await error(
        request(vendorToken, "PATCH", `/vendor/listings/${car.id}/services/${bride?.id}`, {
          priceUzs: 300_000,
        }),
      ),
    ).toMatchObject({ status: 422, code: "no_changes" });

    const card = await ok<PublicListing>(call(`/catalog/listings/${car.slug}`));
    expect(card.services.find((s) => s.type === "bride_car")?.priceUzs).toBe(300_000);
    expect(card.services.some((s) => s.type === "limousine")).toBe(false);

    const { rows } = await admin.query(
      "select count(*)::int as n from app.outbox where kind = 'ops.service_submitted' and payload ->> 'listing_id' = $1",
      [car.id],
    );
    expect(rows[0]?.n).toBeGreaterThanOrEqual(1);
  });

  it("очередь модерации: решения — партнёру; одобренная цена — в цене «от»", async () => {
    const queue = await ok<ServiceQueue>(api("moderator", "GET", "/staff/services?limit=100"));
    const mine = queue.items.filter((i) => i.listing.id === car.id);
    expect(mine.map((i) => [i.kind, i.service.type]).sort()).toEqual([
      ["proposal", "bride_car"],
      ["review", "limousine"],
    ]);
    expect(mine.every((i) => i.proposedBy.kind === "partner")).toBe(true);
    expect((await api("manager", "GET", "/staff/services")).status).toBe(403);

    await ok(api("moderator", "POST", `/staff/services/${proposed.id}/approve`));
    const limo = mine.find((i) => i.service.type === "limousine");
    expect(
      await error(api("moderator", "POST", `/staff/services/${limo?.service.id}/decline`, {})),
    ).toMatchObject({ status: 422, details: ["reason"] });
    const declined = await ok<ListingService>(
      api("moderator", "POST", `/staff/services/${limo?.service.id}/decline`, {
        reason: "Нужно фото лимузина",
      }),
    );
    expect(declined).toMatchObject({
      status: "rejected",
      decision: { outcome: "declined", reason: "Нужно фото лимузина" },
    });

    const card = await ok<PublicListing>(call(`/catalog/listings/${car.slug}`));
    expect(card).toMatchObject({ priceFromUzs: 280_000, priceUnit: "per_hour" });
    const { rows } = await admin.query(
      `select payload ->> 'decision' as decision from app.outbox
        where kind = 'vendor.service_decided' and payload ->> 'service_id' = any($1::text[]) order by created_at`,
      [[proposed.id, limo?.service.id]],
    );
    expect(rows.map((r) => r.decision)).toEqual(["approved", "declined"]);
  });

  it("части дня: отметка вечера и одновременные заказы — в календаре и в каталоге", async () => {
    const calendar = await ok<VendorCalendar>(
      call(`/vendor/listings/${car.id}/calendar`, bearer(vendorToken)),
    );
    expect(calendar).toMatchObject({ mode: "parts", parallelCapacity: 2 });
    const target = day(12);
    const marked = await call(`/vendor/listings/${car.id}/calendar/${target}?part=evening`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${vendorToken}`, "If-Match": String(calendar.version) },
    });
    expect(marked.status).toBe(200);
    const change = (await marked.json()) as { part: string; version: number };
    expect(change.part).toBe("evening");

    const detail = await ok<PublicListing>(call(`/catalog/listings/${car.slug}?date=${target}`));
    expect(detail.busyParts).toContainEqual({ date: target, parts: ["evening"] });
    expect(detail).toMatchObject({ busyOnDate: false, dateLoad: "partial" });

    // Заявку на занятую часть дня сервер не примет — та же занятость, что у каталога и витрины
    expect(
      await error(
        request(clientToken, "POST", "/requests", {
          listingId: car.id,
          occasionCode: "toy",
          eventDate: target,
          contactName: "Тест",
          contactPhone: "+998000000123",
          requestTransferConsentId: transferText,
          details: { start_time: "19:00", hours: 3, cars_count: 1 },
        }),
      ),
    ).toEqual({ status: 409, code: "date_busy", details: ["details.start_time"] });

    const capacity = await call(`/vendor/listings/${car.id}/calendar/capacity`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${vendorToken}`,
        "If-Match": String(change.version),
        "content-type": "application/json",
      },
      body: JSON.stringify({ parallelCapacity: 3 }),
    });
    expect(capacity.status).toBe(200);
    expect(await capacity.json()).toEqual({ parallelCapacity: 3, version: change.version + 1 });

    // У зала частей дня нет
    const hall = await call(`/vendor/listings/${car.id}/calendar/${target}?part=noon`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${vendorToken}`, "If-Match": String(change.version + 1) },
    });
    expect(hall.status).toBe(422);
  });
});
