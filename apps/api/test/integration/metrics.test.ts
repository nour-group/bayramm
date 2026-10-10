// Метрики запуска, отчёты команде, ошибки API и пауза между напоминаниями — на настоящем
// Postgres ролью bayramm_api. Определения метрик подробно проверяет pgTAP
// (supabase/tests/17_launch_metrics.test.sql); здесь — что API и бот видят их через функции базы.
//
// Данные — свой вендор со случайным названием: его цифры не зависят от остальной базы.

import { randomBytes, randomInt, randomUUID } from "node:crypto";
import type {
  CategoryMetricsList,
  MetricsOverview,
  StaffRequestDetail,
  StaffSettings,
  VendorMetricsList,
  VendorResponseStats,
} from "@bayramm/shared/api/staff";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SYSTEM, withActor } from "../../src/db/actor";
import { createDb } from "../../src/db/client";
import app from "../../src/index";
import { recordApiError } from "../../src/notify/api-errors";
import { type OutboxRow, renderNotice } from "../../src/notify/render";
import {
  addHallBanquets,
  adminClient,
  apiDatabaseUrl,
  cleanupStaff,
  inviteStaff,
  makeEnv,
  newStaffUsername,
  staffLoginToken,
} from "./helpers";

let admin: Client;
const tag = randomBytes(3).toString("hex");
const tokens = { admin: "", moderator: "" };
const staffIds = { admin: "", moderator: "" };
type Who = keyof typeof tokens;
const consentTextId = randomUUID();
const vendorConsentTextId = randomUUID();
const vendorId = randomUUID();
const listingId = randomUUID();
const vendorUserId = randomUUID();
const clientId = randomUUID();
const requestIds: string[] = [];
let savedPause: unknown = null;
let savedApiErrors: Record<string, unknown> | null = null;

// Напоминание уходит сразу (outboxKick): Telegram в тестах «недоступен», строки ждут повтора
const realFetch = globalThis.fetch;
vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input instanceof Request ? input.url : input).startsWith("https://api.telegram.org/")) {
    throw new TypeError("Telegram is offline in tests");
  }
  return realFetch(input, init);
});

async function staffToken(role: Who): Promise<void> {
  const username = newStaffUsername();
  staffIds[role] = await inviteStaff(admin, { username, role, displayName: `Metrics ${role} ${tag}` });
  tokens[role] = await staffLoginToken(username);
}

async function api(who: Who, method: string, path: string, body?: unknown): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  const init: RequestInit = { method, headers: { Authorization: `Bearer ${tokens[who]}` } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  const res = await app.request(path, init, makeEnv(), ctx);
  await Promise.all(pending);
  return res;
}

async function ok<T>(res: Response | Promise<Response>): Promise<T> {
  const r = await res;
  const text = await r.text();
  if (r.status !== 200) throw new Error(`ожидался 200, пришёл ${r.status}: ${text}`);
  return JSON.parse(text) as T;
}

/** Заявка клиента на площадку теста; hoursAgo > 0 — создана раньше (в обход триггеров, реплика) */
async function createRequest(days: number, hoursAgo = 0): Promise<string> {
  const consent = randomUUID();
  await admin.query(
    `insert into app.consents (id, subject_kind, subject_id, purpose, action, text_id, scope_listing_id, source)
     values ($1, 'client', $2, 'request_transfer', 'grant', $3, $4, 'tma')`,
    [consent, clientId, consentTextId, listingId],
  );
  const { rows } = await admin.query<{ id: string }>(
    `insert into app.requests (client_id, listing_id, vendor_id, consent_id, occasion_code, event_date, guests, source)
     values ($1, $2, $3, $4, 'toy', current_date + $5::int, 150, 'tma') returning id`,
    [clientId, listingId, vendorId, consent, days],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("заявка не создана");
  requestIds.push(id);
  if (hoursAgo > 0) {
    await admin.query("begin");
    await admin.query("set local session_replication_role = replica");
    await admin.query(
      `update app.requests set created_at = now() - make_interval(hours => $2),
                               sla_due_at = now() - make_interval(hours => $2) + interval '12 hours'
       where id = $1`,
      [id, hoursAgo],
    );
    await admin.query("commit");
  }
  return id;
}

/** Площадка ответила: переход под актором партнёра — история статусов пишет vendor_user */
async function vendorResponds(requestId: string): Promise<void> {
  await admin.query("begin");
  await admin.query(
    `select set_config('app.actor_kind', 'vendor_user', true), set_config('app.actor_id', $1, true),
            set_config('app.vendor_id', $2, true)`,
    [vendorUserId, vendorId],
  );
  await admin.query("update app.requests set status = 'contacted' where id = $1", [requestId]);
  await admin.query("commit");
}

beforeAll(async () => {
  admin = await adminClient();
  const pause = await admin.query<{ value: unknown }>(
    "select value from app.settings where key = 'ops_reminder_pause_minutes'",
  );
  savedPause = pause.rows[0]?.value ?? null;
  const state = await admin.query<Record<string, unknown>>("select * from app.api_error_alerts");
  savedApiErrors = state.rows[0] ?? null;

  const version = randomInt(1_000, 1_000_000_000);
  await admin.query(
    `insert into app.consent_texts (id, purpose, version, locale, body) values
       ($1, 'request_transfer', $3, 'ru', 'Тестовый текст: передать контакты вендору'),
       ($2, 'vendor_contact', $3, 'ru', 'Тестовый текст: данные контактного лица')`,
    [consentTextId, vendorConsentTextId, version],
  );
  await staffToken("admin");
  await staffToken("moderator");
  // у администратора — чат с ботом: ему уходят отчёты
  await admin.query("update pii.staff_profiles set telegram_chat_id = $2 where staff_id = $1", [
    staffIds.admin,
    9_000_000_000 + randomInt(0, 999_999_999),
  ]);

  await admin.query(
    `insert into app.vendor_accounts (id, name, legal_form, contract_no, contract_signed_at, stir_verified_at,
                                      contacts_confirmed_at, pd_consent_signed_at, pd_consent_text_id)
     values ($1, $2, 'ooo', $3, now(), now(), now(), now(), $4)`,
    [vendorId, `Metrics Vendor ${tag}`, `M-${tag}`, vendorConsentTextId],
  );
  await admin.query(
    `insert into app.vendor_users (id, vendor_id, phone_hash, tg_user_hash, tg_linked_at)
     values ($1, $2, $3, $4, now())`,
    [vendorUserId, vendorId, randomBytes(32), randomBytes(32)],
  );
  await admin.query(
    `insert into pii.vendor_user_profiles (vendor_user_id, phone, telegram_user_id, telegram_chat_id)
     values ($1, '+998000000111', $2, $2)`,
    [vendorUserId, 6_000_000_000 + randomInt(0, 999_999_999)],
  );
  await admin.query(
    `insert into app.listings (id, vendor_id, slug, category_code, name, district_code, description_ru,
                               description_uz, price_from_uzs, price_unit, cap_min, cap_max)
     values ($1, $2, $3, 'hall', $4, 'yunusobod', 'Описание', 'Tavsif', 150000, 'per_guest', 50, 300)`,
    [listingId, vendorId, `metrics-${tag}`, `Metrics Hall ${tag}`],
  );
  await admin.query(
    "insert into pii.listing_contacts (listing_id, public_phone) values ($1, '+998000000999')",
    [listingId],
  );
  await addHallBanquets(admin, listingId, 150_000, 180_000);
  for (let n = 0; n < 3; n++) {
    await admin.query(
      `insert into app.photos (listing_id, status, moderation, storage_key, mime, bytes, width, height, sha256,
                               sort, no_faces_ack)
       values ($1, 'ready', 'approved', $2, 'image/webp', 1000, 1600, 1200, $3, $4, true)`,
      [listingId, `listings/${listingId}/${randomUUID()}.webp`, randomBytes(32), n],
    );
  }
  await admin.query("update app.listings set status = 'review' where id = $1", [listingId]);
  await admin.query("update app.listings set status = 'active' where id = $1", [listingId]);
  await admin.query("insert into app.clients (id, tg_id_hash) values ($1, $2)", [clientId, randomBytes(32)]);

  // ответили за час; молчит 14 часов (срок прошёл); только что (срок впереди — не в расчёте)
  await vendorResponds(await createRequest(40));
  await createRequest(41, 14);
  await createRequest(42);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  if (!admin) return;
  await admin.query("update app.settings set value = $1 where key = 'ops_reminder_pause_minutes'", [
    JSON.stringify(savedPause ?? 30),
  ]);
  try {
    await admin.query("set session_replication_role = replica");
    if (savedApiErrors) {
      await admin.query(
        `update app.api_error_alerts set errors = $1, last_route = $2, last_error_at = $3, last_alert_at = $4`,
        [
          savedApiErrors.errors,
          savedApiErrors.last_route,
          savedApiErrors.last_error_at,
          savedApiErrors.last_alert_at,
        ],
      );
    } else {
      await admin.query("delete from app.api_error_alerts");
    }
    const staff = Object.values(staffIds).filter((id) => id !== "");
    await admin.query(
      "delete from app.outbox where request_id = any($1::uuid[]) or recipient_id = any($2::uuid[])",
      [requestIds, staff],
    );
    await admin.query("delete from app.request_status_log where request_id = any($1::uuid[])", [requestIds]);
    await admin.query("delete from app.audit_log where object_id = any($1::text[])", [
      [...requestIds, listingId, vendorId, vendorUserId, clientId, ...staff, "ops_reminder_pause_minutes"],
    ]);
    await admin.query("delete from pii.request_contacts where request_id = any($1::uuid[])", [requestIds]);
    await admin.query("delete from app.requests where id = any($1::uuid[])", [requestIds]);
    await admin.query("delete from app.consents where subject_id = $1", [clientId]);
    const account = await admin.query<{ id: string | null }>(
      "select account_id as id from app.clients where id = $1",
      [clientId],
    );
    await admin.query("delete from app.clients where id = $1", [clientId]);
    await admin.query("delete from app.accounts where id = $1", [account.rows[0]?.id ?? null]);
    await admin.query("delete from app.listing_status_log where listing_id = $1", [listingId]);
    await admin.query("delete from app.photos where listing_id = $1", [listingId]);
    // Услуги и части дня — в режиме реплики каскад не срабатывает
    await admin.query("delete from app.listing_services where listing_id = $1", [listingId]);
    await admin.query("delete from app.availability_parts where listing_id = $1", [listingId]);
    await admin.query("delete from pii.listing_contacts where listing_id = $1", [listingId]);
    await admin.query("delete from app.listings where id = $1", [listingId]);
    await admin.query("delete from pii.vendor_user_profiles where vendor_user_id = $1", [vendorUserId]);
    await admin.query("delete from app.vendor_users where vendor_id = $1", [vendorId]);
    await admin.query("delete from app.vendor_accounts where id = $1", [vendorId]);
    await admin.query("delete from app.consent_texts where id = any($1::uuid[])", [
      [consentTextId, vendorConsentTextId],
    ]);
  } catch (err) {
    console.warn("[metrics] уборка тестовых данных не удалась — строки останутся в локальной базе", err);
  } finally {
    await admin.query("reset session_replication_role").catch(() => {});
  }
  await cleanupStaff(admin);
  await admin.end();
});

// ════════════════════════════════════════════════════════════════════════════

describe("метрики в панели", () => {
  it("вендор: 3 заявки, в расчёте 2, в срок 1 — 50%; площадка — его единственная", async () => {
    const stats = await ok<VendorResponseStats>(
      api("moderator", "GET", `/staff/metrics/vendors/${vendorId}`),
    );
    expect(stats.days).toBe(30);
    expect(stats.vendor).toMatchObject({
      vendor: { id: vendorId, name: `Metrics Vendor ${tag}` },
      activeListings: 1,
      requests: 3,
      measurable: 2,
      answeredInTime: 1,
      answeredRate: 50,
      responded: 1,
      slaBreaches: 0,
      agreed: 0,
    });
    expect(stats.vendor.medianResponseMinutes).toBeGreaterThanOrEqual(0);
    expect(stats.listings).toHaveLength(1);
    expect(stats.listings[0]).toMatchObject({ listing: { id: listingId, status: "active" }, requests: 3 });
  });

  it("список вендоров и недели; неверный период — 422, чужой вендор — 404", async () => {
    const list = await ok<VendorMetricsList>(api("admin", "GET", "/staff/metrics/vendors?days=7"));
    expect(list.days).toBe(7);
    expect(list.items.find((v) => v.vendor.id === vendorId)).toMatchObject({ requests: 3 });

    const overview = await ok<MetricsOverview>(api("moderator", "GET", "/staff/metrics"));
    expect(overview.weeks).toHaveLength(8);
    expect(overview.weeks[0]?.partial).toBe(true);
    expect(overview.weeks.slice(1).every((w) => !w.partial)).toBe(true);
    expect(overview.slaHours).toBeGreaterThan(0);
    expect(overview.queues.overdue).toBeGreaterThanOrEqual(1);

    expect((await api("admin", "GET", "/staff/metrics?weeks=0")).status).toBe(422);
    expect((await api("admin", "GET", "/staff/metrics/vendors?days=0")).status).toBe(422);
    expect((await api("admin", "GET", `/staff/metrics/vendors/${randomUUID()}`)).status).toBe(404);
  });
});

describe("метрики по категориям", () => {
  it("вендор и его витрины — с категориями", async () => {
    const stats = await ok<VendorResponseStats>(
      api("moderator", "GET", `/staff/metrics/vendors/${vendorId}`),
    );
    expect(stats.vendor.categories).toEqual(["hall"]);
    expect(stats.listings[0]?.listing.categoryCode).toBe("hall");
  });

  it("фильтр категории: недели и вендоры — только её заявки; неизвестная — 422", async () => {
    const all = await ok<MetricsOverview>(api("moderator", "GET", "/staff/metrics?weeks=1"));
    const halls = await ok<MetricsOverview>(api("moderator", "GET", "/staff/metrics?weeks=1&category=hall"));
    const cars = await ok<MetricsOverview>(api("moderator", "GET", "/staff/metrics?weeks=1&category=car"));
    expect([all.category, halls.category, cars.category]).toEqual([null, "hall", "car"]);
    expect(halls.weeks[0]?.requests).toBeGreaterThanOrEqual(3);
    expect((halls.weeks[0]?.requests ?? 0) + (cars.weeks[0]?.requests ?? 0)).toBeLessThanOrEqual(
      all.weeks[0]?.requests ?? 0,
    );
    // Очереди команды — всегда все
    expect(halls.queues).toEqual(all.queues);

    const hallVendors = await ok<VendorMetricsList>(
      api("admin", "GET", "/staff/metrics/vendors?category=hall"),
    );
    expect(hallVendors.category).toBe("hall");
    expect(hallVendors.items.find((v) => v.vendor.id === vendorId)).toMatchObject({
      requests: 3,
      activeListings: 1,
    });
    const carVendors = await ok<VendorMetricsList>(
      api("admin", "GET", "/staff/metrics/vendors?category=car"),
    );
    expect(carVendors.items.map((v) => v.vendor.id)).not.toContain(vendorId);

    expect((await api("admin", "GET", "/staff/metrics?category=nope")).status).toBe(422);
    expect((await api("admin", "GET", "/staff/metrics/vendors?category=nope")).status).toBe(422);
  });

  it("сводка по категориям: включённые по порядку, заявки витрин категории", async () => {
    const list = await ok<CategoryMetricsList>(api("moderator", "GET", "/staff/metrics/categories"));
    expect(list.days).toBe(30);
    const { rows } = await admin.query<{ code: string }>(
      "select code from app.categories where enabled order by sort, code",
    );
    expect(list.items.map((c) => c.categoryCode)).toEqual(expect.arrayContaining(rows.map((r) => r.code)));
    expect(list.items[0]?.categoryCode).toBe(rows[0]?.code);
    const hall = list.items.find((c) => c.categoryCode === "hall");
    expect(hall?.requests).toBeGreaterThanOrEqual(3);
    expect(hall?.activeListings).toBeGreaterThanOrEqual(1);
    expect((await api("admin", "GET", "/staff/metrics/categories?days=400")).status).toBe(422);
  });
});

describe("отчёты команде и ошибки API", () => {
  it("сводка собирается из базы на языке администратора; числа — без ПДн", async () => {
    const db = createDb(apiDatabaseUrl);
    try {
      const row: OutboxRow = {
        id: randomUUID(),
        kind: "ops.daily_digest",
        channel: "telegram",
        recipient_kind: "staff",
        recipient_id: staffIds.admin,
        request_id: null,
        payload: { day: new Date().toISOString().slice(0, 10) },
        attempts: 1,
      };
      const rendered = await withActor(db, SYSTEM, (trx) =>
        renderNotice(
          trx,
          row,
          {
            webAppUrl: "http://localhost:5173",
            vendorAppUrl: "http://localhost:5174",
            adminAppUrl: "http://localhost:5175",
          },
          new Date(),
        ),
      );
      expect(rendered.ok).toBe(true);
      if (!rendered.ok) return;
      expect(rendered.message.text).toMatch(/Bayramm/);
      expect(rendered.message.text).not.toContain(`Metrics Vendor ${tag}`);
    } finally {
      await db.destroy();
    }
  });

  it("ошибка API: база считает её под актором system", async () => {
    await expect(recordApiError(apiDatabaseUrl, "GET /integration/:id")).resolves.toEqual(
      expect.any(Boolean),
    );
    const { rows } = await admin.query<{ last_route: string }>("select last_route from app.api_error_alerts");
    expect(rows[0]?.last_route).toBe("GET /integration/:id");
  });
});

describe("пауза между напоминаниями — настройка", () => {
  it("только администратор; вне 5–1440 — 422; следующее напоминание — через паузу", async () => {
    expect(
      (await api("moderator", "PUT", "/staff/settings/ops_reminder_pause_minutes", { value: 45 })).status,
    ).toBe(403);
    expect(
      (await api("admin", "PUT", "/staff/settings/ops_reminder_pause_minutes", { value: 3 })).status,
    ).toBe(422);
    const settings = await ok<StaffSettings>(
      api("admin", "PUT", "/staff/settings/ops_reminder_pause_minutes", { value: 45 }),
    );
    expect(settings.items.find((s) => s.key === "ops_reminder_pause_minutes")?.value).toBe(45);

    const awaiting = requestIds[1] ?? "";
    const detail = await ok<StaffRequestDetail>(api("admin", "POST", `/staff/requests/${awaiting}/remind`));
    const reminder = detail.timeline.find((e) => e.kind === "reminder");
    expect(reminder).toBeDefined();
    expect(Date.parse(detail.nextReminderAt ?? "") - Date.parse(reminder?.at ?? "")).toBe(45 * 60_000);
  });
});
