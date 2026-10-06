// API клиента на настоящем Postgres, ролью bayramm_api: справочники, тексты
// согласий, каталог (фильтры, сортировки, «занятые в конце», курсор), карточка
// с телефоном, заявка от входа до отзыва и изоляция заявок клиентов (RLS).
//
// Данные — свои на каждый прогон (случайные слаги и id). Согласия, заявки и
// журнал статусов — только на добавление, поэтому после тестов они остаются;
// листинги снимаются с публикации, тексты согласий выводятся из оборота —
// в каталоге и /consent-texts от прогона ничего не остаётся.

import { randomBytes, randomInt, randomUUID } from "node:crypto";
import type {
  ApiErrorBody,
  CatalogPage,
  ClientRequest,
  ClientRequests,
  ConsentTexts,
  Dictionaries,
  ListingDetail,
  RequestCreated,
} from "@bayramm/shared/api";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, tashkentToday } from "../../src/time";
import { addHallBanquets, adminClient, bearer, call, loginToken, newTelegramUser, tgIdHash } from "./helpers";

let admin: Client;
const today = tashkentToday();
const BUSY_DAY = addDays(today, 40);
const EVENT_DAY = addDays(today, 30);
const run = randomBytes(3).toString("hex");
const vendor = randomUUID();

// Площадки прогона (район — Бектемир, категория — залы):
//   cheap — самая дешёвая, но занята в BUSY_DAY; small — 80 мест; draft — не опубликована;
//   event — цена за мероприятие: 33 млн на 300 мест = 110 000 за гостя при полном зале
interface TestListing {
  id: string;
  slug: string;
  price: number;
  unit: "per_guest" | "per_event";
  capMin: number;
  capMax: number;
  publish: boolean;
}
const L = {
  cheap: { price: 90_000, unit: "per_guest", capMin: 50, capMax: 500, publish: true },
  mid: { price: 100_000, unit: "per_guest", capMin: 100, capMax: 400, publish: true },
  small: { price: 120_000, unit: "per_guest", capMin: 20, capMax: 80, publish: true },
  big: { price: 150_000, unit: "per_guest", capMin: 100, capMax: 1000, publish: true },
  event: { price: 33_000_000, unit: "per_event", capMin: 100, capMax: 300, publish: true },
  draft: { price: 110_000, unit: "per_guest", capMin: 10, capMax: 300, publish: false },
} as const;
type Name = keyof typeof L;
const listings = Object.fromEntries(
  Object.entries(L).map(([name, l]) => [name, { ...l, id: randomUUID(), slug: `capi-${run}-${name}` }]),
) as Record<Name, TestListing>;
const byId = new Map(Object.entries(listings).map(([name, l]) => [l.id, name as Name]));

// Тексты согласий прогона: версии большие и случайные — старше любых других
const version = 2_000_000_000 + randomInt(0, 147_000_000);
const texts = {
  vendorContact: randomUUID(),
  transferRu: randomUUID(),
  transferUz: randomUUID(),
  notifyRu: randomUUID(),
  serviceRu: randomUUID(),
  retired: randomUUID(),
};
const clientTelegramIds: number[] = [];

async function createListing(l: TestListing): Promise<void> {
  await admin.query(
    `insert into app.listings (id, vendor_id, slug, category_code, name, district_code, address_ru, address_uz,
                               description_ru, description_uz, price_from_uzs, price_unit, cap_min, cap_max)
     values ($1, $2, $3, 'hall', $4, 'bektemir', 'Адрес', 'Manzil', 'Описание', 'Tavsif', $5, $6, $7, $8)`,
    [l.id, vendor, l.slug, `Test ${l.slug}`, l.price, l.unit, l.capMin, l.capMax],
  );
  await admin.query(
    "insert into pii.listing_contacts (listing_id, public_phone) values ($1, '+998000000777')",
    [l.id],
  );
  // Банкеты — обязательные услуги зала: цена «от» — из них
  await addHallBanquets(admin, l.id, l.price, l.price + 20_000, l.unit);
  // Три готовых одобренных фото; обложка — второе по sort
  for (const n of [1, 2, 3]) {
    await admin.query(
      `insert into app.photos (listing_id, status, moderation, storage_key, mime, bytes, width, height, sha256,
                               sort, is_cover, no_faces_ack)
       values ($1, 'ready', 'approved', $2, 'image/webp', 1000, $3, 900, $4, $5, $6, true)`,
      [l.id, `listings/${l.id}/${randomUUID()}.webp`, 1000 + n, randomBytes(32), n, n === 2],
    );
  }
  if (l.publish) {
    await admin.query("update app.listings set status = 'review' where id = $1", [l.id]);
    await admin.query("update app.listings set status = 'active' where id = $1", [l.id]);
  }
}

beforeAll(async () => {
  admin = await adminClient();
  // Под postgres без актора триггеры считают его system
  await admin.query(
    `insert into app.consent_texts (id, purpose, version, locale, body) values
       ($1, 'vendor_contact', $6, 'ru', 'Тест: данные контактного лица'),
       ($2, 'request_transfer', $6, 'ru', 'Тест: передать контакты площадке'),
       ($3, 'request_transfer', $6, 'uz', 'Test: kontaktlarni maydonga uzatish'),
       ($4, 'bot_notifications', $6, 'ru', 'Тест: уведомления в боте'),
       ($5, 'client_service', $6, 'ru', 'Тест: аккаунт клиента')`,
    [texts.vendorContact, texts.transferRu, texts.transferUz, texts.notifyRu, texts.serviceRu, version],
  );
  // Выведенный из оборота текст: согласие по нему не принимается
  await admin.query(
    `insert into app.consent_texts (id, purpose, version, locale, body, published_at, retired_at)
     values ($1, 'request_transfer', $2, 'ru', 'Тест: старая редакция', now() - interval '2 days', now() - interval '1 day')`,
    [texts.retired, version - 1],
  );
  await admin.query(
    `insert into app.vendor_accounts (id, legal_form, contract_no, contract_signed_at, stir_verified_at,
                                      contacts_confirmed_at, pd_consent_signed_at, pd_consent_text_id)
     values ($1, 'ooo', $2, now(), now(), now(), now(), $3)`,
    [vendor, `T-${run}`, texts.vendorContact],
  );
  for (const l of Object.values(listings)) await createListing(l);
  await admin.query(
    `insert into app.availability (listing_id, day) values
       ($1, $2), ($3, $4), ($3, $5)`,
    [
      listings.cheap.id,
      BUSY_DAY,
      listings.mid.id,
      addDays(today, 10),
      addDays(today, 380), // дальше горизонта даты каталога (BUSY_DAYS_AHEAD) — в карточку не попадает
    ],
  );
  // Прошлое — тоже не попадает. Отметить прошедший день база не даёт никому
  // (availability_guard): такая отметка остаётся от дня, который тогда был будущим,
  // — её кладём в режиме реплики, где пользовательские триггеры не срабатывают
  await admin.query("set session_replication_role = replica");
  try {
    await admin.query("insert into app.availability (listing_id, day) values ($1, $2)", [
      listings.mid.id,
      addDays(today, -1),
    ]);
  } finally {
    await admin.query("reset session_replication_role");
  }
});

afterAll(async () => {
  if (!admin) return;
  await admin.query(
    "update app.listings set status = 'suspended', status_reason = 'integration test cleanup' where vendor_id = $1 and status = 'active'",
    [vendor],
  );
  await admin.query(
    "update app.consent_texts set retired_at = now() where id = any($1::uuid[]) and retired_at is null",
    [Object.values(texts)],
  );
  const hashes = clientTelegramIds.map(tgIdHash);
  if (hashes.length > 0) {
    await admin.query(
      "delete from app.sessions where client_id in (select id from app.clients where tg_id_hash = any($1::bytea[]))",
      [hashes],
    );
  }
  await admin.end();
});

async function json<T>(res: Response, status: number): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as T;
}

async function newClient(): Promise<string> {
  const user = newTelegramUser();
  clientTelegramIds.push(user.id);
  return loginToken(user);
}

// ── справочники и тексты согласий ──────────────────────────────────────────

describe("GET /dictionaries", () => {
  it("включённые категории, 12 районов и 5 поводов на двух языках; ETag и кэш", async () => {
    const res = await call("/dictionaries");
    const body = await json<Dictionaries>(res, 200);
    // Путь пары: ЗАГС, тойхона, кортеж, фото и видео… — порядок показа (sort)
    expect(body.categories.map((c) => c.code)).toEqual([
      "zags",
      "hall",
      "car",
      "photo",
      "studio",
      "restaurant",
      "flowers",
      "attire",
      "gifts",
      "food",
      "cake",
      "decor",
    ]);
    expect(body.categories[0]).toEqual({ code: "zags", name: { ru: "ЗАГС", uz: "FHDYo" } });
    expect(body.categories[1]).toEqual({
      code: "hall",
      name: { ru: "Тойхона", uz: "Toʻyxona" },
    });
    expect(body.districts).toHaveLength(12);
    expect(body.districts[0]).toEqual({ code: "yunusobod", name: { ru: "Юнусабад", uz: "Yunusobod" } });
    expect(body.occasions.map((o) => o.code)).toEqual(["toy", "beshik", "bd", "corp", "small"]);
    expect(res.headers.get("cache-control")).toMatch(/^public, max-age=\d+/);

    const tag = res.headers.get("etag");
    expect(tag).toBeTruthy();
    const again = await call("/dictionaries", { headers: { "If-None-Match": tag ?? "" } });
    expect(again.status).toBe(304);
  });
});

describe("GET /consent-texts", () => {
  it("действующие тексты трёх целей клиента; выведенный и чужие цели — нет", async () => {
    const ru = await json<ConsentTexts>(await call("/consent-texts?locale=ru"), 200);
    expect(ru.items).toEqual(
      expect.arrayContaining([
        {
          id: texts.serviceRu,
          purpose: "client_service",
          version,
          locale: "ru",
          body: "Тест: аккаунт клиента",
        },
        {
          id: texts.transferRu,
          purpose: "request_transfer",
          version,
          locale: "ru",
          body: "Тест: передать контакты площадке",
        },
        {
          id: texts.notifyRu,
          purpose: "bot_notifications",
          version,
          locale: "ru",
          body: "Тест: уведомления в боте",
        },
      ]),
    );
    expect(ru.items).toHaveLength(3);
    expect(ru.items.every((t) => t.locale === "ru")).toBe(true);
    const ids = ru.items.map((t) => t.id);
    expect(ids).not.toContain(texts.retired);
    expect(ids).not.toContain(texts.vendorContact);

    const both = await json<ConsentTexts>(await call("/consent-texts"), 200);
    expect(both.items.map((t) => t.id)).toContain(texts.transferUz);
  });

  it("неизвестная локаль — 400", async () => {
    const body = await json<ApiErrorBody>(await call("/consent-texts?locale=en"), 400);
    expect(body.error).toMatchObject({ code: "invalid_request", details: ["locale"] });
  });
});

// ── каталог ────────────────────────────────────────────────────────────────

/** Вся выдача постранично; из неё — только площадки прогона, в порядке выдачи */
async function catalogNames(query: string, limit = 2): Promise<{ names: Name[]; busy: (boolean | null)[] }> {
  const names: Name[] = [];
  const busy: (boolean | null)[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 100; page++) {
    const qs = `${query}&limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`;
    const body: CatalogPage = await json<CatalogPage>(await call(`/catalog/listings?${qs}`), 200);
    expect(body.items.length).toBeLessThanOrEqual(limit);
    for (const item of body.items) {
      expect(seen.has(item.id), "карточка повторилась на другой странице").toBe(false);
      seen.add(item.id);
      const name = byId.get(item.id);
      if (name) {
        names.push(name);
        busy.push(item.busyOnDate);
      }
    }
    cursor = body.nextCursor;
    if (cursor === null) return { names, busy };
  }
  throw new Error("выдача не закончилась за 100 страниц");
}

const BASE = "category=hall&district=bektemir";

describe("GET /catalog/listings", () => {
  it("только опубликованные; по умолчанию — сначала дешевле", async () => {
    expect((await catalogNames(BASE)).names).toEqual(["cheap", "mid", "event", "small", "big"]);
  });

  it("цена за мероприятие сравнивается честно: без гостей — на гостя по вместимости, с гостями — сумма", async () => {
    // Без гостей event = 33 млн / 300 = 110 000 за гостя: между mid (100 000) и small (120 000)
    expect((await catalogNames(`${BASE}&sort=price_desc`)).names).toEqual([
      "big",
      "small",
      "event",
      "mid",
      "cheap",
    ]);
    // 100 гостей: cheap 9 млн, mid 10 млн, big 15 млн, event 33 млн — зал за мероприятие дороже всех
    expect((await catalogNames(`${BASE}&guests=100`)).names).toEqual(["cheap", "mid", "big", "event"]);
    // 250 гостей: cheap 22,5 млн, mid 25 млн, event 33 млн, big 37,5 млн
    expect((await catalogNames(`${BASE}&guests=250`)).names).toEqual(["cheap", "mid", "event", "big"]);
    expect((await catalogNames(`${BASE}&guests=250&sort=price_desc`)).names).toEqual([
      "big",
      "event",
      "mid",
      "cheap",
    ]);
  });

  it("date не отсекает, а опускает занятых в конец — при любой сортировке", async () => {
    const q = `${BASE}&date=${BUSY_DAY}`;
    expect(await catalogNames(`${q}&sort=price_asc`)).toEqual({
      names: ["mid", "event", "small", "big", "cheap"],
      busy: [false, false, false, false, true],
    });
    expect((await catalogNames(`${q}&sort=price_desc`)).names).toEqual([
      "big",
      "small",
      "event",
      "mid",
      "cheap",
    ]);
    expect((await catalogNames(`${q}&sort=capacity_desc`)).names).toEqual([
      "big",
      "mid",
      "event",
      "small",
      "cheap",
    ]);
    // Без даты занятость не знаем: busyOnDate = null, порядок — только по вместимости
    expect(await catalogNames(`${BASE}&sort=capacity_desc`)).toEqual({
      names: ["big", "cheap", "mid", "event", "small"],
      busy: [null, null, null, null, null],
    });
  });

  it("guests отсекает площадки, где мест меньше", async () => {
    expect((await catalogNames(`${BASE}&guests=100`)).names).not.toContain("small");
    expect((await catalogNames(`${BASE}&guests=1000`)).names).toEqual(["big"]);
  });

  it("карточка: цена, вместимость, обложка (is_cover) и число фото", async () => {
    const body = await json<CatalogPage>(await call(`/catalog/listings?${BASE}&guests=1000&limit=50`), 200);
    const big = body.items.find((i) => i.id === listings.big.id);
    expect(big).toMatchObject({
      slug: listings.big.slug,
      categoryCode: "hall",
      districtCode: "bektemir",
      priceFromUzs: 150_000,
      priceUnit: "per_guest",
      capMin: 100,
      capMax: 1000,
      photoCount: 3,
      busyOnDate: null,
      cover: { width: 1002, height: 900 },
    });
    expect(big?.cover?.key).toMatch(new RegExp(`^listings/${listings.big.id}/`));
    expect(body.items.some((i) => i.id === listings.draft.id)).toBe(false);
  });

  it("неверные параметры — 400 со списком; чужой курсор — 400 invalid_cursor", async () => {
    const bad = await json<ApiErrorBody>(
      await call("/catalog/listings?guests=0&sort=rating&date=2026-02-30&limit=51&district=X"),
      400,
    );
    expect(bad.error.code).toBe("invalid_request");
    expect(bad.error.details).toEqual(
      expect.arrayContaining(["guests", "sort", "date", "limit", "district"]),
    );

    const first = await json<CatalogPage>(await call(`/catalog/listings?${BASE}&limit=1`), 200);
    expect(first.nextCursor).not.toBeNull();
    const other = await call(`/catalog/listings?${BASE}&limit=1&sort=price_desc&cursor=${first.nextCursor}`);
    expect((await json<ApiErrorBody>(other, 400)).error.code).toBe("invalid_cursor");
    const guests = await call(`/catalog/listings?${BASE}&limit=1&guests=100&cursor=${first.nextCursor}`);
    expect((await json<ApiErrorBody>(guests, 400)).error.code).toBe("invalid_cursor");
    const garbage = await call("/catalog/listings?cursor=not-a-cursor");
    expect((await json<ApiErrorBody>(garbage, 400)).error.code).toBe("invalid_cursor");
  });
});

describe("GET /catalog/listings/:slug", () => {
  it("гостю: описание, адрес, услуги, фото (обложка первой), занятые даты и телефон", async () => {
    const before = await admin.query(
      "select count(*)::int as n from app.pii_access_log where subject_id = $1",
      [listings.mid.id],
    );
    const res = await call(`/catalog/listings/${listings.mid.slug}`);
    const body = await json<ListingDetail>(res, 200);
    expect(body).toMatchObject({
      id: listings.mid.id,
      priceFromUzs: 100_000,
      description: { ru: "Описание", uz: "Tavsif" },
      address: { ru: "Адрес", uz: "Manzil" },
      // Контакты — по «Связаться», здесь только какие есть
      contactChannels: ["phone"],
      busyDates: [addDays(today, 10)],
      busyOnDate: null,
      photoCount: 3,
    });
    // Пакетов v0.1 больше нет — только услуги; названия — из каталога услуг
    expect(body).not.toHaveProperty("packages");
    expect(body.services.map((s) => s.name)).toEqual([
      { ru: "Банкет — будни", uz: "Banket — ish kunlari" },
      { ru: "Банкет — выходные", uz: "Banket — dam olish kunlari" },
    ]);
    expect(body.services.map((s) => [s.type, s.priceUzs])).toEqual([
      ["banquet_weekday", 100_000],
      ["banquet_weekend", 120_000],
    ]);
    expect(body.photos.map((p) => p.width)).toEqual([1002, 1001, 1003]);
    expect(body.cover).toEqual(body.photos[0]);
    expect(res.headers.get("cache-control")).toMatch(/^public/);

    // Публичный телефон активного листинга в журнал доступа к ПДн не пишется
    const after = await admin.query(
      "select count(*)::int as n from app.pii_access_log where subject_id = $1",
      [listings.mid.id],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("«Связаться»: контакты опубликованной — по нажатию, события без клиента; черновик — 404", async () => {
    const contact = (slug: string, body: unknown, source?: string) =>
      call(`/catalog/listings/${slug}/contact`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(source ? { "X-Bayramm-Source": source } : {}) },
        body: JSON.stringify(body),
      });
    const events = async () =>
      (
        await admin.query(
          "select action, source::text as source, signed_in from app.contact_events where listing_id = $1 order by id",
          [listings.mid.id],
        )
      ).rows;
    const before = (await events()).length;

    const open = await contact(listings.mid.slug, { action: "open", signedIn: false }, "tma");
    expect(open.status).toBe(200);
    expect(open.headers.get("cache-control")).toBe("no-store");
    expect(await open.json()).toEqual({ phone: "+998000000777", telegram: null });
    const pick = await contact(listings.mid.slug, { action: "phone", signedIn: true });
    expect(pick.status).toBe(204);
    expect((await events()).slice(before)).toEqual([
      { action: "open", source: "tma", signed_in: false },
      { action: "phone", source: "web", signed_in: true },
    ]);

    expect((await contact(listings.draft.slug, { action: "open", signedIn: false })).status).toBe(404);
    expect((await contact(listings.draft.slug, { action: "telegram", signedIn: false })).status).toBe(404);
    expect(await events()).toHaveLength(before + 2);
    // В журнал доступа к ПДн публичный контакт не пишется, в событиях клиента нет
    const { rows } = await admin.query(
      "select column_name from information_schema.columns where table_schema = 'app' and table_name = 'contact_events'",
    );
    expect(rows.map((r) => r.column_name).sort()).toEqual([
      "action",
      "created_at",
      "id",
      "listing_id",
      "signed_in",
      "source",
    ]);
  });

  it("?date — занятость на этот день", async () => {
    const busy = await json<ListingDetail>(
      await call(`/catalog/listings/${listings.cheap.slug}?date=${BUSY_DAY}`),
      200,
    );
    expect(busy.busyOnDate).toBe(true);
    const free = await json<ListingDetail>(
      await call(`/catalog/listings/${listings.mid.slug}?date=${BUSY_DAY}`),
      200,
    );
    expect(free.busyOnDate).toBe(false);
  });

  it("черновик, несуществующий и кривой слаг — 404; кривая дата — 400", async () => {
    expect((await call(`/catalog/listings/${listings.draft.slug}`)).status).toBe(404);
    expect((await call(`/catalog/listings/capi-${run}-nope`)).status).toBe(404);
    expect((await call("/catalog/listings/NOT_A_SLUG")).status).toBe(404);
    expect((await call(`/catalog/listings/${listings.mid.slug}?date=tomorrow`)).status).toBe(400);
  });
});

// ── заявки ─────────────────────────────────────────────────────────────────

function post(path: string, token: string | null, body: unknown, source?: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (source) headers["X-Bayramm-Source"] = source;
  return call(path, { method: "POST", headers, body: JSON.stringify(body) });
}

function requestBody(patch: Record<string, unknown> = {}) {
  return {
    listingId: listings.mid.id,
    occasionCode: "toy",
    eventDate: EVENT_DAY,
    guests: 150,
    budgetMinUzs: 10_000_000,
    budgetMaxUzs: 20_000_000,
    contactName: "Тест Клиент",
    contactPhone: "+998 00 000-01-23",
    comment: "  Нужен зал на вечер  ",
    requestTransferConsentId: texts.transferRu,
    ...patch,
  };
}

async function myRequests(token: string): Promise<readonly ClientRequest[]> {
  const res = await call("/requests", bearer(token));
  expect(res.headers.get("cache-control")).toBe("no-store");
  return (await json<ClientRequests>(res, 200)).items;
}

describe("заявка: гость → клиент → мои заявки → отзыв", () => {
  let tokenA = "";
  let tokenB = "";
  let created: RequestCreated;
  let requestB = "";

  beforeAll(async () => {
    tokenA = await newClient();
    tokenB = await newClient();
  });

  it("без входа — 401", async () => {
    expect((await post("/requests", null, requestBody())).status).toBe(401);
    expect((await call("/requests")).status).toBe(401);
  });

  it("клиент подаёт заявку: 201, согласия в журнале, контакты — отдельно", async () => {
    const res = await post("/requests", tokenA, requestBody({ notifyConsentId: texts.notifyRu }), "tma");
    created = await json<RequestCreated>(res, 201);
    expect(created.status).toBe("new");
    expect(created.publicNo).toBeGreaterThanOrEqual(1001);
    const sla = Date.parse(created.slaDueAt) - Date.now();
    expect(sla).toBeGreaterThan(12 * 3600_000 - 60_000);
    expect(sla).toBeLessThanOrEqual(12 * 3600_000);

    const { rows: req } = await admin.query(
      `select r.source, r.guests, r.event_date::text, r.budget_min_uzs::text, r.status, c.purpose, c.text_id,
              c.scope_listing_id, c.source as consent_source, c.subject_id, r.client_id
       from app.requests r join app.consents c on c.id = r.consent_id where r.id = $1`,
      [created.id],
    );
    expect(req[0]).toMatchObject({
      source: "tma",
      guests: 150,
      event_date: EVENT_DAY,
      budget_min_uzs: "10000000",
      status: "new",
      purpose: "request_transfer",
      text_id: texts.transferRu,
      scope_listing_id: listings.mid.id,
      consent_source: "tma",
    });
    expect(req[0].subject_id).toBe(req[0].client_id);

    const { rows: notify } = await admin.query(
      "select action, text_id, source from app.consents where subject_id = $1 and purpose = 'bot_notifications'",
      [req[0].client_id],
    );
    expect(notify).toEqual([{ action: "grant", text_id: texts.notifyRu, source: "tma" }]);

    const { rows: contact } = await admin.query(
      "select contact_name, contact_phone, comment from pii.request_contacts where request_id = $1",
      [created.id],
    );
    expect(contact).toEqual([
      { contact_name: "Тест Клиент", contact_phone: "+998000000123", comment: "Нужен зал на вечер" },
    ]);
  });

  it("повторная заявка на тот же листинг и дату — 409 с id первой", async () => {
    const body = await json<ApiErrorBody>(await post("/requests", tokenA, requestBody()), 409);
    expect(body).toEqual({
      existingId: created.id,
      error: { code: "duplicate_request", message: expect.any(String) },
    });
  });

  it("отказы: вместимость, согласие, выведенный текст, черновик, неверное тело", async () => {
    const over = await post("/requests", tokenA, requestBody({ eventDate: addDays(today, 31), guests: 401 }));
    expect((await json<ApiErrorBody>(over, 422)).error.code).toBe("guests_over_capacity");

    const noConsent = await post("/requests", tokenA, requestBody({ requestTransferConsentId: undefined }));
    expect((await json<ApiErrorBody>(noConsent, 422)).error).toMatchObject({
      code: "consent_required",
      details: ["requestTransferConsentId"],
    });
    const wrongPurpose = await post(
      "/requests",
      tokenA,
      requestBody({ eventDate: addDays(today, 32), requestTransferConsentId: texts.notifyRu }),
    );
    expect((await json<ApiErrorBody>(wrongPurpose, 422)).error.code).toBe("consent_required");
    const retired = await post(
      "/requests",
      tokenA,
      requestBody({ eventDate: addDays(today, 33), requestTransferConsentId: texts.retired }),
    );
    expect((await json<ApiErrorBody>(retired, 409)).error.code).toBe("consent_text_not_current");

    const draft = await post("/requests", tokenA, requestBody({ listingId: listings.draft.id }));
    expect(draft.status).toBe(404);

    const invalid = await post(
      "/requests",
      tokenA,
      requestBody({ eventDate: today, guests: 0, contactPhone: "12345", occasionCode: "Wedding" }),
    );
    expect((await json<ApiErrorBody>(invalid, 400)).error.details).toEqual([
      "occasionCode",
      "eventDate",
      "guests",
      "contactPhone",
    ]);
    const unknownOccasion = await post(
      "/requests",
      tokenA,
      requestBody({ eventDate: addDays(today, 34), occasionCode: "funeral" }),
    );
    expect((await json<ApiErrorBody>(unknownOccasion, 400)).error.details).toEqual(["occasionCode"]);

    // Отказы ничего не оставили: у клиента одна заявка
    expect(await myRequests(tokenA)).toHaveLength(1);
  });

  it("мои заявки — только свои, с листингом и обложкой", async () => {
    const res = await post("/requests", tokenB, requestBody({ listingId: listings.big.id, guests: 900 }));
    requestB = (await json<RequestCreated>(res, 201)).id;

    const itemsA = await myRequests(tokenA);
    expect(itemsA).toHaveLength(1);
    expect(itemsA[0]).toMatchObject({
      id: created.id,
      publicNo: created.publicNo,
      status: "new",
      declineReason: null,
      eventDate: EVENT_DAY,
      guests: 150,
      occasionCode: "toy",
      slaDueAt: created.slaDueAt,
      firstResponseAt: null,
      slaBreached: false,
      listing: { id: listings.mid.id, slug: listings.mid.slug, districtCode: "bektemir" },
    });
    expect(itemsA[0]?.listing.cover?.width).toBe(1002);

    const itemsB = await myRequests(tokenB);
    expect(itemsB.map((r) => r.id)).toEqual([requestB]);
    const { rows } = await admin.query("select source from app.requests where id = $1", [requestB]);
    expect(rows[0].source).toBe("web");
  });

  it("чужую заявку не отозвать — 404, и она не меняется", async () => {
    expect((await post(`/requests/${requestB}/withdraw`, tokenA, {})).status).toBe(404);
    expect((await post(`/requests/${randomUUID()}/withdraw`, tokenA, {})).status).toBe(404);
    expect((await post("/requests/not-a-uuid/withdraw", tokenA, {})).status).toBe(404);
    const { rows } = await admin.query("select status from app.requests where id = $1", [requestB]);
    expect(rows[0].status).toBe("new");
  });

  it("отзыв своей: withdrawn, в журнале статусов — клиент и источник; повтор — без изменений", async () => {
    const res = await post(`/requests/${created.id}/withdraw`, tokenA, {});
    const withdrawn = await json<ClientRequest>(res, 200);
    expect(withdrawn).toMatchObject({ id: created.id, status: "withdrawn", slaBreached: false });

    const { rows } = await admin.query(
      "select from_status, to_status, actor_kind, source from app.request_status_log where request_id = $1 order by id",
      [created.id],
    );
    expect(rows).toEqual([
      { from_status: null, to_status: "new", actor_kind: "client", source: "tma" },
      { from_status: "new", to_status: "withdrawn", actor_kind: "client", source: "web" },
    ]);

    const again = await json<ClientRequest>(await post(`/requests/${created.id}/withdraw`, tokenA, {}), 200);
    expect(again.status).toBe("withdrawn");
    const log = await admin.query(
      "select count(*)::int as n from app.request_status_log where request_id = $1",
      [created.id],
    );
    expect(log.rows[0].n).toBe(2);
  });

  it("после отзыва можно подать заново на ту же дату", async () => {
    const res = await post("/requests", tokenA, requestBody(), "tma");
    const again = await json<RequestCreated>(res, 201);
    expect(again.id).not.toBe(created.id);
    expect((await myRequests(tokenA)).map((r) => r.status)).toEqual(["new", "withdrawn"]);
  });
});

describe("лимит заявок клиента за сутки", () => {
  it("сверх client_requests_per_day — 429 daily_request_limit", async () => {
    const { rows } = await admin.query(
      "select value from app.settings where key = 'client_requests_per_day'",
    );
    const original = rows[0].value;
    await admin.query("update app.settings set value = '1' where key = 'client_requests_per_day'");
    try {
      const token = await newClient();
      const first = await post("/requests", token, requestBody({ listingId: listings.cheap.id }));
      expect(first.status).toBe(201);
      const second = await post(
        "/requests",
        token,
        requestBody({ listingId: listings.cheap.id, eventDate: addDays(today, 50) }),
      );
      expect((await json<ApiErrorBody>(second, 429)).error.code).toBe("daily_request_limit");
    } finally {
      await admin.query("update app.settings set value = $1 where key = 'client_requests_per_day'", [
        JSON.stringify(original),
      ]);
    }
  });
});
