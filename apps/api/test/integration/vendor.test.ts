// Кабинет вендора на настоящем Postgres, ролью bayramm_api: вход из Mini App,
// входящие заявки, переходы статусов, данные клиента по согласию, календарь.
// Два вендора (A и B) с опубликованными залами и заявками клиентов — главное:
// вендор A не видит и не трогает ничего у B (404, а не 403).

import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import type {
  BusyDay,
  VendorCalendar,
  VendorListing,
  VendorMe,
  VendorRequestDetail,
  VendorRequestItem,
  VendorRequestPage,
} from "@bayramm/shared/api/vendor";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { initDataFor, type TestTelegramUser } from "../../src/testing/init-data";
import {
  adminClient,
  BOT_TOKEN,
  bearer,
  call,
  cleanup,
  loginToken,
  newTelegramUser,
  tgIdHash,
} from "./helpers";

let admin: Client;

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

const days = (n: number) => {
  // Сегодня по Ташкенту + n дней, как считает API
  const today = new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
  return new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
};

function vendorTelegramUser(): TestTelegramUser {
  return { id: 6_000_000_000 + randomInt(0, 999_999_999), first_name: "Vendor", language_code: "ru" };
}

async function vendorLogin(user: TestTelegramUser): Promise<Response> {
  return call("/auth/vendor/telegram", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ initData: await initDataFor(user, { botToken: BOT_TOKEN }) }),
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
  await admin.query(
    `insert into app.listing_packages (listing_id, kind, name_ru, name_uz, price_uzs) values
       ($1, 'weekday', 'Будни', 'Ish kuni', 150000), ($1, 'weekend', 'Выходные', 'Dam olish', 180000)`,
    [id],
  );
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
  // Журналы (статусы, согласия, чтения ПДн) — только на добавление; тестовые строки
  // убираем в режиме реплики, где пользовательские триггеры не срабатывают
  try {
    await admin.query("set session_replication_role = replica");
    const ids = requests.map((r) => r.id);
    const accounts = vendors.map((v) => v.accountId);
    const listings = vendors.flatMap((v) => [v.listingId, v.draftId]);
    await admin.query("delete from app.request_status_log where request_id = any($1::uuid[])", [ids]);
    await admin.query("delete from app.pii_access_log where subject_id = any($1::uuid[])", [
      [...ids, ...listings],
    ]);
    await admin.query("delete from app.audit_log where object_id = any($1::text[])", [ids]);
    await admin.query("delete from app.outbox where request_id = any($1::uuid[])", [ids]);
    await admin.query("delete from app.availability where listing_id = any($1::uuid[])", [listings]);
    await admin.query("delete from pii.request_contacts where request_id = any($1::uuid[])", [ids]);
    await admin.query("delete from app.requests where id = any($1::uuid[])", [ids]);
    await admin.query("delete from app.consents where subject_id = any($1::uuid[])", [clients]);
    await admin.query("delete from app.clients where id = any($1::uuid[])", [clients]);
    await admin.query("delete from app.photos where listing_id = any($1::uuid[])", [listings]);
    await admin.query("delete from app.listing_packages where listing_id = any($1::uuid[])", [listings]);
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

describe("POST /auth/vendor/telegram", () => {
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
    const res = await call("/auth/vendor/telegram", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ initData }),
    });
    expect(res.status).toBe(401);
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
    expect(me.user).toEqual({ id: A.userId, locale: "ru", fullName: "Manager A" });
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
      await call("/vendor/requests?tab=new", bearer(A.token))
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
      (await call(`/vendor/listings/${B.listingId}/calendar/${days(5)}`, as(A.token, "PUT"))).status,
    ).toBe(404);
    expect(
      (await call(`/vendor/listings/${B.listingId}/calendar/${days(5)}`, as(A.token, "DELETE"))).status,
    ).toBe(404);
    const { rows } = await admin.query("select 1 from app.availability where listing_id = $1", [B.listingId]);
    expect(rows).toEqual([]);
  });
});

// ── заявки ──────────────────────────────────────────────────────────────────

describe("заявки вендора A", () => {
  it("список: вкладки со счётчиками, срок ответа, имя клиента без телефона", async () => {
    const page = (await (
      await call("/vendor/requests?tab=new", bearer(A.token))
    ).json()) as VendorRequestPage;
    expect(page.counts).toEqual({ new: 2, active: 0, closed: 0 });
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
    });
    expect(Date.parse(item.sla.dueAt) - Date.parse(item.createdAt)).toBe(12 * 3600 * 1000);
    expect(item.sla).toMatchObject({ firstResponseAt: null, breached: false });
    expect(JSON.stringify(page)).not.toContain("+998");
    // Сначала та, где время истекает раньше: ra1 подана раньше ra2 — её срок ближе
    expect(page.items.map((r) => r.id)).toEqual([ra1.id, ra2.id]);
  });

  it("постранично: курсор продолжает с того же места", async () => {
    const first = (await (
      await call("/vendor/requests?tab=new&limit=1", bearer(A.token))
    ).json()) as VendorRequestPage;
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = (await (
      await call(`/vendor/requests?tab=new&limit=1&cursor=${first.nextCursor}`, bearer(A.token))
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

    const page = (await (
      await call("/vendor/requests?tab=active", bearer(A.token))
    ).json()) as VendorRequestPage;
    expect(page.items.map((r) => r.id)).toContain(ra1.id);
    expect(page.counts).toMatchObject({ new: 1, active: 1 });
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

  it("«В работе»: ждущая ответа выше ответившей, хотя её срок позже", async () => {
    // ra1 уже «связались»; ra2 открываем — просмотрена, ответа ещё нет
    expect((await call(`/vendor/requests/${ra2.id}`, bearer(A.token))).status).toBe(200);
    const page = (await (
      await call("/vendor/requests?tab=active", bearer(A.token))
    ).json()) as VendorRequestPage;
    expect(page.items.map((r) => [r.id, r.status])).toEqual([
      [ra2.id, "viewed"],
      [ra1.id, "contacted"],
    ]);
    const first = (await (
      await call("/vendor/requests?tab=active&limit=1", bearer(A.token))
    ).json()) as VendorRequestPage;
    const second = (await (
      await call(`/vendor/requests?tab=active&limit=1&cursor=${first.nextCursor}`, bearer(A.token))
    ).json()) as VendorRequestPage;
    expect([first.items[0]?.id, second.items[0]?.id]).toEqual([ra2.id, ra1.id]);
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
  it("отметить и освободить день; повтор — не ошибка", async () => {
    const day = days(10);
    const busy = await call(`/vendor/listings/${A.listingId}/calendar/${day}`, as(A.token, "PUT"));
    expect(busy.status).toBe(200);
    expect((await busy.json()) as BusyDay).toEqual({ day, source: "vendor", requestId: null });
    expect((await call(`/vendor/listings/${A.listingId}/calendar/${day}`, as(A.token, "PUT"))).status).toBe(
      200,
    );

    const { rows } = await admin.query<{ created_by: string }>(
      "select created_by from app.availability where listing_id = $1 and day = $2",
      [A.listingId, day],
    );
    expect(rows).toEqual([{ created_by: A.userId }]);

    expect(
      (await call(`/vendor/listings/${A.listingId}/calendar/${day}`, as(A.token, "DELETE"))).status,
    ).toBe(204);
    expect(
      (await call(`/vendor/listings/${A.listingId}/calendar/${day}`, as(A.token, "DELETE"))).status,
    ).toBe(204);
  });

  it("день, закрытый сотрудником, вендор не освобождает — 403", async () => {
    const day = days(11);
    await admin.query("insert into app.availability (listing_id, day, source) values ($1, $2, 'staff')", [
      A.listingId,
      day,
    ]);
    const res = await call(`/vendor/listings/${A.listingId}/calendar/${day}`, as(A.token, "DELETE"));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("forbidden_for_actor");
    const calendar = (await (
      await call(`/vendor/listings/${A.listingId}/calendar?month=${day.slice(0, 7)}`, bearer(A.token))
    ).json()) as VendorCalendar;
    expect(calendar.busy).toContainEqual({ day, source: "staff", requestId: null });
  });

  it("прошедший день и кривая дата — 422", async () => {
    const past = await call(`/vendor/listings/${A.listingId}/calendar/${days(-1)}`, as(A.token, "PUT"));
    expect(past.status).toBe(422);
    expect(((await past.json()) as { error: { code: string } }).error.code).toBe("date_out_of_range");
    expect(
      (await call(`/vendor/listings/${A.listingId}/calendar/2026-02-30`, as(A.token, "PUT"))).status,
    ).toBe(422);
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
  it("карточка как есть: цена, пакеты, фото с воркера media, телефон", async () => {
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
    expect(listing.packages.map((p) => [p.kind, p.priceUzs])).toEqual([
      ["weekday", 150_000],
      ["weekend", 180_000],
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
