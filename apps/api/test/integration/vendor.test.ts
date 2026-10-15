// Кабинет вендора на настоящем Postgres, ролью bayramm_api: вход из Mini App,
// входящие заявки, переходы статусов, данные клиента по согласию, календарь (с
// версией), роли владельца и сотрудника площадки, фото и правки карточки.
// Два вендора (A и B) с опубликованными залами и заявками клиентов — главное:
// вендор A не видит и не трогает ничего у B (404, а не 403).

import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { webpFixture } from "@bayramm/media/testing";
import type {
  ContactChangeList,
  ContactChangeResponse,
  ContactChangeReveal,
} from "@bayramm/shared/api/staff";
import type {
  VendorCalendar,
  VendorCalendarChange,
  VendorContactsSave,
  VendorListing,
  VendorListingSaved,
  VendorMe,
  VendorPhoto,
  VendorPhotoList,
  VendorRequestDetail,
  VendorRequestItem,
  VendorRequestPage,
  VendorRevision,
  VendorRevisionList,
} from "@bayramm/shared/api/vendor";
import { type Client, Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { initDataFor, type TestTelegramUser } from "../../src/testing/init-data";
import {
  addHallBanquets,
  adminClient,
  apiDatabaseUrl,
  BOT_TOKEN,
  bearer,
  call,
  cleanup,
  cleanupStaff,
  inviteStaff,
  loginToken,
  newStaffUsername,
  newTelegramUser,
  staffLoginToken,
  tgIdHash,
} from "./helpers";

let admin: Client;

// Загрузка фото доходит до Storage: только с ключом локального стека (как в CI)
const STORAGE =
  Boolean(process.env.TEST_SUPABASE_SERVICE_ROLE_KEY) &&
  ["127.0.0.1", "localhost", "[::1]"].includes(
    new URL(process.env.TEST_SUPABASE_URL ?? "http://127.0.0.1:54321").hostname,
  );

// ── данные теста: случайные id, чтобы не мешать остальным данным базы ───────

const run = randomBytes(3).toString("hex");
const consentTextId = randomUUID();
const vendorConsentTextId = randomUUID();

interface TestVendor {
  accountId: string;
  userId: string;
  telegram: TestTelegramUser;
  listingId: string;
  draftId: string;
  token: string;
}

interface TestRequest {
  id: string;
  clientId: string;
  listingId: string;
  eventDate: string;
}

const vendors: TestVendor[] = [];
const clients: string[] = [];
const requests: TestRequest[] = [];
/** Витрины, которые заводят сами тесты (отправка на проверку) */
const extraListings: string[] = [];

const days = (n: number) => {
  // Сегодня по Ташкенту + n дней, как считает API
  const today = new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
  return new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
};

function vendorTelegramUser(): TestTelegramUser {
  return { id: 6_000_000_000 + randomInt(0, 999_999_999), first_name: "Vendor", language_code: "ru" };
}

/** Вход кабинета из Mini App: POST /auth/telegram { initData, app: "vendor" } */
async function vendorLogin(user: TestTelegramUser): Promise<Response> {
  return call("/auth/telegram", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ initData: await initDataFor(user, { botToken: BOT_TOKEN }), app: "vendor" }),
  });
}

async function vendorToken(user: TestTelegramUser): Promise<string> {
  const res = await vendorLogin(user);
  if (res.status !== 200) throw new Error(`вход вендора не удался: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { token: string }).token;
}

/** Опубликованный зал: всё, что требует app.listing_publish_blockers, под postgres (актор — system) */
async function createActiveListing(vendorId: string, name: string): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `insert into app.listings (id, vendor_id, slug, category_code, name, district_code, description_ru,
                               description_uz, price_from_uzs, price_unit, cap_min, cap_max)
     values ($1, $2, $3, 'hall', $4, 'yunusobod', 'Описание', 'Tavsif', 150000, 'per_guest', 50, 300)`,
    [id, vendorId, `test-vendor-${run}-${randomBytes(3).toString("hex")}`, name],
  );
  await admin.query(
    "insert into pii.listing_contacts (listing_id, public_phone) values ($1, '+998000000999')",
    [id],
  );
  await addHallBanquets(admin, id, 150_000, 180_000);
  for (let n = 0; n < 3; n++) {
    await admin.query(
      `insert into app.photos (listing_id, status, moderation, storage_key, mime, bytes, width, height, sha256,
                               sort, is_cover, no_faces_ack)
       values ($1, 'ready', 'approved', $2, 'image/webp', 1000, 1600, 1200, $3, $4, $5, true)`,
      [id, `listings/${id}/${randomUUID()}.webp`, randomBytes(32), n, n === 0],
    );
  }
  await admin.query("update app.listings set status = 'review' where id = $1", [id]);
  await admin.query("update app.listings set status = 'active' where id = $1", [id]);
  return id;
}

async function createVendor(label: string): Promise<TestVendor> {
  const accountId = randomUUID();
  const userId = randomUUID();
  const telegram = vendorTelegramUser();
  await admin.query(
    `insert into app.vendor_accounts (id, legal_form, contract_no, contract_signed_at, stir_verified_at,
                                      contacts_confirmed_at, pd_consent_signed_at, pd_consent_text_id)
     values ($1, 'ooo', $2, now(), now(), now(), now(), $3)`,
    [accountId, `T-${run}-${label}`, vendorConsentTextId],
  );
  await admin.query("insert into pii.vendor_contacts (vendor_id, legal_name) values ($1, $2)", [
    accountId,
    `Test Vendor ${label}`,
  ]);
  // Привязка к Telegram — как её делает бот: псевдоним Telegram ID и время привязки
  await admin.query(
    `insert into app.vendor_users (id, vendor_id, phone_hash, tg_user_hash, tg_linked_at)
     values ($1, $2, $3, $4, now())`,
    [userId, accountId, randomBytes(32), tgIdHash(telegram.id)],
  );
  await admin.query(
    "insert into pii.vendor_user_profiles (vendor_user_id, phone, full_name) values ($1, '+998000000111', $2)",
    [userId, `Manager ${label}`],
  );
  const listingId = await createActiveListing(accountId, `Test Hall ${label}`);
  const draftId = randomUUID();
  await admin.query(
    "insert into app.listings (id, vendor_id, slug, category_code, name) values ($1, $2, $3, 'hall', $4)",
    [draftId, accountId, `test-draft-${run}-${label.toLowerCase()}`, `Draft ${label}`],
  );
  const vendor = { accountId, userId, telegram, listingId, draftId, token: "" };
  vendors.push(vendor);
  return vendor;
}

async function createClient(): Promise<string> {
  const id = randomUUID();
  await admin.query("insert into app.clients (id, tg_id_hash) values ($1, $2)", [id, randomBytes(32)]);
  clients.push(id);
  return id;
}

/** Заявка клиента с согласием на передачу контактов этому листингу */
async function createRequest(clientId: string, listingId: string, eventDate: string): Promise<TestRequest> {
  const consent = randomUUID();
  await admin.query(
    `insert into app.consents (id, subject_kind, subject_id, purpose, action, text_id, scope_listing_id, source)
     values ($1, 'client', $2, 'request_transfer', 'grant', $3, $4, 'tma')`,
    [consent, clientId, consentTextId, listingId],
  );
  const id = randomUUID();
  await admin.query(
    `insert into app.requests (id, client_id, listing_id, vendor_id, consent_id, occasion_code, event_date, guests,
                               budget_min_uzs, budget_max_uzs, source)
     select $1, $2, $3, l.vendor_id, $4, 'toy', $5, 200, 40000000, 60000000, 'tma' from app.listings l where l.id = $3`,
    [id, clientId, listingId, consent, eventDate],
  );
  await admin.query(
    `insert into pii.request_contacts (request_id, contact_name, contact_phone, comment)
     values ($1, 'Client Test', '+998000000301', 'Нужен зал на вечер')`,
    [id],
  );
  const request = { id, clientId, listingId, eventDate };
  requests.push(request);
  return request;
}

const json = { "content-type": "application/json" };
const patch = (token: string, body: unknown): RequestInit => ({
  method: "PATCH",
  headers: { ...json, Authorization: `Bearer ${token}` },
  body: JSON.stringify(body),
});
const as = (token: string, method: string): RequestInit => ({
  method,
  headers: { Authorization: `Bearer ${token}` },
});
/** Правка календаря от версии, которую видел человек */
const at = (token: string, method: string, version: number | string): RequestInit => ({
  method,
  headers: { Authorization: `Bearer ${token}`, "If-Match": String(version) },
});

/** Версия календаря площадки — как её видит кабинет */
async function calendarVersion(token: string, listingId: string): Promise<number> {
  const res = await call(`/vendor/listings/${listingId}/calendar`, bearer(token));
  if (res.status !== 200) throw new Error(`календарь: ${res.status}`);
  return ((await res.json()) as VendorCalendar).version;
}

let A: TestVendor;
let B: TestVendor;
let ra1: TestRequest;
let ra2: TestRequest;
let rb: TestRequest;

// Переход статуса запускает немедленную отправку уведомлений (outboxKick): в тестах
// она не должна ходить в настоящий Telegram — сеть к нему «недоступна», строки
// остаются для повтора
const realFetch = globalThis.fetch;
vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input instanceof Request ? input.url : input).startsWith("https://api.telegram.org/")) {
    throw new TypeError("Telegram is offline in tests");
  }
  return realFetch(input, init);
});

beforeAll(async () => {
  admin = await adminClient();
  const version = randomInt(1_000, 1_000_000_000);
  await admin.query(
    `insert into app.consent_texts (id, purpose, version, locale, body) values
       ($1, 'request_transfer', $3, 'ru', 'Тестовый текст: передать контакты вендору'),
       ($2, 'vendor_contact', $3, 'ru', 'Тестовый текст: данные контактного лица')`,
    [consentTextId, vendorConsentTextId, version],
  );
  A = await createVendor("A");
  B = await createVendor("B");
  const c1 = await createClient();
  const c2 = await createClient();
  ra1 = await createRequest(c1, A.listingId, days(40));
  ra2 = await createRequest(c1, A.listingId, days(41));
  rb = await createRequest(c2, B.listingId, days(40));
  A.token = await vendorToken(A.telegram);
  B.token = await vendorToken(B.telegram);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  if (!admin) return;
  await cleanup(admin);
  await cleanupStaff(admin);
  // Журналы (статусы, согласия, чтения ПДн) — только на добавление; тестовые строки
  // убираем в режиме реплики, где пользовательские триггеры не срабатывают
  try {
    await admin.query("set session_replication_role = replica");
    const ids = requests.map((r) => r.id);
    const accounts = vendors.map((v) => v.accountId);
    const listings = [...vendors.flatMap((v) => [v.listingId, v.draftId]), ...extraListings];
    await admin.query("delete from app.request_status_log where request_id = any($1::uuid[])", [ids]);
    await admin.query("delete from app.pii_access_log where subject_id = any($1::uuid[])", [
      [...ids, ...listings],
    ]);
    await admin.query("delete from app.audit_log where object_id = any($1::text[])", [ids]);
    await admin.query("delete from app.outbox where request_id = any($1::uuid[])", [ids]);
    // Оповещения команды о правках карточек тестовых площадок
    await admin.query(
      `delete from app.outbox where kind = 'ops.revision_submitted' and payload ->> 'revision_id' in (
         select id::text from app.listing_revisions where listing_id = any($1::uuid[]))`,
      [vendors.flatMap((v) => [v.listingId, v.draftId])],
    );
    // Оповещения команды о фото, услугах и отправке на проверку; «некому отправить» — в журнале
    await admin.query(
      `delete from app.outbox where kind in ('ops.photos_submitted', 'ops.service_submitted', 'ops.listing_submitted')
         and payload ->> 'listing_id' = any($1::text[])`,
      [listings],
    );
    await admin.query(
      "delete from app.outbox where kind in ('vendor.service_decided', 'vendor.contact_change_decided') and recipient_id = any($1::uuid[])",
      [vendors.map((v) => v.userId)],
    );
    // Запросы на смену контактов и оповещения о них (в режиме реплики каскад не срабатывает)
    await admin.query("delete from pii.listing_contact_changes where listing_id = any($1::uuid[])", [
      listings,
    ]);
    await admin.query(
      "delete from app.outbox where kind = 'ops.contact_change_submitted' and payload ->> 'listing_id' = any($1::text[])",
      [listings],
    );
    await admin.query("delete from app.audit_log where object_id = any($1::text[])", [listings]);
    await admin.query("delete from app.listing_status_log where listing_id = any($1::uuid[])", [listings]);
    await admin.query("delete from app.availability where listing_id = any($1::uuid[])", [listings]);
    await admin.query("delete from pii.request_contacts where request_id = any($1::uuid[])", [ids]);
    await admin.query("delete from app.requests where id = any($1::uuid[])", [ids]);
    await admin.query("delete from app.consents where subject_id = any($1::uuid[])", [clients]);
    await admin.query("delete from app.clients where id = any($1::uuid[])", [clients]);
    await admin.query("delete from app.photos where listing_id = any($1::uuid[])", [listings]);
    // Услуги и части дня — в режиме реплики каскад не срабатывает
    await admin.query("delete from app.listing_services where listing_id = any($1::uuid[])", [listings]);
    await admin.query("delete from app.availability_parts where listing_id = any($1::uuid[])", [listings]);
    await admin.query("delete from pii.listing_contacts where listing_id = any($1::uuid[])", [listings]);
    await admin.query("delete from app.listings where id = any($1::uuid[])", [listings]);
    await admin.query("delete from app.sessions where vendor_user_id = any($1::uuid[])", [
      vendors.map((v) => v.userId),
    ]);
    const partnerAccounts = await admin.query<{ id: string }>(
      "select distinct account_id as id from app.vendor_users where vendor_id = any($1::uuid[]) and account_id is not null",
      [accounts],
    );
    await admin.query("delete from app.vendor_users where vendor_id = any($1::uuid[])", [accounts]);
    await admin.query("delete from app.sessions where account_id = any($1::uuid[])", [
      partnerAccounts.rows.map((r) => r.id),
    ]);
    await admin.query("delete from app.account_identities where account_id = any($1::uuid[])", [
      partnerAccounts.rows.map((r) => r.id),
    ]);
    await admin.query("delete from pii.account_profiles where account_id = any($1::uuid[])", [
      partnerAccounts.rows.map((r) => r.id),
    ]);
    await admin.query("delete from app.accounts where id = any($1::uuid[])", [
      partnerAccounts.rows.map((r) => r.id),
    ]);
    await admin.query("delete from pii.vendor_contacts where vendor_id = any($1::uuid[])", [accounts]);
    await admin.query("delete from app.vendor_accounts where id = any($1::uuid[])", [accounts]);
    await admin.query("delete from app.consent_texts where id = any($1::uuid[])", [
      [consentTextId, vendorConsentTextId],
    ]);
  } catch (err) {
    console.warn("[vendor] уборка тестовых данных не удалась — строки останутся в локальной базе", err);
  } finally {
    await admin.query("reset session_replication_role").catch(() => {});
    await admin.end();
  }
});

// ── вход ────────────────────────────────────────────────────────────────────

describe("POST /auth/telegram { app: vendor }", () => {
  it("привязанный Telegram — сессия аккаунта партнёра на 7 дней, via tg_webapp, отметка входа", async () => {
    const res = await vendorLogin(A.telegram);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expiresAt: string };
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const ttl = Date.parse(body.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(7 * 24 * 3600 * 1000 - 60_000);
    expect(ttl).toBeLessThanOrEqual(7 * 24 * 3600 * 1000);

    // Роль партнёра — не в сессии, а в членстве аккаунта: сессия только аккаунта
    const { rows } = await admin.query<{
      via: string;
      app: string;
      vendor_user_id: string | null;
      mine: boolean;
    }>(
      `select s.via, s.app, s.vendor_user_id, s.account_id = u.account_id as mine
       from app.sessions s, app.vendor_users u where s.token_hash = $1 and u.id = $2`,
      [createHash("sha256").update(body.token).digest(), A.userId],
    );
    expect(rows).toEqual([{ via: "tg_webapp", app: "vendor", vendor_user_id: null, mine: true }]);
    const { rows: users } = await admin.query<{ locale: string; logged_in: boolean }>(
      "select locale, last_login_at is not null as logged_in from app.vendor_users where id = $1",
      [A.userId],
    );
    // Первый вход взял язык из Telegram
    expect(users).toEqual([{ locale: "ru", logged_in: true }]);
  });

  it("Telegram не привязан — 403 vendor_not_linked; клиентом он при этом не становится", async () => {
    const stranger = newTelegramUser();
    const res = await vendorLogin(stranger);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("vendor_not_linked");
    const { rows } = await admin.query("select 1 from app.clients where tg_id_hash = $1", [
      tgIdHash(stranger.id),
    ]);
    expect(rows).toEqual([]);
  });

  it("чужая подпись — 401", async () => {
    const initData = await initDataFor(A.telegram, { botToken: "999:other-bot-token" });
    const res = await call("/auth/telegram", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ initData, app: "vendor" }),
    });
    expect(res.status).toBe(401);
  });

  it("устаревший POST /auth/vendor/telegram для старых сборок работает так же и пишет в лог", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await call("/auth/vendor/telegram", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ initData: await initDataFor(A.telegram, { botToken: BOT_TOKEN }) }),
    });
    expect(res.status).toBe(200);
    const token = ((await res.json()) as { token: string }).token;
    expect((await call("/vendor/me", bearer(token))).status).toBe(200);
    expect(warn).toHaveBeenCalledWith("auth.legacy: deprecated endpoint used", {
      path: "/auth/vendor/telegram",
    });
    warn.mockRestore();
  });
});

describe("доступ к /vendor", () => {
  it("без сессии — 401, сессия клиента — 403", async () => {
    expect((await call("/vendor/me")).status).toBe(401);
    const clientToken = await loginToken(newTelegramUser());
    expect((await call("/vendor/me", bearer(clientToken))).status).toBe(403);
    expect((await call("/vendor/requests", bearer(clientToken))).status).toBe(403);
  });

  it("GET /vendor/me: код вендора, свои листинги, язык", async () => {
    const res = await call("/vendor/me", bearer(A.token));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const me = (await res.json()) as VendorMe;
    expect(me.user).toEqual({ id: A.userId, locale: "ru", fullName: "Manager A", role: "owner" });
    expect(me.vendor.id).toBe(A.accountId);
    expect(me.vendor.code).toMatch(/^V\d+$/);
    expect(me.listings.map((l) => [l.id, l.status])).toEqual([
      [A.listingId, "active"],
      [A.draftId, "draft"],
    ]);
  });

  it("PATCH /vendor/me меняет язык", async () => {
    const res = await call("/vendor/me", patch(A.token, { locale: "uz" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as VendorMe).user.locale).toBe("uz");
    expect((await call("/vendor/me", patch(A.token, { locale: "en" }))).status).toBe(422);
  });
});

// ── изоляция вендоров ───────────────────────────────────────────────────────

describe("вендор A не видит ничего у вендора B", () => {
  it("список входящих — только свои заявки", async () => {
    const page = (await (
      await call("/vendor/requests?tab=waiting", bearer(A.token))
    ).json()) as VendorRequestPage;
    const ids = page.items.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([ra1.id, ra2.id]));
    expect(ids).not.toContain(rb.id);
    expect(page.items.every((r) => r.listing.id === A.listingId)).toBe(true);
  });

  it("чужая заявка: карточка, переход и звонок — 404", async () => {
    expect((await call(`/vendor/requests/${rb.id}`, bearer(A.token))).status).toBe(404);
    expect((await call(`/vendor/requests/${rb.id}`, patch(A.token, { status: "contacted" }))).status).toBe(
      404,
    );
    expect((await call(`/vendor/requests/${rb.id}/call`, as(A.token, "POST"))).status).toBe(404);
    const { rows } = await admin.query<{ status: string }>("select status from app.requests where id = $1", [
      rb.id,
    ]);
    expect(rows[0]?.status).toBe("new");
    const { rows: reads } = await admin.query("select 1 from app.pii_access_log where subject_id = $1", [
      rb.id,
    ]);
    expect(reads).toEqual([]);
  });

  it("чужой листинг, даже опубликованный: карточка и календарь — 404", async () => {
    expect((await call(`/vendor/listings/${B.listingId}`, bearer(A.token))).status).toBe(404);
    expect((await call(`/vendor/listings/${B.listingId}/calendar`, bearer(A.token))).status).toBe(404);
    expect(
      (await call(`/vendor/listings/${B.listingId}/calendar/${days(5)}`, at(A.token, "PUT", 0))).status,
    ).toBe(404);
    expect(
      (await call(`/vendor/listings/${B.listingId}/calendar/${days(5)}`, at(A.token, "DELETE", 0))).status,
    ).toBe(404);
    const { rows } = await admin.query("select 1 from app.availability where listing_id = $1", [B.listingId]);
    expect(rows).toEqual([]);
  });
});

// ── заявки ──────────────────────────────────────────────────────────────────

describe("заявки вендора A", () => {
  it("список: вкладки со счётчиками, срок ответа, имя клиента без телефона", async () => {
    const page = (await (
      await call("/vendor/requests?tab=waiting", bearer(A.token))
    ).json()) as VendorRequestPage;
    expect(page.counts).toEqual({ waiting: 2, active: 0, closed: 0 });
    // Срок ответа ни у одной не вышел
    expect(page.overdue).toBe(0);
    const item = page.items.find((r) => r.id === ra1.id) as VendorRequestItem;
    expect(item).toMatchObject({
      status: "new",
      eventDate: ra1.eventDate,
      guests: 200,
      budgetMinUzs: 40_000_000,
      budgetMaxUzs: 60_000_000,
      occasionCode: "toy",
      contactName: "Client Test",
      listing: { id: A.listingId, name: "Test Hall A" },
      // Ответа ещё нет: ни времени, ни того, кто ответил
      firstResponseBy: null,
    });
    expect(Date.parse(item.sla.dueAt) - Date.parse(item.createdAt)).toBe(12 * 3600 * 1000);
    expect(item.sla).toMatchObject({ firstResponseAt: null, breached: false });
    expect(JSON.stringify(page)).not.toContain("+998");
    // Сначала та, где время истекает раньше: ra1 подана раньше ra2 — её срок ближе
    expect(page.items.map((r) => r.id)).toEqual([ra1.id, ra2.id]);
  });

  it("постранично: курсор продолжает с того же места", async () => {
    const first = (await (
      await call("/vendor/requests?tab=waiting&limit=1", bearer(A.token))
    ).json()) as VendorRequestPage;
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = (await (
      await call(`/vendor/requests?tab=waiting&limit=1&cursor=${first.nextCursor}`, bearer(A.token))
    ).json()) as VendorRequestPage;
    expect(second.items).toHaveLength(1);
    expect([first.items[0]?.id, second.items[0]?.id]).toEqual([ra1.id, ra2.id]);
    expect(second.nextCursor).toBeNull();
    // Курсор открытой вкладки не подходит закрытой
    const other = await call(`/vendor/requests?tab=closed&cursor=${first.nextCursor}`, bearer(A.token));
    expect(other.status).toBe(422);
  });

  it("открытие новой заявки: просмотрена, телефон клиента — с записью в журнал", async () => {
    const res = await call(`/vendor/requests/${ra1.id}`, bearer(A.token));
    expect(res.status).toBe(200);
    const detail = (await res.json()) as VendorRequestDetail;
    expect(detail.status).toBe("viewed");
    expect(detail.contact).toEqual({
      name: "Client Test",
      phone: "+998000000301",
      comment: "Нужен зал на вечер",
    });
    expect(detail.history.map((h) => [h.status, h.by])).toEqual([
      ["new", "system"],
      ["viewed", "vendor_user"],
    ]);

    const { rows: log } = await admin.query<{ actor_id: string; source: string }>(
      "select actor_id, source from app.request_status_log where request_id = $1 and to_status = 'viewed'",
      [ra1.id],
    );
    expect(log).toEqual([{ actor_id: A.userId, source: "vendor_cabinet" }]);
    const { rows: reads } = await admin.query<{ actor_kind: string; actor_id: string; purpose: string }>(
      "select actor_kind, actor_id, purpose from app.pii_access_log where subject_id = $1",
      [ra1.id],
    );
    expect(reads).toEqual([{ actor_kind: "vendor_user", actor_id: A.userId, purpose: "request_inbox" }]);

    // Открыть — не ответить: просмотренная остаётся в «Ждут ответа»
    const page = (await (
      await call("/vendor/requests?tab=waiting", bearer(A.token))
    ).json()) as VendorRequestPage;
    expect(page.items.map((r) => [r.id, r.status])).toContainEqual([ra1.id, "viewed"]);
    expect(page.counts).toMatchObject({ waiting: 2, active: 0 });
    // Прежнее имя вкладки (старые сборки кабинета) — та же вкладка
    const legacy = (await (
      await call("/vendor/requests?tab=new", bearer(A.token))
    ).json()) as VendorRequestPage;
    expect(legacy.items.map((r) => r.id)).toEqual(page.items.map((r) => r.id));
  });

  it("звонок клиенту — событие в журнале действий, статус не меняется", async () => {
    expect((await call(`/vendor/requests/${ra1.id}/call`, as(A.token, "POST"))).status).toBe(204);
    const { rows } = await admin.query<{
      actor_kind: string;
      actor_id: string;
      source: string;
      detail: unknown;
    }>(
      "select actor_kind, actor_id, source, detail from app.audit_log where action = 'request.call_attempt' and object_id = $1",
      [ra1.id],
    );
    expect(rows).toEqual([
      { actor_kind: "vendor_user", actor_id: A.userId, source: "vendor_cabinet", detail: {} },
    ]);
  });

  it("переходы: только по таблице переходов; первый ответ засчитан вендору", async () => {
    const deal = await call(`/vendor/requests/${ra1.id}`, patch(A.token, { status: "deal" }));
    expect(deal.status).toBe(409);
    expect(((await deal.json()) as { error: { code: string } }).error.code).toBe("illegal_transition");

    const contacted = await call(`/vendor/requests/${ra1.id}`, patch(A.token, { status: "contacted" }));
    expect(contacted.status).toBe(200);
    const item = (await contacted.json()) as VendorRequestItem;
    expect(item.status).toBe("contacted");
    expect(item.sla.firstResponseAt).not.toBeNull();
    expect(item.firstResponseBy).toBe("vendor_user");

    // Повтор того же действия — не ошибка
    expect((await call(`/vendor/requests/${ra1.id}`, patch(A.token, { status: "contacted" }))).status).toBe(
      200,
    );
    const done = await call(`/vendor/requests/${ra1.id}`, patch(A.token, { status: "deal" }));
    expect(((await done.json()) as VendorRequestItem).status).toBe("deal");
    const reopened = await call(`/vendor/requests/${ra1.id}`, patch(A.token, { status: "contacted" }));
    expect(((await reopened.json()) as VendorRequestItem).status).toBe("contacted");

    const { rows } = await admin.query<{ first_response_by: string }>(
      "select first_response_by from app.requests where id = $1",
      [ra1.id],
    );
    expect(rows[0]?.first_response_by).toBe("vendor_user");
  });

  it("вкладки: просмотренная без ответа — в «Ждут ответа», «связались» — в «В работе»", async () => {
    // ra1 уже «связались»; ra2 открываем — просмотрена, ответа ещё нет
    expect((await call(`/vendor/requests/${ra2.id}`, bearer(A.token))).status).toBe(200);
    const waiting = (await (
      await call("/vendor/requests?tab=waiting", bearer(A.token))
    ).json()) as VendorRequestPage;
    expect(waiting.items.map((r) => [r.id, r.status])).toEqual([[ra2.id, "viewed"]]);
    const active = (await (
      await call("/vendor/requests?tab=active", bearer(A.token))
    ).json()) as VendorRequestPage;
    expect(active.items.map((r) => [r.id, r.status])).toEqual([[ra1.id, "contacted"]]);
    expect(active.counts).toEqual({ waiting: 1, active: 1, closed: 0 });
  });

  it("«Я связался» по ошибке: отмена в первые секунды тем же партнёром; второй раз — 409", async () => {
    const marked = await call(`/vendor/requests/${ra2.id}`, patch(A.token, { status: "contacted" }));
    expect(((await marked.json()) as VendorRequestItem).status).toBe("contacted");
    const undo = await call(`/vendor/requests/${ra2.id}/undo`, as(A.token, "POST"));
    expect(undo.status).toBe(200);
    const item = (await undo.json()) as VendorRequestItem;
    expect([item.status, item.sla.firstResponseAt, item.firstResponseBy]).toEqual(["viewed", null, null]);
    const again = await call(`/vendor/requests/${ra2.id}/undo`, as(A.token, "POST"));
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe("undo_expired");
    // Чужую заявку не отменить: её как будто нет
    expect((await call(`/vendor/requests/${rb.id}/undo`, as(A.token, "POST"))).status).toBe(404);
    // В истории отметки и её отмены нет: нажатие по ошибке — не шаг заявки
    const detail = (await (
      await call(`/vendor/requests/${ra2.id}`, bearer(A.token))
    ).json()) as VendorRequestDetail;
    expect(detail.history.map((h) => h.status)).toEqual(["new", "viewed"]);
  });

  it("отказ без причины — 422; «занято» занимает дату, возврат её освобождает", async () => {
    expect((await call(`/vendor/requests/${ra2.id}`, patch(A.token, { status: "declined" }))).status).toBe(
      422,
    );

    const res = await call(
      `/vendor/requests/${ra2.id}`,
      patch(A.token, { status: "declined", declineReason: "busy", declineNote: "Свадьба у другой пары" }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as VendorRequestItem).declineReason).toBe("busy");

    const calendar = (await (
      await call(
        `/vendor/listings/${A.listingId}/calendar?month=${ra2.eventDate.slice(0, 7)}`,
        bearer(A.token),
      )
    ).json()) as VendorCalendar;
    expect(calendar.busy).toContainEqual({
      day: ra2.eventDate,
      source: "request_decline",
      requestId: ra2.id,
    });

    const detail = (await (
      await call(`/vendor/requests/${ra2.id}`, bearer(A.token))
    ).json()) as VendorRequestDetail;
    expect(detail.declineNote).toBe("Свадьба у другой пары");

    await call(`/vendor/requests/${ra2.id}`, patch(A.token, { status: "contacted" }));
    const { rows } = await admin.query("select 1 from app.availability where listing_id = $1 and day = $2", [
      A.listingId,
      ra2.eventDate,
    ]);
    expect(rows).toEqual([]);
  });

  it("клиент отозвал согласие — имени, телефона и комментария больше нет, чтений не прибавилось", async () => {
    const { rows: before } = await admin.query("select 1 from app.pii_access_log where subject_id = $1", [
      ra1.id,
    ]);
    await admin.query(
      `insert into app.consents (subject_kind, subject_id, purpose, action, text_id, scope_listing_id, source)
       values ('client', $1, 'request_transfer', 'withdraw', $2, $3, 'tma')`,
      [ra1.clientId, consentTextId, A.listingId],
    );
    const detail = (await (
      await call(`/vendor/requests/${ra1.id}`, bearer(A.token))
    ).json()) as VendorRequestDetail;
    expect(detail.contact).toBeNull();
    expect(detail.contactName).toBeNull();
    const page = (await (
      await call("/vendor/requests?tab=active", bearer(A.token))
    ).json()) as VendorRequestPage;
    expect(page.items.find((r) => r.id === ra1.id)?.contactName).toBeNull();
    const { rows: after } = await admin.query("select 1 from app.pii_access_log where subject_id = $1", [
      ra1.id,
    ]);
    expect(after).toHaveLength(before.length);
  });
});

// ── календарь и площадка ────────────────────────────────────────────────────

describe("календарь вендора A", () => {
  it("отметить и освободить день; повтор — не ошибка; каждая правка — от новой версии", async () => {
    const day = days(10);
    const url = `/vendor/listings/${A.listingId}/calendar/${day}`;
    const v0 = await calendarVersion(A.token, A.listingId);
    const busy = await call(url, at(A.token, "PUT", v0));
    expect(busy.status).toBe(200);
    const marked = (await busy.json()) as VendorCalendarChange;
    expect(marked).toEqual({
      day,
      part: null,
      busy: { day, source: "vendor", requestId: null },
      version: v0 + 1,
    });
    expect(busy.headers.get("etag")).toBe(`"${v0 + 1}"`);
    // Повтор: день уже занят — версия прежняя
    const again = (await (
      await call(url, at(A.token, "PUT", `"${marked.version}"`))
    ).json()) as VendorCalendarChange;
    expect(again.version).toBe(marked.version);

    const { rows } = await admin.query<{ created_by: string }>(
      "select created_by from app.availability where listing_id = $1 and day = $2",
      [A.listingId, day],
    );
    expect(rows).toEqual([{ created_by: A.userId }]);

    const free = await call(url, at(A.token, "DELETE", again.version));
    expect(free.status).toBe(200);
    const freed = (await free.json()) as VendorCalendarChange;
    expect(freed).toEqual({ day, part: null, busy: null, version: again.version + 1 });
    expect((await call(url, at(A.token, "DELETE", freed.version))).status).toBe(200);
  });

  it("правка без версии — 428; от устаревшей — 409 calendar_conflict, ничего не меняется", async () => {
    const day = days(12);
    const url = `/vendor/listings/${A.listingId}/calendar/${day}`;
    const missing = await call(url, as(A.token, "PUT"));
    expect(missing.status).toBe(428);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("version_required");
    expect((await call(url, at(A.token, "PUT", "abc"))).status).toBe(422);

    const seen = await calendarVersion(A.token, A.listingId);
    // Тем временем менеджер закрыл другой день в панели
    await admin.query("insert into app.availability (listing_id, day, source) values ($1, $2, 'staff')", [
      A.listingId,
      days(13),
    ]);
    const stale = await call(url, at(A.token, "PUT", seen));
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe("calendar_conflict");
    const { rows } = await admin.query("select 1 from app.availability where listing_id = $1 and day = $2", [
      A.listingId,
      day,
    ]);
    expect(rows).toEqual([]);
    // Перечитали — правка проходит
    expect((await call(url, at(A.token, "PUT", await calendarVersion(A.token, A.listingId)))).status).toBe(
      200,
    );
  });

  it("одновременные правки от одной версии: проходит одна, вторая — конфликт", async () => {
    const seen = await calendarVersion(A.token, A.listingId);
    const [first, second] = await Promise.all([
      call(`/vendor/listings/${A.listingId}/calendar/${days(14)}`, at(A.token, "PUT", seen)),
      call(`/vendor/listings/${A.listingId}/calendar/${days(15)}`, at(A.token, "PUT", seen)),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
  });

  it("день, закрытый сотрудником, вендор не освобождает — 403", async () => {
    const day = days(11);
    await admin.query("insert into app.availability (listing_id, day, source) values ($1, $2, 'staff')", [
      A.listingId,
      day,
    ]);
    const version = await calendarVersion(A.token, A.listingId);
    const res = await call(`/vendor/listings/${A.listingId}/calendar/${day}`, at(A.token, "DELETE", version));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("forbidden_for_actor");
    const calendar = (await (
      await call(`/vendor/listings/${A.listingId}/calendar?month=${day.slice(0, 7)}`, bearer(A.token))
    ).json()) as VendorCalendar;
    expect(calendar.busy).toContainEqual({ day, source: "staff", requestId: null });
  });

  it("прошедший день и кривая дата — 422", async () => {
    const past = await call(`/vendor/listings/${A.listingId}/calendar/${days(-1)}`, at(A.token, "PUT", 0));
    expect(past.status).toBe(422);
    expect(((await past.json()) as { error: { code: string } }).error.code).toBe("date_out_of_range");
    expect(
      (await call(`/vendor/listings/${A.listingId}/calendar/2026-02-30`, at(A.token, "PUT", 0))).status,
    ).toBe(422);
    // Прошлое не правится и в обход API: день по Ташкенту, для всех
    await expect(
      admin.query("insert into app.availability (listing_id, day) values ($1, $2)", [A.listingId, days(-1)]),
    ).rejects.toMatchObject({ code: "BR024" });
    expect(
      (await call(`/vendor/listings/${A.listingId}/calendar?month=2026-13`, bearer(A.token))).status,
    ).toBe(422);
  });

  it("дни открытых заявок отмечены в месяце", async () => {
    const calendar = (await (
      await call(
        `/vendor/listings/${A.listingId}/calendar?month=${ra1.eventDate.slice(0, 7)}`,
        bearer(A.token),
      )
    ).json()) as VendorCalendar;
    expect(calendar.requestDays).toContain(ra1.eventDate);
    expect(calendar.today).toBe(days(0));
  });
});

describe("площадка вендора A", () => {
  it("карточка как есть: цена «от» из услуг, фото с воркера media, телефон", async () => {
    const res = await call(`/vendor/listings/${A.listingId}`, bearer(A.token));
    expect(res.status).toBe(200);
    const listing = (await res.json()) as VendorListing;
    expect(listing).toMatchObject({
      id: A.listingId,
      name: "Test Hall A",
      status: "active",
      priceFromUzs: 150_000,
      priceUnit: "per_guest",
      capMin: 50,
      capMax: 300,
      phone: "+998000000999",
      blockers: [],
    });
    expect(listing).not.toHaveProperty("packages");
    expect(listing.services.map((s) => [s.type, s.priceUzs])).toEqual([
      ["banquet_weekday", 150_000],
      ["banquet_weekend", 180_000],
    ]);
    expect(listing.photos).toHaveLength(3);
    expect(listing.photos[0]?.isCover).toBe(true);
    expect(listing.photos[0]?.src).toMatch(new RegExp(`^http://localhost:8790/640/listings/${A.listingId}/`));
  });

  it("черновик: чего не хватает для публикации", async () => {
    const listing = (await (
      await call(`/vendor/listings/${A.draftId}`, bearer(A.token))
    ).json()) as VendorListing;
    expect(listing.status).toBe("draft");
    expect(listing.blockers).toEqual(expect.arrayContaining(["price", "photos", "phone"]));
  });
});

describe("правки карточки из кабинета", () => {
  const post = (token: string, body: unknown): RequestInit => ({
    method: "POST",
    headers: { ...json, Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const errorOf = async (res: Response) => {
    const body = (await res.json()) as { error: { code: string; details?: string[] } };
    return { status: res.status, code: body.error.code, details: body.error.details };
  };
  const revisionsUrl = (listingId: string) => `/vendor/listings/${listingId}/revisions`;
  let pending: VendorRevision;

  it("пока предложений нет — пустой список", async () => {
    const res = await call(revisionsUrl(A.listingId), bearer(A.token));
    expect(res.status).toBe(200);
    expect(((await res.json()) as VendorRevisionList).items).toEqual([]);
  });

  it("ничего не изменилось — 422 no_changes; неверные поля и чужие ключи — 422 со списком", async () => {
    const same = await call(revisionsUrl(A.listingId), post(A.token, { name: "Test Hall A" }));
    expect(await errorOf(same)).toMatchObject({ status: 422, code: "no_changes" });
    const bad = await call(revisionsUrl(A.listingId), post(A.token, { name: "x", slug: "x" }));
    expect(await errorOf(bad)).toMatchObject({
      status: 422,
      code: "invalid_input",
      details: expect.arrayContaining(["name", "slug"]),
    });
    // Цены и пакеты v0.1 правкой карточки больше не меняются — они в услугах
    const legacy = await call(
      revisionsUrl(A.listingId),
      post(A.token, {
        price_from_uzs: 160_000,
        packages: [{ kind: "weekday", name_ru: "Будни", name_uz: "Ish kuni", price_uzs: 160_000 }],
      }),
    );
    expect(await errorOf(legacy)).toMatchObject({
      status: 422,
      code: "invalid_input",
      details: expect.arrayContaining(["price_from_uzs", "packages"]),
    });
  });

  it("предложение: только изменённые поля, от текущей версии карточки; карточка — прежняя", async () => {
    const res = await call(
      revisionsUrl(A.listingId),
      post(A.token, {
        name: "Test Hall A",
        description_uz: "Yangi tavsif",
        attributes: { halls_count: 2, stage: true },
      }),
    );
    expect(res.status).toBe(201);
    pending = (await res.json()) as VendorRevision;
    expect(pending).toMatchObject({
      status: "pending",
      decidedAt: null,
      decisionReason: null,
      payload: { description_uz: "Yangi tavsif", attributes: { halls_count: 2, stage: true } },
    });
    expect(Object.keys(pending.payload)).toEqual(["description_uz", "attributes"]);

    const { rows } = await admin.query<{ submitted_by: string; same_version: boolean }>(
      `select r.submitted_by, r.base_version = l.version as same_version
       from app.listing_revisions r join app.listings l on l.id = r.listing_id where r.id = $1`,
      [pending.id],
    );
    expect(rows).toEqual([{ submitted_by: A.userId, same_version: true }]);
    // Клиент видит одобренную версию: карточка не изменилась
    const listing = (await (
      await call(`/vendor/listings/${A.listingId}`, bearer(A.token))
    ).json()) as VendorListing;
    expect(listing).toMatchObject({ priceFromUzs: 150_000, description: { uz: "Tavsif" }, attributes: {} });
    // Команде — оповещение: в outbox только id правки
    const outbox = await admin.query<{ payload: unknown }>(
      "select payload from app.outbox where kind = 'ops.revision_submitted' and payload ->> 'revision_id' = $1",
      [pending.id],
    );
    for (const row of outbox.rows) expect(row.payload).toEqual({ revision_id: pending.id });
  });

  it("одна открытая правка на площадку: вторая — 409 revision_pending", async () => {
    const res = await call(revisionsUrl(A.listingId), post(A.token, { name: "Test Hall A+" }));
    expect(await errorOf(res)).toMatchObject({ status: 409, code: "revision_pending" });
  });

  it("чужая площадка и правка — 404", async () => {
    expect((await call(revisionsUrl(A.listingId), bearer(B.token))).status).toBe(404);
    expect((await call(revisionsUrl(A.listingId), post(B.token, { name: "Hijack" }))).status).toBe(404);
    expect(
      (await call(`${revisionsUrl(A.listingId)}/${pending.id}/withdraw`, as(B.token, "POST"))).status,
    ).toBe(404);
    expect(
      (await call(`${revisionsUrl(B.listingId)}/${pending.id}/withdraw`, as(B.token, "POST"))).status,
    ).toBe(404);
  });

  it("отозвать открытую — можно один раз; после — новая правка", async () => {
    const res = await call(`${revisionsUrl(A.listingId)}/${pending.id}/withdraw`, as(A.token, "POST"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as VendorRevision).status).toBe("withdrawn");
    const again = await call(`${revisionsUrl(A.listingId)}/${pending.id}/withdraw`, as(A.token, "POST"));
    expect(await errorOf(again)).toMatchObject({ status: 409, code: "illegal_transition" });
    const next = await call(revisionsUrl(A.listingId), post(A.token, { name: "Test Hall A Grand" }));
    expect(next.status).toBe(201);
    pending = (await next.json()) as VendorRevision;
  });

  it("отказ команды: причина видна партнёру; список — новые первыми", async () => {
    await admin.query(
      "update app.listing_revisions set status = 'declined', decision_reason = 'Название не как на вывеске' where id = $1",
      [pending.id],
    );
    const list = (await (
      await call(revisionsUrl(A.listingId), bearer(A.token))
    ).json()) as VendorRevisionList;
    expect(list.items.map((r) => r.status)).toEqual(["declined", "withdrawn"]);
    expect(list.items[0]).toMatchObject({
      id: pending.id,
      decisionReason: "Название не как на вывеске",
      payload: { name: "Test Hall A Grand" },
    });
    expect(list.items[0]?.decidedAt).not.toBeNull();
  });
});

// ── партнёр сам настраивает витрину ─────────────────────────────────────────

describe("партнёр сам настраивает витрину: сразу, пока её нет на сайте, иначе предложением", () => {
  let C: TestVendor;
  let member: string;
  const save = (token: string, listingId: string, body: unknown) =>
    call(`/vendor/listings/${listingId}`, patch(token, body));
  const readListing = async (token: string, listingId: string) =>
    (await (await call(`/vendor/listings/${listingId}`, bearer(token))).json()) as VendorListing;
  const errorOf = async (res: Response) => {
    const body = (await res.json()) as { error: { code: string; details?: string[] } };
    return { status: res.status, code: body.error.code, details: body.error.details };
  };

  beforeAll(async () => {
    C = await createVendor("C");
    C.token = await vendorToken(C.telegram);
    const userId = randomUUID();
    const telegram = vendorTelegramUser();
    await admin.query(
      `insert into app.vendor_users (id, vendor_id, phone_hash, tg_user_hash, tg_linked_at, role)
       values ($1, $2, $3, $4, now(), 'member')`,
      [userId, C.accountId, randomBytes(32), tgIdHash(telegram.id)],
    );
    await admin.query(
      "insert into pii.vendor_user_profiles (vendor_user_id, phone, full_name) values ($1, '+998000000113', 'Staff C')",
      [userId],
    );
    member = await vendorToken(telegram);
  });

  it("черновик: вместимость, район, адрес, название, описания и поля витрины — сразу, без предложения", async () => {
    const before = await readListing(C.token, C.draftId);
    expect(before.blockers).toEqual(expect.arrayContaining(["capacity", "district"]));
    const res = await save(C.token, C.draftId, {
      version: before.version,
      name: "Зал Лола",
      descriptionRu: "Просторный зал",
      descriptionUz: "Keng zal",
      capMin: 80,
      capMax: 300,
      districtCode: "sergeli",
      addressRu: "ул. Навои, 1",
      addressUz: "Navoiy k., 1",
      attributes: { stage: true, halls_count: 2 },
    });
    expect(res.status).toBe(200);
    const saved = (await res.json()) as VendorListingSaved;
    expect(saved.sentForModeration).toEqual([]);
    expect(saved.listing).toMatchObject({
      name: "Зал Лола",
      capMin: 80,
      capMax: 300,
      districtCode: "sergeli",
      address: { ru: "ул. Навои, 1", uz: "Navoiy k., 1" },
      description: { ru: "Просторный зал", uz: "Keng zal" },
      attributes: { stage: true, halls_count: 2 },
    });
    expect(saved.listing.version).toBeGreaterThan(before.version);
    // Чек-лист: вместимость, район и описания больше не мешают
    for (const code of ["capacity", "district", "descriptions"])
      expect(saved.listing.blockers).not.toContain(code);
    const { rows } = await admin.query("select 1 from app.listing_revisions where listing_id = $1", [
      C.draftId,
    ]);
    expect(rows).toHaveLength(0);
    // Журнал: только имена полей
    const log = await admin.query<{ detail: { fields: string[] }; actor_kind: string; source: string }>(
      "select detail, actor_kind, source from app.audit_log where action = 'listing.vendor_update' and object_id = $1",
      [C.draftId],
    );
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0]?.detail.fields).toEqual(
      expect.arrayContaining(["cap_max", "cap_min", "district_code", "address_ru", "name"]),
    );
    expect(JSON.stringify(log.rows[0]?.detail)).not.toMatch(/Навои|Зал Лола|Просторный/);
    expect(log.rows[0]).toMatchObject({ actor_kind: "vendor_user", source: "vendor_cabinet" });
  });

  it("версия устарела — 409 version_conflict, карточка прежняя; ничего не изменилось — 422 no_changes", async () => {
    const current = await readListing(C.token, C.draftId);
    const stale = await save(C.token, C.draftId, { version: current.version - 1, capMax: 310 });
    expect(await errorOf(stale)).toMatchObject({ status: 409, code: "version_conflict" });
    expect((await readListing(C.token, C.draftId)).capMax).toBe(300);
    const same = await save(C.token, C.draftId, { version: current.version, capMax: 300, name: "Зал Лола" });
    expect(await errorOf(same)).toMatchObject({ status: 422, code: "no_changes" });
  });

  it("проверки: «до» меньше «от», неизвестный район, лишние ключи, неверное поле витрины", async () => {
    const { version } = await readListing(C.token, C.draftId);
    const order = await save(C.token, C.draftId, { version, capMin: 400, capMax: 100 });
    expect(await errorOf(order)).toMatchObject({ status: 422, code: "invalid_input", details: ["capMax"] });
    const merged = await save(C.token, C.draftId, { version, capMax: 70 });
    expect(await errorOf(merged)).toMatchObject({ status: 422, details: ["capMax"] });
    const district = await save(C.token, C.draftId, { version, districtCode: "atlantida" });
    expect(await errorOf(district)).toMatchObject({ status: 422, details: ["districtCode"] });
    const keys = await save(C.token, C.draftId, {
      version,
      slug: "moy-zal",
      categoryCode: "car",
      priceFromUzs: 1,
    });
    expect(await errorOf(keys)).toMatchObject({
      status: 422,
      code: "invalid_input",
      details: ["slug", "categoryCode", "priceFromUzs"],
    });
    const attr = await save(C.token, C.draftId, { version, attributes: { nonsense: 1 } });
    expect((await errorOf(attr)).code).toBe("invalid_input");
    // Ни одна из ошибок ничего не записала
    expect((await readListing(C.token, C.draftId)).version).toBe(version);
  });

  it("витрина на сайте: те же поля уходят предложением, карточка прежняя", async () => {
    const before = await readListing(C.token, C.listingId);
    const res = await save(C.token, C.listingId, {
      version: before.version,
      capMin: 100,
      capMax: 350,
      districtCode: "chilonzor",
      addressRu: "ул. Навои, 5",
    });
    expect(res.status).toBe(200);
    const saved = (await res.json()) as VendorListingSaved;
    expect(saved.sentForModeration).toEqual(["capacity", "districtCode", "addressRu"]);
    // Клиент видит прежнее
    expect(saved.listing).toMatchObject({
      capMin: 50,
      capMax: 300,
      districtCode: "yunusobod",
      version: before.version,
    });
    const list = (await (
      await call(`/vendor/listings/${C.listingId}/revisions`, bearer(C.token))
    ).json()) as VendorRevisionList;
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      status: "pending",
      payload: { cap_min: 100, cap_max: 350, district_code: "chilonzor", address_ru: "ул. Навои, 5" },
    });
    const { rows } = await admin.query<{ base_version: number; submitted_by: string }>(
      "select base_version, submitted_by from app.listing_revisions where id = $1",
      [list.items[0]?.id],
    );
    expect(rows).toEqual([{ base_version: before.version, submitted_by: C.userId }]);
    // В журнал «сразу» ничего не попало: правка ждёт решения
    const log = await admin.query(
      "select 1 from app.audit_log where action = 'listing.vendor_update' and object_id = $1",
      [C.listingId],
    );
    expect(log.rows).toHaveLength(0);
  });

  it("предложение уже открыто — 409 revision_pending; «заказов одновременно» его не «устаревляет»", async () => {
    const { version } = await readListing(C.token, C.listingId);
    const second = await save(C.token, C.listingId, { version, capMax: 360 });
    expect(await errorOf(second)).toMatchObject({ status: 409, code: "revision_pending" });

    const calendar = await calendarVersion(C.token, C.listingId);
    const capacity = await call(`/vendor/listings/${C.listingId}/calendar/capacity`, {
      method: "PUT",
      headers: { ...json, Authorization: `Bearer ${C.token}`, "If-Match": String(calendar) },
      body: JSON.stringify({ parallelCapacity: 2 }),
    });
    expect(capacity.status).toBe(200);
    const fresh = `select r.base_version = l.version as fresh from app.listing_revisions r
         join app.listings l on l.id = r.listing_id where r.listing_id = $1 and r.status = 'pending'`;
    expect((await admin.query<{ fresh: boolean }>(fresh, [C.listingId])).rows).toEqual([{ fresh: true }]);
    // Поле, которое предложение тоже меняет, — устаревшее: решает человек
    await admin.query("update app.listings set cap_max = 320 where id = $1", [C.listingId]);
    expect((await admin.query<{ fresh: boolean }>(fresh, [C.listingId])).rows).toEqual([{ fresh: false }]);
  });

  it("сотрудник площадки — 403 vendor_owner_required; чужая витрина — 404; без версии — 422", async () => {
    const { version } = await readListing(C.token, C.draftId);
    const asMember = await save(member, C.draftId, { version, capMax: 310 });
    expect(await errorOf(asMember)).toMatchObject({ status: 403, code: "vendor_owner_required" });
    expect((await save(B.token, C.draftId, { version, capMax: 310 })).status).toBe(404);
    expect(await errorOf(await save(C.token, C.draftId, { capMax: 310 }))).toMatchObject({
      status: 422,
      details: ["version"],
    });
    expect((await readListing(C.token, C.draftId)).capMax).toBe(300);
  });

  it("база тоже не даёт партнёру адрес страницы и поля витрины на сайте в обход API", async () => {
    const client = new PgClient({ connectionString: apiDatabaseUrl });
    await client.connect();
    try {
      const asOwner = async (sql: string, params: unknown[]) => {
        await client.query("begin");
        try {
          await client.query(
            "select set_config('app.actor_kind', 'vendor_user', true), set_config('app.actor_id', $1, true), set_config('app.vendor_id', $2, true)",
            [C.userId, C.accountId],
          );
          return await client.query(sql, params);
        } finally {
          await client.query("rollback").catch(() => {});
        }
      };
      await expect(
        asOwner("update app.listings set slug = 'moy-zal' where id = $1", [C.draftId]),
      ).rejects.toMatchObject({ code: "BR006" });
      await expect(
        asOwner("update app.listings set cap_max = 400 where id = $1", [C.listingId]),
      ).rejects.toMatchObject({ code: "BR005" });
      await expect(
        asOwner("update app.listings set address_ru = 'x' where id = $1", [C.listingId]),
      ).rejects.toMatchObject({ code: "BR005" });
      const draft = await asOwner("update app.listings set cap_max = 400 where id = $1", [C.draftId]);
      expect(draft.rowCount).toBe(1);
    } finally {
      await client.end();
    }
  });
});

// ── роли кабинета и фото из кабинета ────────────────────────────────────────

describe("роли кабинета: сотрудник площадки ведёт заявки и календарь, карточку — владелец", () => {
  let member: { userId: string; token: string };

  beforeAll(async () => {
    const userId = randomUUID();
    const telegram = vendorTelegramUser();
    await admin.query(
      `insert into app.vendor_users (id, vendor_id, phone_hash, tg_user_hash, tg_linked_at, role)
       values ($1, $2, $3, $4, now(), 'member')`,
      [userId, A.accountId, randomBytes(32), tgIdHash(telegram.id)],
    );
    await admin.query(
      "insert into pii.vendor_user_profiles (vendor_user_id, phone, full_name) values ($1, '+998000000112', 'Staff A')",
      [userId],
    );
    member = { userId, token: await vendorToken(telegram) };
  });

  const codeOf = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

  it("GET /vendor/me: роль member", async () => {
    const me = (await (await call("/vendor/me", bearer(member.token))).json()) as VendorMe;
    expect(me.user).toMatchObject({ id: member.userId, role: "member" });
  });

  it("календарь и заявки — можно", async () => {
    const version = await calendarVersion(member.token, A.listingId);
    const res = await call(
      `/vendor/listings/${A.listingId}/calendar/${days(20)}`,
      at(member.token, "PUT", version),
    );
    expect(res.status).toBe(200);
    expect((await call(`/vendor/requests/${ra2.id}/call`, as(member.token, "POST"))).status).toBe(204);
    expect((await call(`/vendor/listings/${A.listingId}/revisions`, bearer(member.token))).status).toBe(200);
  });

  it("предложить правку и загрузить или удалить фото — 403 vendor_owner_required", async () => {
    const propose = await call(`/vendor/listings/${A.listingId}/revisions`, {
      method: "POST",
      headers: { ...json, Authorization: `Bearer ${member.token}` },
      body: JSON.stringify({ name: "Member Hall" }),
    });
    expect([propose.status, await codeOf(propose)]).toEqual([403, "vendor_owner_required"]);
    const upload = await call(`/vendor/listings/${A.listingId}/photos`, {
      method: "POST",
      headers: { Authorization: `Bearer ${member.token}`, "X-No-Faces": "1", "content-type": "image/webp" },
      body: webpFixture({ width: 640, height: 480 }) as Uint8Array<ArrayBuffer>,
    });
    expect([upload.status, await codeOf(upload)]).toEqual([403, "vendor_owner_required"]);
    const { rows } = await admin.query<{ id: string }>(
      "select id from app.photos where listing_id = $1 and deleted_at is null limit 1",
      [A.listingId],
    );
    const del = await call(
      `/vendor/listings/${A.listingId}/photos/${rows[0]?.id}`,
      as(member.token, "DELETE"),
    );
    expect([del.status, await codeOf(del)]).toEqual([403, "vendor_owner_required"]);
    const { rows: alive } = await admin.query(
      "select 1 from app.photos where id = $1 and deleted_at is null",
      [rows[0]?.id],
    );
    expect(alive).toHaveLength(1);
  });

  it("база тоже не даёт: правка карточки под сотрудником площадки не проходит", async () => {
    // Роль в API взяли бы из членства; здесь — прямо в базе ролью API, в обход проверок API
    const client = new PgClient({ connectionString: apiDatabaseUrl });
    await client.connect();
    try {
      await client.query("begin");
      await client.query(
        "select set_config('app.actor_kind', 'vendor_user', true), set_config('app.actor_id', $1, true), set_config('app.vendor_id', $2, true)",
        [member.userId, A.accountId],
      );
      await expect(
        client.query(
          'insert into app.listing_revisions (listing_id, payload, base_version) values ($1, \'{"name": "X Hall"}\', 1)',
          [A.listingId],
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await client.query("rollback").catch(() => {});
      await client.end();
    }
  });
});

describe("фото из кабинета", () => {
  const photosUrl = (listingId: string) => `/vendor/listings/${listingId}/photos`;
  const upload = (
    token: string,
    listingId: string,
    bytes: Uint8Array,
    headers: Record<string, string> = {},
  ) =>
    call(photosUrl(listingId), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "image/webp", ...headers },
      body: bytes as Uint8Array<ArrayBuffer>,
    });
  const errorOf = async (res: Response) => {
    const body = (await res.json()) as { error: { code: string; details?: string[] } };
    return { status: res.status, code: body.error.code, details: body.error.details };
  };

  it("без подтверждения «лиц нет» — 422; чужая площадка — 404", async () => {
    const bytes = webpFixture({ width: 640, height: 480 });
    expect(await errorOf(await upload(A.token, A.listingId, bytes))).toMatchObject({
      status: 422,
      code: "no_faces_ack_required",
    });
    expect((await upload(A.token, B.listingId, bytes, { "X-No-Faces": "1" })).status).toBe(404);
    const { rows } = await admin.query<{ id: string }>(
      "select id from app.photos where listing_id = $1 and deleted_at is null limit 1",
      [B.listingId],
    );
    expect((await call(`${photosUrl(B.listingId)}/${rows[0]?.id}`, as(A.token, "DELETE"))).status).toBe(404);
  });

  it("опубликованная площадка не остаётся без минимума одобренных фото — 422 publish_blocked", async () => {
    const { rows } = await admin.query<{ id: string }>(
      "select id from app.photos where listing_id = $1 and deleted_at is null and moderation = 'approved' limit 1",
      [A.listingId],
    );
    expect(
      await errorOf(await call(`${photosUrl(A.listingId)}/${rows[0]?.id}`, as(A.token, "DELETE"))),
    ).toEqual({ status: 422, code: "publish_blocked", details: ["photos"] });
  });

  it.skipIf(!STORAGE)("загрузка: ждёт модератора, клиенты не видят; своё фото — удалить", async () => {
    const res = await upload(A.token, A.listingId, webpFixture({ width: 800, height: 600 }), {
      "X-No-Faces": "1",
    });
    expect(res.status).toBe(201);
    const photo = (await res.json()) as VendorPhoto;
    expect(photo).toMatchObject({ width: 800, height: 600, moderation: "pending", isCover: false });

    const listing = (await (
      await call(`/vendor/listings/${A.listingId}`, bearer(A.token))
    ).json()) as VendorListing;
    expect(listing.photos.map((p) => [p.id, p.moderation])).toContainEqual([photo.id, "pending"]);
    expect(listing.photoLimits).toEqual({ min: expect.any(Number), max: expect.any(Number) });

    const { rows } = await admin.query<{ slug: string; uploaded_by: string }>(
      `select l.slug, p.uploaded_by from app.photos p join app.listings l on l.id = p.listing_id where p.id = $1`,
      [photo.id],
    );
    expect(rows[0]?.uploaded_by).toBe(A.userId);
    const catalog = (await (await call(`/catalog/listings/${rows[0]?.slug}`)).json()) as {
      photos: unknown[];
    };
    expect(catalog.photos).toHaveLength(3);

    expect((await call(`${photosUrl(A.listingId)}/${photo.id}`, as(A.token, "DELETE"))).status).toBe(204);
    const { rows: gone } = await admin.query(
      "select 1 from app.photos where id = $1 and deleted_at is null",
      [photo.id],
    );
    expect(gone).toEqual([]);
  });
});

describe("правка, предложенная командой", () => {
  it("партнёр видит её с отметкой byTeam и не отзывает — 403", async () => {
    // Как правка менеджера из панели: submitted_by — не пользователь вендора
    const { rows } = await admin.query<{ id: string }>(
      `insert into app.listing_revisions (listing_id, payload, base_version)
       select id, '{"description_ru": "Новое описание"}', version from app.listings where id = $1 returning id`,
      [B.listingId],
    );
    const id = rows[0]?.id;
    const list = (await (
      await call(`/vendor/listings/${B.listingId}/revisions`, bearer(B.token))
    ).json()) as VendorRevisionList;
    expect(list.items[0]).toMatchObject({ id, status: "pending", byTeam: true });
    const res = await call(`/vendor/listings/${B.listingId}/revisions/${id}/withdraw`, as(B.token, "POST"));
    expect(res.status).toBe(403);
    const { rows: still } = await admin.query<{ status: string }>(
      "select status from app.listing_revisions where id = $1",
      [id],
    );
    expect(still[0]?.status).toBe("pending");
  });
});

// ── что ждёт партнёра: значки разделов, причины отказов, первый ответ менеджера ─

describe("что ждёт партнёра", () => {
  let member: { token: string };

  const me = async (token: string) => (await (await call("/vendor/me", bearer(token))).json()) as VendorMe;
  /** Значки витрины, как их получает кабинет в GET /vendor/me */
  const attention = async (listingId: string, token = A.token) =>
    (await me(token)).listings.find((l) => l.id === listingId)?.attention;
  const ZERO = { services: 0, photos: 0, proposals: 0 };
  const proposeUrl = () => `/vendor/listings/${A.draftId}/revisions`;
  const post = (token: string, body: unknown): RequestInit => ({
    method: "POST",
    headers: { ...json, Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

  beforeAll(async () => {
    const userId = randomUUID();
    const telegram = vendorTelegramUser();
    await admin.query(
      `insert into app.vendor_users (id, vendor_id, phone_hash, tg_user_hash, tg_linked_at, role)
       values ($1, $2, $3, $4, now(), 'member')`,
      [userId, A.accountId, randomBytes(32), tgIdHash(telegram.id)],
    );
    await admin.query(
      "insert into pii.vendor_user_profiles (vendor_user_id, phone, full_name) values ($1, '+998000000113', 'Staff A2')",
      [userId],
    );
    member = { token: await vendorToken(telegram) };
  });

  it("витрина без отказов — нули; последнее предложение зала отклонено — это одна вещь, ждущая партнёра", async () => {
    // Зал: в «правках карточки» выше последнее предложение партнёра отклонили, нового нет
    expect(await attention(A.listingId)).toEqual({ services: 0, photos: 0, proposals: 1 });
    expect(await attention(A.draftId)).toEqual(ZERO);
    expect(await attention(B.listingId, B.token)).toMatchObject({ services: 0, photos: 0 });
  });

  it("предложение: отклонённое считается, пока нет нового; новое открытое, отзыв и предложение команды — нет", async () => {
    const first = (await (
      await call(proposeUrl(), post(A.token, { name: "Draft A Grand" }))
    ).json()) as VendorRevision;
    expect(await attention(A.draftId)).toEqual(ZERO);
    await admin.query(
      "update app.listing_revisions set status = 'declined', decision_reason = 'Название не как на вывеске' where id = $1",
      [first.id],
    );
    expect(await attention(A.draftId)).toEqual({ ...ZERO, proposals: 1 });

    // Партнёр отправил новое — прежний отказ ждать больше не нужно
    const second = (await (
      await call(proposeUrl(), post(A.token, { name: "Draft A Grand Hall" }))
    ).json()) as VendorRevision;
    expect(await attention(A.draftId)).toEqual(ZERO);
    // Отозвал — и это его решение: последнее предложение не отклонено
    expect((await call(`${proposeUrl()}/${second.id}/withdraw`, as(A.token, "POST"))).status).toBe(200);
    expect(await attention(A.draftId)).toEqual(ZERO);

    // Предложение команды (submitted_by — не пользователь вендора) партнёру чинить нечего:
    // база ставит автора при вставке, а решение по нему — модератор
    const { rows } = await admin.query<{ id: string }>(
      `insert into app.listing_revisions (listing_id, payload, base_version)
       select id, '{"description_ru": "Описание от команды"}', version from app.listings where id = $1
       returning id`,
      [A.draftId],
    );
    await admin.query(
      "update app.listing_revisions set status = 'declined', decision_reason = 'Не подходит' where id = $1",
      [rows[0]?.id],
    );
    const team = (await (await call(proposeUrl(), bearer(A.token))).json()) as VendorRevisionList;
    expect(team.items[0]).toMatchObject({ id: rows[0]?.id, status: "declined", byTeam: true });
    expect(await attention(A.draftId)).toEqual(ZERO);
  });

  it("фото: отклонённое — с причиной модератора и в значке, пока партнёр его не удалил", async () => {
    const photo = async (moderation: string) => {
      const { rows } = await admin.query<{ id: string }>(
        `insert into app.photos (listing_id, status, moderation, storage_key, mime, bytes, width, height, sha256,
                                 sort, no_faces_ack)
         values ($1, 'ready', $2, $3, 'image/webp', 1000, 1600, 1200, $4, 5, true) returning id`,
        [A.draftId, moderation, `listings/${A.draftId}/${randomUUID()}.webp`, randomBytes(32)],
      );
      return rows[0]?.id as string;
    };
    const pending = await photo("pending");
    const declined = await photo("pending");
    // Причину пишет модератор вместе с решением (под актором system, как в базе)
    await admin.query(
      "update app.photos set moderation = 'declined', moderation_reason = 'На фото виден человек' where id = $1",
      [declined],
    );
    expect(await attention(A.draftId)).toEqual({ ...ZERO, photos: 1 });

    const listing = (await (
      await call(`/vendor/listings/${A.draftId}`, bearer(A.token))
    ).json()) as VendorListing;
    expect(listing.photos.map((p) => [p.id, p.moderation, p.declineReason]).sort()).toEqual(
      [
        [pending, "pending", null],
        [declined, "declined", "На фото виден человек"],
      ].sort(),
    );

    // Сотрудник площадки отклонённое видит, но чинить не может — значка у него нет
    expect(await attention(A.draftId, member.token)).toEqual(ZERO);
    expect((await me(member.token)).listings.map((l) => l.attention)).toEqual([ZERO, ZERO]);

    expect(
      (await call(`/vendor/listings/${A.draftId}/photos/${declined}`, as(A.token, "DELETE"))).status,
    ).toBe(204);
    expect(await attention(A.draftId)).toEqual(ZERO);
  });

  it("услуги: отклонённые считаются по одной; удалил или отправил снова — число убывает", async () => {
    // Отказ команды по новой услуге: услуга rejected с причиной (решает модератор, здесь — под system)
    const rejected = async (type: string) => {
      const { rows } = await admin.query<{ id: string }>(
        `insert into app.listing_services (listing_id, category_code, service_type, status, price_uzs, price_unit,
                                           decision, decision_reason, decided_at)
         values ($1, 'hall', $2, 'rejected', 100000, 'per_guest', 'declined', 'Цена не сходится с залом', now())
         returning id`,
        [A.draftId, type],
      );
      return rows[0]?.id as string;
    };
    const one = await rejected("banquet_weekday");
    const two = await rejected("banquet_weekend");
    expect(await attention(A.draftId)).toEqual({ ...ZERO, services: 2 });
    expect(await attention(A.draftId, member.token)).toEqual(ZERO);

    expect((await call(`/vendor/listings/${A.draftId}/services/${one}`, as(A.token, "DELETE"))).status).toBe(
      204,
    );
    expect(await attention(A.draftId)).toEqual({ ...ZERO, services: 1 });
    // Отправил отклонённую снова — она на проверке, ждать от партнёра больше нечего
    expect(
      (await call(`/vendor/listings/${A.draftId}/services/${two}/submit`, as(A.token, "POST"))).status,
    ).toBe(200);
    expect(await attention(A.draftId)).toEqual(ZERO);
  });

  it("первый ответ — менеджер Bayramm: список и карточка заявки называют, кто ответил", async () => {
    const client = await createClient();
    const staffReq = await createRequest(client, A.listingId, days(44));
    // «Связались» — отметка сотрудника из панели: переход под актором staff
    try {
      await admin.query("begin");
      await admin.query(
        "select set_config('app.actor_kind', 'staff', true), set_config('app.actor_id', $1, true)",
        [randomUUID()],
      );
      await admin.query("update app.requests set status = 'contacted' where id = $1", [staffReq.id]);
      await admin.query("commit");
    } catch (err) {
      // Не оставлять соединение в оборванной транзакции: за этим тестом идут остальные
      await admin.query("rollback").catch(() => {});
      throw err;
    }

    const page = (await (
      await call("/vendor/requests?tab=active", bearer(A.token))
    ).json()) as VendorRequestPage;
    const listed = page.items.find((r) => r.id === staffReq.id);
    expect(listed?.firstResponseBy).toBe("staff");
    expect(listed?.sla.firstResponseAt).not.toBeNull();

    const detail = (await (
      await call(`/vendor/requests/${staffReq.id}`, bearer(A.token))
    ).json()) as VendorRequestDetail;
    expect(detail.firstResponseBy).toBe("staff");
    expect(detail.history.map((h) => [h.status, h.by])).toEqual([
      ["new", "system"],
      ["contacted", "staff"],
    ]);

    // Партнёр продолжает работу: первый ответ остаётся за тем, кто ответил первым
    const deal = await call(`/vendor/requests/${staffReq.id}`, patch(A.token, { status: "deal" }));
    expect(((await deal.json()) as VendorRequestItem).firstResponseBy).toBe("staff");
  });
});

// ── витрина — на проверку ───────────────────────────────────────────────────

describe("партнёр отправляет витрину на проверку", () => {
  const submit = (listingId: string, token = A.token) =>
    call(`/vendor/listings/${listingId}/submit`, as(token, "POST"));
  const errorOf = async (res: Response) => {
    const body = (await res.json()) as { error: { code: string; details?: string[] } };
    return { status: res.status, code: body.error.code, details: body.error.details };
  };
  let readyId: string;

  beforeAll(async () => {
    // Черновик зала, где команда заполнила своё (вместимость, район, телефон), партнёр — описания
    // и фото; услуги партнёр отправит из кабинета
    readyId = randomUUID();
    extraListings.push(readyId);
    await admin.query(
      `insert into app.listings (id, vendor_id, slug, category_code, name, district_code, description_ru,
                                 description_uz, cap_min, cap_max)
       values ($1, $2, $3, 'hall', 'Ready Draft A', 'yunusobod', 'Описание', 'Tavsif', 50, 200)`,
      [readyId, A.accountId, `test-ready-${run}`],
    );
    await admin.query(
      "insert into pii.listing_contacts (listing_id, public_phone) values ($1, '+998000000998')",
      [readyId],
    );
    for (let n = 0; n < 3; n++) {
      await admin.query(
        `insert into app.photos (listing_id, status, moderation, storage_key, mime, bytes, width, height, sha256,
                                 sort, no_faces_ack)
         values ($1, 'ready', 'pending', $2, 'image/webp', 1000, 1600, 1200, $3, $4, true)`,
        [readyId, `listings/${readyId}/${randomUUID()}.webp`, randomBytes(32), n],
      );
    }
  });

  it("не всё готово — 422 publish_blocked с пунктами; статус прежний", async () => {
    expect(await errorOf(await submit(readyId))).toMatchObject({
      status: 422,
      code: "publish_blocked",
      details: expect.arrayContaining(["price", "packages"]),
    });
    const listing = (await (
      await call(`/vendor/listings/${readyId}`, bearer(A.token))
    ).json()) as VendorListing;
    expect(listing.status).toBe("draft");
    expect(listing.reviewBlockers).toEqual(expect.arrayContaining(["price", "packages"]));
    // Фото на проверке для отправки засчитываются, для публикации — ещё нет
    expect(listing.reviewBlockers).not.toContain("photos");
    expect(listing.blockers).toContain("photos");
  });

  it("услуги черновика — команде; готово — на проверку, оповещение тем, кто публикует", async () => {
    for (const [type, price] of [
      ["banquet_weekday", 150_000],
      ["banquet_weekend", 180_000],
    ] as const) {
      const res = await call(`/vendor/listings/${readyId}/services`, {
        method: "POST",
        headers: { ...json, Authorization: `Bearer ${A.token}` },
        body: JSON.stringify({ type, priceUzs: price, priceUnit: "per_guest" }),
      });
      expect(res.status).toBe(201);
    }
    // Оповещение команде поставлено — или в журнале, что его некому отправить (у команды нет чатов)
    const reached = async (kind: string) => {
      const { rows } = await admin.query<{ n: number }>(
        `select (select count(*) from app.outbox where kind = $1 and payload ->> 'listing_id' = $2)
              + (select count(*) from app.audit_log where action = 'outbox.no_recipients'
                   and object_id = $2 and detail ->> 'kind' = $1) as n`,
        [kind, readyId],
      );
      return Number(rows[0]?.n ?? 0);
    };
    expect(await reached("ops.service_submitted")).toBeGreaterThan(0);

    const res = await submit(readyId);
    expect(res.status).toBe(200);
    const listing = (await res.json()) as VendorListing;
    expect(listing).toMatchObject({ id: readyId, status: "review", reviewBlockers: [] });
    expect(await reached("ops.listing_submitted")).toBeGreaterThan(0);
    // Уже на проверке — второй раз не отправить
    expect(await errorOf(await submit(readyId))).toMatchObject({ status: 409, code: "illegal_transition" });
  });

  it("чужая — 404; сотрудник площадки — 403 vendor_owner_required", async () => {
    expect((await submit(B.draftId)).status).toBe(404);
    const memberUser = vendorTelegramUser();
    const memberId = randomUUID();
    await admin.query(
      `insert into app.vendor_users (id, vendor_id, phone_hash, tg_user_hash, tg_linked_at, role)
       values ($1, $2, $3, $4, now(), 'member')`,
      [memberId, A.accountId, randomBytes(32), tgIdHash(memberUser.id)],
    );
    await admin.query(
      "insert into pii.vendor_user_profiles (vendor_user_id, phone, full_name) values ($1, '+998000000114', 'Staff A3')",
      [memberId],
    );
    const token = await vendorToken(memberUser);
    expect(await errorOf(await submit(A.draftId, token))).toMatchObject({
      status: 403,
      code: "vendor_owner_required",
    });
  });

  it("отклонённую услугу «Сохранить черновик» делает черновиком: отказ — в прошлом круге", async () => {
    const { rows } = await admin.query<{ id: string }>(
      `insert into app.listing_services (listing_id, category_code, service_type, status, price_uzs, price_unit,
                                         decision, decision_reason, decided_at)
       values ($1, 'hall', 'fotiha_hall', 'rejected', 100000, 'per_guest', 'declined', 'Нужна цена за гостя', now())
       returning id`,
      [A.draftId],
    );
    const res = await call(`/vendor/listings/${A.draftId}/services/${rows[0]?.id}`, {
      ...patch(A.token, { priceUzs: 120_000, priceUnit: "per_guest", submit: false }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "draft", priceUzs: 120_000, decision: null });
  });
});

// ── порядок и обложка фото, отзыв с проверки, контакты витрины ───────────────

describe("партнёр сам ведёт фото, отзывает витрину с проверки и меняет контакты", () => {
  const putJson = (token: string, body: unknown): RequestInit => ({
    method: "PUT",
    headers: { ...json, Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const postJson = (token: string, body: unknown): RequestInit => ({
    method: "POST",
    headers: { ...json, Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const errorOf = async (res: Response) => {
    const body = (await res.json()) as { error: { code: string; details?: string[] } };
    return { status: res.status, code: body.error.code, details: body.error.details };
  };
  const listingOf = async (id: string, token = A.token) =>
    (await (await call(`/vendor/listings/${id}`, bearer(token))).json()) as VendorListing;
  const idsOf = (list: { photos: readonly VendorPhoto[] }) => list.photos.map((p) => p.id);

  /** Сотрудник площадки вендора A: календарь и заявки, но не карточка */
  let memberToken: string;
  /** Витрина вендора A на проверке: отзывается в черновик */
  let reviewId: string;

  beforeAll(async () => {
    const memberUser = vendorTelegramUser();
    const memberId = randomUUID();
    await admin.query(
      `insert into app.vendor_users (id, vendor_id, phone_hash, tg_user_hash, tg_linked_at, role)
       values ($1, $2, $3, $4, now(), 'member')`,
      [memberId, A.accountId, randomBytes(32), tgIdHash(memberUser.id)],
    );
    await admin.query(
      "insert into pii.vendor_user_profiles (vendor_user_id, phone, full_name) values ($1, '+998000000115', 'Staff A4')",
      [memberId],
    );
    memberToken = await vendorToken(memberUser);

    reviewId = randomUUID();
    extraListings.push(reviewId);
    await admin.query(
      `insert into app.listings (id, vendor_id, slug, category_code, name, district_code, description_ru,
                                 description_uz, price_from_uzs, price_unit, cap_min, cap_max)
       values ($1, $2, $3, 'hall', 'Review Hall A', 'yunusobod', 'Описание', 'Tavsif', 150000, 'per_guest', 50, 300)`,
      [reviewId, A.accountId, `test-review-${run}`],
    );
    await admin.query(
      "insert into pii.listing_contacts (listing_id, public_phone) values ($1, '+998000000997')",
      [reviewId],
    );
    await addHallBanquets(admin, reviewId, 150_000, 180_000);
    for (let n = 0; n < 3; n++) {
      await admin.query(
        `insert into app.photos (listing_id, status, moderation, storage_key, mime, bytes, width, height, sha256,
                                 sort, no_faces_ack)
         values ($1, 'ready', 'approved', $2, 'image/webp', 1000, 1600, 1200, $3, $4, true)`,
        [reviewId, `listings/${reviewId}/${randomUUID()}.webp`, randomBytes(32), n],
      );
    }
    await admin.query("update app.listings set status = 'review' where id = $1", [reviewId]);
  });

  it("порядок: одобренные фото переставляются сразу, обложка остаётся первой; в журнал — id и число", async () => {
    const before = idsOf(await listingOf(A.listingId));
    expect(before).toHaveLength(3);
    const [cover, second, third] = before as [string, string, string];
    const order = `/vendor/listings/${A.listingId}/photos/order`;
    const res = await call(order, putJson(A.token, { ids: [cover, third, second] }));
    expect(res.status).toBe(200);
    expect(idsOf((await res.json()) as VendorPhotoList)).toEqual([cover, third, second]);
    expect(idsOf(await listingOf(A.listingId))).toEqual([cover, third, second]);
    // Не тот набор — 422 ids, порядок прежний
    const bad = await call(order, putJson(A.token, { ids: [cover, third] }));
    expect(await errorOf(bad)).toMatchObject({ status: 422, code: "invalid_input", details: ["ids"] });
    const { rows } = await admin.query<{ detail: { count: number } }>(
      "select detail from app.audit_log where action = 'photo.order' and object_id = $1",
      [A.listingId],
    );
    expect(rows).toEqual([{ detail: { count: 3 } }]);
  });

  it("обложка: одобренное фото — первое и обложка; ждущее решения — 422", async () => {
    const [cover, second, third] = idsOf(await listingOf(A.listingId)) as [string, string, string];
    const res = await call(`/vendor/listings/${A.listingId}/photos/${third}/cover`, as(A.token, "POST"));
    expect(res.status).toBe(200);
    const list = (await res.json()) as VendorPhotoList;
    expect(idsOf(list)).toEqual([third, cover, second]);
    expect(list.photos.map((p) => p.isCover)).toEqual([true, false, false]);

    const pending = await admin.query<{ id: string }>(
      `insert into app.photos (listing_id, status, moderation, storage_key, mime, bytes, width, height, sha256,
                               sort, no_faces_ack)
       values ($1, 'ready', 'pending', $2, 'image/webp', 1000, 1600, 1200, $3, 9, true) returning id`,
      [A.listingId, `listings/${A.listingId}/${randomUUID()}.webp`, randomBytes(32)],
    );
    const pendingId = pending.rows[0]?.id ?? "";
    const asCover = await call(
      `/vendor/listings/${A.listingId}/photos/${pendingId}/cover`,
      as(A.token, "POST"),
    );
    expect(await errorOf(asCover)).toMatchObject({
      status: 422,
      code: "invalid_input",
      details: ["photoId"],
    });
    // Ждущее фото в порядок не входит: набор — только одобренные
    const withPending = await call(
      `/vendor/listings/${A.listingId}/photos/order`,
      putJson(A.token, { ids: [third, cover, second, pendingId] }),
    );
    expect(await errorOf(withPending)).toMatchObject({
      status: 422,
      code: "invalid_input",
      details: ["ids"],
    });
    await admin.query("delete from app.photos where id = $1", [pendingId]);
  });

  it("порядок и обложка: сотрудник площадки — 403, чужая витрина — 404", async () => {
    const [first] = idsOf(await listingOf(A.listingId));
    const cover = `/vendor/listings/${A.listingId}/photos/${first}/cover`;
    const order = `/vendor/listings/${A.listingId}/photos/order`;
    expect(await errorOf(await call(cover, as(memberToken, "POST")))).toMatchObject({
      status: 403,
      code: "vendor_owner_required",
    });
    expect((await call(order, putJson(memberToken, { ids: [first] }))).status).toBe(403);
    expect((await call(cover, as(B.token, "POST"))).status).toBe(404);
    expect((await call(order, putJson(B.token, { ids: [] }))).status).toBe(404);
  });

  it("отозвать с проверки: review → draft, запись в журнал; не на проверке — 409; сотрудник — 403; чужая — 404", async () => {
    const withdraw = (id: string, token = A.token) =>
      call(`/vendor/listings/${id}/withdraw`, as(token, "POST"));
    expect(await errorOf(await withdraw(reviewId, memberToken))).toMatchObject({
      status: 403,
      code: "vendor_owner_required",
    });
    expect((await withdraw(reviewId, B.token)).status).toBe(404);
    const res = await withdraw(reviewId);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: reviewId, status: "draft" });
    const { rows } = await admin.query<{ status: string }>(
      `select status::text from app.listings where id = $1::uuid
       union all select detail ->> 'to' from app.audit_log where action = 'listing.withdraw' and object_id = $1::text`,
      [reviewId],
    );
    expect(rows.map((r) => r.status)).toEqual(["draft", "draft"]);
    // Второй раз — уже черновик; опубликованную отозвать нельзя
    expect(await errorOf(await withdraw(reviewId))).toMatchObject({
      status: 409,
      code: "illegal_transition",
    });
    expect(await errorOf(await withdraw(A.listingId))).toMatchObject({
      status: 409,
      code: "illegal_transition",
    });
  });

  it("контакты витрины вне сайта — сразу: телефон и Telegram; те же значения — 422 no_changes; неверные — 422", async () => {
    const put = (body: unknown, token = A.token, id = A.draftId) =>
      call(`/vendor/listings/${id}/contacts`, putJson(token, body));
    expect(await errorOf(await put({ phone: "+998000000321" }, memberToken))).toMatchObject({
      status: 403,
      code: "vendor_owner_required",
    });
    const res = await put({ phone: "+998 00 000 03 21", telegram: "@Draft_Hall" });
    expect(res.status).toBe(200);
    const saved = (await res.json()) as VendorContactsSave;
    expect(saved.sentForModeration).toBe(false);
    expect(saved.listing).toMatchObject({
      phone: "+998000000321",
      telegram: "Draft_Hall",
      contactChange: null,
    });
    const same = await put({ phone: "+998000000321", telegram: "Draft_Hall" });
    expect(await errorOf(same)).toMatchObject({ status: 422, code: "no_changes" });
    const badPhone = await put({ phone: "123" });
    expect(await errorOf(badPhone)).toMatchObject({ status: 422, code: "invalid_input", details: ["phone"] });
    const badTelegram = await put({ phone: "+998000000321", telegram: "x" });
    expect(await errorOf(badTelegram)).toMatchObject({ status: 422, details: ["telegram"] });
    // Telegram можно убрать, телефон остаётся
    const cleared = (await (
      await put({ phone: "+998000000321", telegram: null })
    ).json()) as VendorContactsSave;
    expect(cleared.listing).toMatchObject({ phone: "+998000000321", telegram: null });
    // В журнале — поля, без значений
    const { rows } = await admin.query<{ detail: unknown }>(
      "select detail from app.audit_log where actor_kind = 'vendor_user' and action like 'listing_contact.%' and object_id = $1",
      [A.draftId],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toMatch(/\+998|Draft_Hall/);
    expect((await put({ phone: "+998000000321" }, B.token)).status).toBe(404);
  });

  it("контакты опубликованной витрины — запросом: клиентам прежние, партнёр видит «на проверке», новый заменяет прежний, отзыв", async () => {
    const put = (body: unknown) => call(`/vendor/listings/${A.listingId}/contacts`, putJson(A.token, body));
    const res = await put({ phone: "+998000000555", telegram: "lola_zali" });
    expect(res.status).toBe(200);
    const saved = (await res.json()) as VendorContactsSave;
    expect(saved.sentForModeration).toBe(true);
    expect(saved.listing.phone).toBe("+998000000999");
    expect(saved.listing.contactChange).toMatchObject({
      status: "pending",
      phone: "+998000000555",
      telegram: "lola_zali",
    });
    // Прежние контакты у клиентов: публичный телефон не менялся
    const { rows: live } = await admin.query<{ public_phone: string }>(
      "select public_phone from pii.listing_contacts where listing_id = $1",
      [A.listingId],
    );
    expect(live).toEqual([{ public_phone: "+998000000999" }]);
    // Новая отправка заменяет ждущий запрос
    const replaced = (await (await put({ phone: "+998000000556" })).json()) as VendorContactsSave;
    expect(replaced.listing.contactChange).toMatchObject({
      status: "pending",
      phone: "+998000000556",
      telegram: null,
    });
    const { rows: count } = await admin.query<{ n: string }>(
      "select count(*) as n from pii.listing_contact_changes where listing_id = $1 and status = 'pending'",
      [A.listingId],
    );
    expect(count[0]?.n).toBe("1");
    // Сотрудник площадки видит, что запрос ждёт, но не его номера
    expect((await listingOf(A.listingId, memberToken)).contactChange).toMatchObject({
      status: "pending",
      phone: null,
      telegram: null,
    });
    // Отозвать; второй раз — ждущего нет
    const withdrawUrl = `/vendor/listings/${A.listingId}/contact-change/withdraw`;
    const withdrawn = await call(withdrawUrl, as(A.token, "POST"));
    expect(withdrawn.status).toBe(200);
    expect(((await withdrawn.json()) as VendorListing).contactChange).toBeNull();
    expect(await errorOf(await call(withdrawUrl, as(A.token, "POST")))).toMatchObject({
      status: 409,
      code: "contact_change_not_pending",
    });
  });

  it("решение команды: очередь, «Показать» в журнал, одобрить — контакты новые, отказ — с причиной", async () => {
    const staffAs = async (role: "admin" | "manager" | "moderator") => {
      const username = newStaffUsername();
      const id = await inviteStaff(admin, { username, role });
      return { id, token: await staffLoginToken(username) };
    };
    const { id: moderatorId, token: moderator } = await staffAs("moderator");
    const { token: manager } = await staffAs("manager");
    // Оповещения: у модератора есть чат с ботом, у владельца кабинета A — тоже (решение — ему)
    await admin.query("update pii.staff_profiles set telegram_chat_id = 9100000001 where staff_id = $1", [
      moderatorId,
    ]);
    await admin.query(
      "update pii.vendor_user_profiles set telegram_chat_id = 9100000002 where vendor_user_id = $1",
      [A.userId],
    );
    const put = (body: unknown) => call(`/vendor/listings/${A.listingId}/contacts`, putJson(A.token, body));
    const base = `/staff/listings/${A.listingId}/contact-change`;

    expect((await put({ phone: "+998000000600", telegram: "zal_lola" })).status).toBe(200);
    // Команде — оповещение: в payload только id витрины, ни номера, ни Telegram
    const { rows: alerts } = await admin.query<{ payload: unknown }>(
      "select payload from app.outbox where kind = 'ops.contact_change_submitted' and payload ->> 'listing_id' = $1",
      [A.listingId],
    );
    expect(alerts.length).toBeGreaterThan(0);
    for (const alert of alerts) expect(alert.payload).toEqual({ listing_id: A.listingId });
    // Очередь без номеров; менеджеру — нельзя
    const queue = (await (
      await call("/staff/contact-changes", bearer(moderator))
    ).json()) as ContactChangeList;
    const mine = queue.items.find((item) => item.listing.id === A.listingId);
    expect(mine).toMatchObject({ phoneChanged: true, telegramChanged: true });
    expect(JSON.stringify(queue)).not.toMatch(/\+998|zal_lola/);
    expect((await call("/staff/contact-changes", bearer(manager))).status).toBe(403);
    const state = (await (await call(base, bearer(manager))).json()) as ContactChangeResponse;
    expect(state.change).toMatchObject({ phoneChanged: true });
    expect(JSON.stringify(state)).not.toMatch(/\+998/);

    // «Показать»: значения и нынешние контакты — в журнал доступа к ПДн
    expect((await call(`${base}/reveal`, postJson(manager, {}))).status).toBe(403);
    const revealed = await call(`${base}/reveal`, postJson(moderator, { reason: "проверка" }));
    expect((await revealed.json()) as ContactChangeReveal).toMatchObject({
      phone: "+998000000600",
      telegram: "zal_lola",
      current: { phone: "+998000000999", telegram: null },
    });
    const { rows: log } = await admin.query<{ purpose: string; reason: string | null }>(
      "select purpose, reason from app.pii_access_log where subject_id = $1 and purpose = 'staff_contact_change'",
      [A.listingId],
    );
    expect(log).toEqual([{ purpose: "staff_contact_change", reason: "проверка" }]);

    // Менеджер не решает; модератор одобряет — контакты новые, партнёру — уведомление
    expect((await call(`${base}/approve`, as(manager, "POST"))).status).toBe(403);
    expect(await (await call(`${base}/approve`, as(moderator, "POST"))).json()).toEqual({ change: null });
    expect(await errorOf(await call(`${base}/approve`, as(moderator, "POST")))).toMatchObject({
      status: 409,
      code: "contact_change_not_pending",
    });
    expect(await listingOf(A.listingId)).toMatchObject({
      phone: "+998000000600",
      telegram: "zal_lola",
      contactChange: null,
    });
    const { rows: notice } = await admin.query<{ payload: unknown }>(
      "select payload from app.outbox where kind = 'vendor.contact_change_decided' and recipient_id = $1",
      [A.userId],
    );
    expect(notice).toEqual([{ payload: { listing_id: A.listingId, decision: "approved" } }]);

    // Отказ — только с причиной; партнёр видит её, контакты прежние (уже одобренные)
    expect((await put({ phone: "+998000000700" })).status).toBe(200);
    const noReason = await errorOf(await call(`${base}/decline`, postJson(moderator, {})));
    expect(noReason.details).toEqual(["reason"]);
    const declineRes = await call(`${base}/decline`, postJson(moderator, { reason: "Номер не зала" }));
    expect(await declineRes.json()).toEqual({ change: null });
    const declined = await listingOf(A.listingId);
    expect(declined.phone).toBe("+998000000600");
    expect(declined.contactChange).toMatchObject({
      status: "declined",
      reason: "Номер не зала",
      phone: null,
    });
    // Вернуть исходное: остальные тесты ждут прежний телефон и вендора без чата
    await admin.query(
      "update pii.vendor_user_profiles set telegram_chat_id = null where vendor_user_id = $1",
      [A.userId],
    );
    await admin.query(
      "update pii.listing_contacts set public_phone = '+998000000999', public_telegram = null where listing_id = $1",
      [A.listingId],
    );
  });
});

// ── конец сессии ────────────────────────────────────────────────────────────

describe("сессия кабинета", () => {
  it("отключённый пользователь: вход — 403 vendor_disabled, живая сессия — тоже 403 vendor_disabled", async () => {
    const token = await vendorToken(B.telegram);
    await admin.query("update app.vendor_users set disabled_at = now() where id = $1", [B.userId]);
    const live = await call("/vendor/me", bearer(token));
    expect(live.status).toBe(403);
    expect(((await live.json()) as { error: { code: string } }).error.code).toBe("vendor_disabled");
    const res = await vendorLogin(B.telegram);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("vendor_disabled");
  });

  it("пользователя вендора отвязали от аккаунта — кабинет закрыт со следующего запроса", async () => {
    const token = await vendorToken(A.telegram);
    const { rows } = await admin.query<{ account_id: string }>(
      "select account_id from app.vendor_users where id = $1",
      [A.userId],
    );
    await admin.query(
      "update app.vendor_users set account_id = null, tg_user_hash = null, tg_linked_at = null where id = $1",
      [A.userId],
    );
    const res = await call("/vendor/me", bearer(token));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("vendor_not_linked");
    await admin.query(
      "update app.vendor_users set account_id = $2, tg_user_hash = $3, tg_linked_at = now() where id = $1",
      [A.userId, rows[0]?.account_id, tgIdHash(A.telegram.id)],
    );
  });

  it("выход отзывает сессию", async () => {
    const token = await vendorToken(A.telegram);
    expect((await call("/auth/logout", as(token, "POST"))).status).toBe(204);
    expect((await call("/vendor/me", bearer(token))).status).toBe(401);
  });
});
