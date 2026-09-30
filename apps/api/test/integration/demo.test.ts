// Демо-данные staging на настоящем Postgres, ролью bayramm_api:
//
//   · seed — три зала опубликованы теми же шагами, что в панели (готовность проверяет
//     база), видны клиенту с телефоном и занятыми днями; повторный seed ничего не меняет;
//   · reset — убирает всё демо, в том числе заявку клиента на демо-зал и партнёра,
//     фото — из хранилища; чужое не трогает; повторный reset — нули;
//   · маршрут POST /ops/demo — 404 вне staging при любом ключе; на staging — reset по
//     JSON и, если есть локальный Storage, сквозной seed → reset с фото в multipart.
//
// Хранилище сервиса — в памяти (как в photos.test.ts); настоящий Storage — только
// в последнем блоке и только локальный (TEST_SUPABASE_SERVICE_ROLE_KEY).

import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { LISTING_PHOTOS_BUCKET } from "@bayramm/media";
import { webpFixture } from "@bayramm/media/testing";
import { trimTrailingSlashes } from "@bayramm/shared";
import type { ListingDetail, RequestCreated } from "@bayramm/shared/api";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../../src/db/client";
import { type DemoDeps, resetDemo, seedDemo } from "../../src/demo/service";
import { DEMO_ID_PREFIX, DEMO_VENUES } from "../../src/demo/venues";
import app from "../../src/index";
import { type ObjectStorage, StorageError } from "../../src/storage/supabase";
import { addDays, tashkentToday } from "../../src/time";
import { adminClient, apiDatabaseUrl, call, cleanup, loginToken, makeEnv, newTelegramUser } from "./helpers";

const DEMO_KEY = "d".repeat(48);
const STORAGE_URL = trimTrailingSlashes(process.env.TEST_SUPABASE_URL ?? "http://127.0.0.1:54321");
const SERVICE_KEY = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY ?? "";
const IN_RANGE = `${DEMO_ID_PREFIX}%`;

/** Хранилище в памяти: что положили, то и лежит */
function memoryStorage() {
  const objects = new Map<string, Uint8Array>();
  const storage: ObjectStorage = {
    async put(key, body) {
      if (objects.has(key)) throw new StorageError("exists", 409, "exists");
      objects.set(key, body);
    },
    async remove(key) {
      objects.delete(key);
    },
  };
  return { storage, objects };
}

// Девять разных WebP — по три на зал (у каждого своя ширина, значит и свой sha256)
const PHOTOS = Array.from({ length: 9 }, (_, i) => webpFixture({ width: 640 + i, height: 480 }));

// Тексты согласий прогона: версии большие и случайные — старше любых других
const version = 2_000_000_000 + randomInt(0, 147_000_000);
const texts = { vendorContact: randomUUID(), transfer: randomUUID() };
const control = { vendor: randomUUID(), listing: randomUUID() };

let admin: Client;
let db: Db;
let memory: ReturnType<typeof memoryStorage>;
let deps: DemoDeps;
// Журнал действий только на добавление: считаем записи после этого id
let auditFrom = "0";

beforeAll(async () => {
  admin = await adminClient();
  db = createDb(apiDatabaseUrl);
  memory = memoryStorage();
  deps = { db, storage: memory.storage };
  // Под postgres без актора триггеры считают его system
  await admin.query(
    `insert into app.consent_texts (id, purpose, version, locale, body) values
       ($1, 'vendor_contact', $3, 'ru', 'Тест: данные контактного лица'),
       ($2, 'request_transfer', $3, 'ru', 'Тест: передать контакты площадке')`,
    [texts.vendorContact, texts.transfer, version],
  );
  // Чужой вендор с черновиком — reset его не трогает
  await admin.query("insert into app.vendor_accounts (id, name) values ($1, 'Не демо')", [control.vendor]);
  await admin.query(
    "insert into app.listings (id, vendor_id, slug, category_code, name) values ($1, $2, $3, 'hall', 'Не демо')",
    [control.listing, control.vendor, `not-demo-${randomBytes(4).toString("hex")}`],
  );
  // Остатки прошлого прогона, если он оборвался
  await resetDemo(deps);
  const { rows } = await admin.query("select coalesce(max(id), 0)::text as id from app.audit_log");
  auditFrom = rows[0]?.id ?? "0";
});

afterAll(async () => {
  if (deps) await resetDemo(deps).catch(() => {});
  await db?.destroy();
  if (!admin) return;
  await admin.query("delete from app.listings where id = $1", [control.listing]);
  await admin.query("delete from app.vendor_accounts where id = $1", [control.vendor]);
  await admin.query(
    "update app.consent_texts set retired_at = now() where id = any($1::uuid[]) and retired_at is null",
    [Object.values(texts)],
  );
  await cleanup(admin);
  await admin.end();
});

/** Всё, что меняет seed, — для сравнения «до» и «после» повторного прогона */
async function snapshot() {
  const { rows } = await admin.query(
    `select
       (select jsonb_agg(jsonb_build_object('id', v.id, 'updated', v.updated_at) order by v.id)
          from app.vendor_accounts v where v.id::text like $1) as vendors,
       (select jsonb_agg(jsonb_build_object('id', l.id, 'status', l.status, 'version', l.version,
                                            'updated', l.updated_at) order by l.id)
          from app.listings l where l.vendor_id::text like $1) as listings,
       (select count(*)::int from app.photos p join app.listings l on l.id = p.listing_id
          where l.vendor_id::text like $1) as photos,
       (select count(*)::int from app.availability a join app.listings l on l.id = a.listing_id
          where l.vendor_id::text like $1) as busy,
       (select count(*)::int from app.listing_packages k join app.listings l on l.id = k.listing_id
          where l.vendor_id::text like $1) as packages,
       (select count(*)::int from app.audit_log where action like 'demo.%' and id > $2) as audit`,
    [IN_RANGE, auditFrom],
  );
  return rows[0];
}

describe("seed", () => {
  it("три зала опубликованы: чек-лист, фото, пакеты, телефон, занятые дни", async () => {
    const summary = await seedDemo(deps, PHOTOS);
    expect(summary).toEqual({
      mode: "seed",
      venues: 3,
      seeded: 3,
      active: 3,
      created: { vendors: 3, listings: 3, photos: 9, busyDays: 18 },
      published: 3,
    });

    const { rows: listings } = await admin.query(
      `select l.id, l.slug, l.status, l.name, v.name as vendor_name,
              v.contract_signed_at is not null and v.stir_verified_at is not null
                and v.contacts_confirmed_at is not null and v.pd_consent_signed_at is not null as checked,
              v.pd_consent_text_id,
              (select count(*)::int from app.photos p where p.listing_id = l.id and p.status = 'ready'
                 and p.moderation = 'approved' and p.deleted_at is null) as photos,
              (select count(*)::int from app.availability a where a.listing_id = l.id and a.source = 'vendor') as busy,
              (select array_agg(h.to_status::text order by h.id) from app.listing_status_log h
                 where h.listing_id = l.id and h.actor_kind = 'system') as history
         from app.listings l join app.vendor_accounts v on v.id = l.vendor_id
        where v.id::text like $1 order by l.slug`,
      [IN_RANGE],
    );
    expect(listings.map((l) => l.slug)).toEqual(["demo-zal-anor", "demo-zal-chinor", "demo-zal-girih"]);
    for (const l of listings) {
      expect(l).toMatchObject({
        status: "active",
        checked: true,
        pd_consent_text_id: texts.vendorContact,
        photos: 3,
        busy: 6,
        history: ["draft", "review", "active"],
      });
      expect(l.name).toMatch(/^Демо-зал «.+» · Demo zal «.+»$/);
      expect(l.vendor_name).toMatch(/^Демо/);
    }
    // Фото — в хранилище, по ключам карточек
    expect(memory.objects.size).toBe(9);
    for (const key of memory.objects.keys()) expect(key).toMatch(/^listings\/00000000-0000-4000-8000-de/);

    const { rows: audit } = await admin.query(
      `select actor_kind::text, actor_id, object_id, detail from app.audit_log
        where action = 'demo.seed' and id > $1 order by object_id`,
      [auditFrom],
    );
    expect(audit).toEqual(
      DEMO_VENUES.map((venue) => ({
        actor_kind: "system",
        actor_id: null,
        object_id: venue.listingId,
        detail: {
          vendor_created: true,
          checklist_marked: 4,
          listing_created: true,
          photos: 3,
          busy_days: 6,
          published: true,
        },
      })),
    );
  });

  it("клиент видит демо-зал: название с «Демо», телефон до заявки, фото и занятые дни", async () => {
    const venue = DEMO_VENUES[0];
    if (!venue) throw new Error("нет демо-залов");
    const res = await call(`/catalog/listings/${venue.slug}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListingDetail;
    expect(body.name).toBe(venue.name);
    expect(body.phone).toBe(venue.phone);
    expect(body.photos).toHaveLength(3);
    expect(body.description.ru.startsWith("Демонстрационная карточка")).toBe(true);
    expect(body.busyDates).toEqual(venue.busyDays.map((offset) => addDays(tashkentToday(), offset)));
  });

  it("повторный seed ничего не меняет — даже без фото", async () => {
    const before = await snapshot();
    const summary = await seedDemo(deps, []);
    expect(summary).toEqual({
      mode: "seed",
      venues: 3,
      seeded: 3,
      active: 3,
      created: { vendors: 0, listings: 0, photos: 0, busyDays: 0 },
      published: 0,
    });
    expect(await snapshot()).toEqual(before);
    expect(memory.objects.size).toBe(9);
  });
});

describe("reset", () => {
  it("убирает всё демо — с заявкой клиента и партнёром — и ничего больше", async () => {
    const venue = DEMO_VENUES[1];
    if (!venue) throw new Error("нет демо-залов");
    // Клиент подаёт заявку на демо-зал, сотрудник заводит партнёра демо-вендору
    const token = await loginToken(newTelegramUser());
    const res = await call("/requests", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        listingId: venue.listingId,
        occasionCode: "toy",
        eventDate: addDays(tashkentToday(), 30),
        guests: 120,
        contactName: "Тест Клиент",
        contactPhone: "+998 00 000-01-23",
        requestTransferConsentId: texts.transfer,
      }),
    });
    expect(res.status).toBe(201);
    const request = (await res.json()) as RequestCreated;
    await admin.query("insert into app.vendor_users (vendor_id, phone_hash) values ($1, $2)", [
      venue.vendorId,
      randomBytes(32),
    ]);

    const summary = await resetDemo(deps);
    expect(summary).toEqual({
      mode: "reset",
      removed: { vendors: 3, listings: 3, photos: 9, requests: 1, vendorUsers: 1 },
      storageObjects: 9,
    });
    expect(memory.objects.size).toBe(0);

    const { rows } = await admin.query(
      `select (select count(*)::int from app.vendor_accounts where id::text like $1) as vendors,
              (select count(*)::int from app.listings where slug like 'demo-zal-%') as listings,
              (select count(*)::int from app.requests where id = $2) as requests,
              (select count(*)::int from app.listings where id = $3) as control,
              (select count(*)::int from app.audit_log where action = 'demo.reset' and id > $4) as audit`,
      [IN_RANGE, request.id, control.listing, auditFrom],
    );
    expect(rows[0]).toEqual({ vendors: 0, listings: 0, requests: 0, control: 1, audit: 1 });
    // Карточки больше нет и в каталоге
    expect((await call(`/catalog/listings/${venue.slug}`)).status).toBe(404);
  });

  it("повторный reset — нули, журнал не пишется", async () => {
    expect(await resetDemo(deps)).toEqual({
      mode: "reset",
      removed: { vendors: 0, listings: 0, photos: 0, requests: 0, vendorUsers: 0 },
      storageObjects: 0,
    });
    const { rows } = await admin.query(
      "select count(*)::int as n from app.audit_log where action = 'demo.reset' and id > $1",
      [auditFrom],
    );
    expect(rows[0]?.n).toBe(1);
  });
});

// ── маршрут ─────────────────────────────────────────────────────────────────

async function callWith(env: Partial<Env>, init: RequestInit): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  const res = await app.request("/ops/demo", { method: "POST", ...init }, { ...makeEnv(), ...env }, ctx);
  await Promise.all(pending);
  return res;
}

const auth = { Authorization: `Bearer ${DEMO_KEY}` };

describe("POST /ops/demo", () => {
  it("вне staging — 404 при верном ключе, база не тронута", async () => {
    for (const APP_ENV of ["local", "production"] as const) {
      const res = await callWith(
        { APP_ENV, DEMO_SEED_KEY: DEMO_KEY },
        { headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ mode: "reset" }) },
      );
      expect(res.status, APP_ENV).toBe(404);
    }
  });

  it("staging: reset по JSON — 200, счётчики, no-store", async () => {
    // Демо-строк нет — до хранилища дело не доходит, ключ нужен только для настройки
    const res = await callWith(
      { APP_ENV: "staging", DEMO_SEED_KEY: DEMO_KEY, SUPABASE_SERVICE_ROLE_KEY: "unused-without-demo-rows" },
      { headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ mode: "reset" }) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      mode: "reset",
      removed: { vendors: 0, listings: 0, photos: 0, requests: 0, vendorUsers: 0 },
      storageObjects: 0,
    });
  });

  it("staging: seed по одному залу с фото в multipart (как workflow), затем reset — с настоящим Storage", async (ctx) => {
    if (!SERVICE_KEY || !["127.0.0.1", "localhost"].includes(new URL(STORAGE_URL).hostname)) {
      ctx.skip("нет локального Storage (TEST_SUPABASE_SERVICE_ROLE_KEY) — сквозной seed пропущен");
    }
    const env: Partial<Env> = {
      APP_ENV: "staging",
      DEMO_SEED_KEY: DEMO_KEY,
      // Локальный стек — на своём порту (TEST_SUPABASE_URL), а не только на 54321
      SUPABASE_URL: STORAGE_URL as Env["SUPABASE_URL"],
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
    };
    for (const venue of [1, 2, 3]) {
      const form = new FormData();
      form.append("mode", "seed");
      form.append("venue", String(venue));
      for (const [i, bytes] of PHOTOS.slice((venue - 1) * 3, venue * 3).entries()) {
        form.append("photo", new Blob([bytes], { type: "image/webp" }), `demo-${venue}-${i}.webp`);
      }
      const seeded = await callWith(env, { headers: auth, body: form });
      expect(seeded.status, `зал ${venue}`).toBe(200);
      expect(await seeded.json()).toEqual({
        mode: "seed",
        venues: 3,
        seeded: 1,
        active: 1,
        created: { vendors: 1, listings: 1, photos: 3, busyDays: 6 },
        published: 1,
      });
    }

    // Объекты лежат в бакете
    const { rows } = await admin.query(
      `select p.storage_key from app.photos p join app.listings l on l.id = p.listing_id
        where l.vendor_id::text like $1`,
      [IN_RANGE],
    );
    expect(rows).toHaveLength(9);
    const head = (key: string) =>
      fetch(`${STORAGE_URL}/storage/v1/object/public/${LISTING_PHOTOS_BUCKET}/${key}`, { method: "HEAD" });
    expect((await head(rows[0]?.storage_key)).status).toBe(200);

    const reset = new FormData();
    reset.append("mode", "reset");
    const cleaned = await callWith(env, { headers: auth, body: reset });
    expect(cleaned.status).toBe(200);
    expect(await cleaned.json()).toMatchObject({ mode: "reset", storageObjects: 9 });
    expect((await head(rows[0]?.storage_key)).status).not.toBe(200);
  });
});
