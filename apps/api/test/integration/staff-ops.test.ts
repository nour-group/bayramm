// Панель оператора v0.2 на настоящем Postgres ролью bayramm_api: работа с
// заявками (напомнить, «связались», заметки, срок ответа по шагам), клиенты и
// блокировка, здоровье уведомлений, журнал действий, настройки, команда, правки
// карточек. Права ролей — на каждом маршруте.
//
// Данные — со случайными названиями; вендоров, карточки и заявки не удаляем (у
// них история в журналах только на добавление). Настройки возвращаются как были.

import { randomBytes, randomInt, randomUUID } from "node:crypto";
import type {
  AuditList,
  ClientDetail,
  ClientList,
  ListingDetail,
  OutboxHealth,
  PiiAccessList,
  RevisionDetail,
  RevisionList,
  StaffRequestDetail,
  StaffRequestList,
  StaffSettings,
  TeamList,
} from "@bayramm/shared/api/staff";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import app from "../../src/index";
import {
  adminClient,
  bearer,
  call,
  cleanup,
  inviteStaff,
  loginToken,
  makeEnv,
  newStaffUsername,
  newTelegramUser,
  staffLoginToken,
  tgIdHash,
} from "./helpers";

let admin: Client;
const tokens = { admin: "", manager: "", moderator: "" };
const staffIds = { admin: "", manager: "", moderator: "" };
type Who = keyof typeof tokens;

const tag = randomBytes(3).toString("hex");
const consentTextId = randomUUID();
const vendorConsentTextId = randomUUID();

// Действия с заявкой отправляют уведомления сразу (outboxKick): в настоящий Telegram
// тесты не ходят — сеть к нему «недоступна», строки остаются для повтора
const realFetch = globalThis.fetch;
vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input instanceof Request ? input.url : input).startsWith("https://api.telegram.org/")) {
    throw new TypeError("Telegram is offline in tests");
  }
  return realFetch(input, init);
});

async function staffToken(role: Who): Promise<void> {
  const username = newStaffUsername();
  staffIds[role] = await inviteStaff(admin, { username, role, displayName: `Ops ${role} ${tag}` });
  tokens[role] = await staffLoginToken(username);
}

async function api(who: Who | string, method: string, path: string, body?: unknown): Promise<Response> {
  const token = who in tokens ? tokens[who as Who] : who;
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

async function ok<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  const text = await r.text();
  if (r.status !== status) throw new Error(`ожидался ${status}, пришёл ${r.status}: ${text}`);
  return JSON.parse(text) as T;
}

async function error(res: Response | Promise<Response>) {
  const r = await res;
  const body = (await r.json()) as { error: { code: string; details?: string[] } };
  return { status: r.status, code: body.error.code, details: body.error.details };
}

const status = async (res: Response | Promise<Response>) => (await res).status;

// ── данные ──────────────────────────────────────────────────────────────────

/** Опубликованный зал вендора с пройденной проверкой — под postgres (актор — system) */
async function createVendor(label: string, linked: boolean) {
  const vendorId = randomUUID();
  const listingId = randomUUID();
  const userId = randomUUID();
  await admin.query(
    `insert into app.vendor_accounts (id, name, legal_form, contract_no, contract_signed_at, stir_verified_at,
                                      contacts_confirmed_at, pd_consent_signed_at, pd_consent_text_id)
     values ($1, $2, 'ooo', $3, now(), now(), now(), now(), $4)`,
    [vendorId, `Ops Vendor ${label} ${tag}`, `T-${tag}-${label}`, vendorConsentTextId],
  );
  if (linked) {
    // Пользователь кабинета привязал Telegram и открыл бота — напоминание ему дойдёт
    await admin.query(
      `insert into app.vendor_users (id, vendor_id, phone_hash, tg_user_hash, tg_linked_at)
       values ($1, $2, $3, $4, now())`,
      [userId, vendorId, randomBytes(32), randomBytes(32)],
    );
    await admin.query(
      `insert into pii.vendor_user_profiles (vendor_user_id, phone, telegram_user_id, telegram_chat_id)
       values ($1, '+998000000111', $2, $2)`,
      [userId, 6_000_000_000 + randomInt(0, 999_999_999)],
    );
  }
  await admin.query(
    `insert into app.listings (id, vendor_id, slug, category_code, name, district_code, description_ru,
                               description_uz, price_from_uzs, price_unit, cap_min, cap_max)
     values ($1, $2, $3, 'hall', $4, 'yunusobod', 'Описание', 'Tavsif', 150000, 'per_guest', 50, 300)`,
    [listingId, vendorId, `ops-${tag}-${label.toLowerCase()}`, `Ops Hall ${label} ${tag}`],
  );
  await admin.query(
    "insert into pii.listing_contacts (listing_id, public_phone) values ($1, '+998000000999')",
    [listingId],
  );
  await admin.query(
    `insert into app.listing_packages (listing_id, kind, name_ru, name_uz, price_uzs) values
       ($1, 'weekday', 'Будни', 'Ish kuni', 150000), ($1, 'weekend', 'Выходные', 'Dam olish', 180000)`,
    [listingId],
  );
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
  return { vendorId, listingId, userId };
}

async function createClient(phone: string | null): Promise<string> {
  const id = randomUUID();
  clientIds.push(id);
  await admin.query("insert into app.clients (id, tg_id_hash) values ($1, $2)", [id, randomBytes(32)]);
  await admin.query(
    "insert into pii.client_profiles (client_id, telegram_id, first_name, phone) values ($1, $2, 'Ops Client', $3)",
    [id, 5_000_000_000 + randomInt(0, 999_999_999), phone],
  );
  return id;
}

async function createRequest(clientId: string, listingId: string, days: number) {
  const consent = randomUUID();
  await admin.query(
    `insert into app.consents (id, subject_kind, subject_id, purpose, action, text_id, scope_listing_id, source)
     values ($1, 'client', $2, 'request_transfer', 'grant', $3, $4, 'tma')`,
    [consent, clientId, consentTextId, listingId],
  );
  const { rows } = await admin.query<{ id: string; public_no: string }>(
    `insert into app.requests (client_id, listing_id, vendor_id, consent_id, occasion_code, event_date, guests, source)
     select $1, $2, l.vendor_id, $3, 'toy', current_date + $4::int, 150, 'tma' from app.listings l where l.id = $2
     returning id, public_no`,
    [clientId, listingId, consent, days],
  );
  const row = rows[0];
  if (!row) throw new Error("заявка не создана");
  await admin.query(
    "insert into pii.request_contacts (request_id, contact_name, contact_phone) values ($1, 'Ops Client', '+998000000301')",
    [row.id],
  );
  return { id: row.id, no: Number(row.public_no) };
}

/** Как будто заявка ждёт дольше срока: создана 14 часов назад (в обход триггера неизменности) */
async function makeOverdue(requestId: string): Promise<void> {
  await admin.query("begin");
  await admin.query("set local session_replication_role = replica");
  await admin.query(
    `update app.requests set created_at = now() - interval '14 hours', sla_due_at = now() - interval '2 hours'
     where id = $1`,
    [requestId],
  );
  await admin.query("commit");
}

let A: { vendorId: string; listingId: string; userId: string };
let B: { vendorId: string; listingId: string; userId: string };
let clientA = "";
const clientPhone = `+99890${String(randomInt(0, 10_000_000)).padStart(7, "0")}`;
let ra: { id: string; no: number };
let rb: { id: string; no: number };
let rc: { id: string; no: number };
let savedSettings: { key: string; value: unknown }[] = [];
// Что убрать после тестов
const clientIds: string[] = [];
const extraStaff: string[] = [];
const outboxIds: string[] = [];

beforeAll(async () => {
  admin = await adminClient();
  const { rows } = await admin.query<{ key: string; value: unknown }>("select key, value from app.settings");
  savedSettings = rows;
  const version = randomInt(1_000, 1_000_000_000);
  await admin.query(
    `insert into app.consent_texts (id, purpose, version, locale, body) values
       ($1, 'request_transfer', $3, 'ru', 'Тестовый текст: передать контакты вендору'),
       ($2, 'vendor_contact', $3, 'ru', 'Тестовый текст: данные контактного лица')`,
    [consentTextId, vendorConsentTextId, version],
  );
  await staffToken("admin");
  await staffToken("manager");
  await staffToken("moderator");
  A = await createVendor("A", true);
  B = await createVendor("B", false);
  clientA = await createClient(clientPhone);
  const clientB = await createClient(null);
  ra = await createRequest(clientA, A.listingId, 40);
  rb = await createRequest(clientB, B.listingId, 41);
  rc = await createRequest(clientA, A.listingId, 42);
  await makeOverdue(ra.id);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  if (!admin) return;
  // Настройки общие для всех тестов базы — возвращаем как были
  for (const { key, value } of savedSettings) {
    await admin.query("update app.settings set value = $2 where key = $1", [key, JSON.stringify(value)]);
  }
  await cleanup(admin);
  // Тестовые строки убираем в режиме реплики: журналы только на добавление, и их
  // триггеры (как и внешние ключи) здесь не срабатывают. Уведомления — обязательно:
  // иначе оставшиеся в очереди строки отправит проход отправителя в чужом тесте
  const requestIds = [ra, rb, rc].filter(Boolean).map((r) => r.id);
  const listings = [A, B].filter(Boolean).map((v) => v.listingId);
  const accounts = [A, B].filter(Boolean).map((v) => v.vendorId);
  const staff = [...Object.values(staffIds), ...extraStaff].filter((id) => id !== "");
  const objects = [...requestIds, ...listings, ...accounts, ...clientIds, ...staff, ...outboxIds];
  try {
    await admin.query("set session_replication_role = replica");
    await admin.query("delete from app.outbox where request_id = any($1::uuid[]) or id = any($2::uuid[])", [
      requestIds,
      outboxIds,
    ]);
    await admin.query("delete from app.request_notes where request_id = any($1::uuid[])", [requestIds]);
    await admin.query("delete from app.request_status_log where request_id = any($1::uuid[])", [requestIds]);
    await admin.query("delete from app.pii_access_log where subject_id = any($1::uuid[])", [
      [...requestIds, ...clientIds, ...listings, ...accounts],
    ]);
    await admin.query("delete from app.audit_log where object_id = any($1::text[])", [objects]);
    await admin.query("delete from pii.request_contacts where request_id = any($1::uuid[])", [requestIds]);
    await admin.query("delete from app.requests where id = any($1::uuid[])", [requestIds]);
    await admin.query("delete from app.consents where subject_id = any($1::uuid[])", [clientIds]);
    await admin.query("delete from pii.client_profiles where client_id = any($1::uuid[])", [clientIds]);
    await admin.query("delete from app.clients where id = any($1::uuid[])", [clientIds]);
    await admin.query("delete from app.listing_revisions where listing_id = any($1::uuid[])", [listings]);
    await admin.query("delete from app.listing_status_log where listing_id = any($1::uuid[])", [listings]);
    await admin.query("delete from app.photos where listing_id = any($1::uuid[])", [listings]);
    await admin.query("delete from app.listing_packages where listing_id = any($1::uuid[])", [listings]);
    await admin.query("delete from pii.listing_contacts where listing_id = any($1::uuid[])", [listings]);
    await admin.query("delete from app.listings where id = any($1::uuid[])", [listings]);
    await admin.query(
      "delete from pii.vendor_user_profiles where vendor_user_id in (select id from app.vendor_users where vendor_id = any($1::uuid[]))",
      [accounts],
    );
    await admin.query("delete from app.vendor_users where vendor_id = any($1::uuid[])", [accounts]);
    await admin.query("delete from app.vendor_accounts where id = any($1::uuid[])", [accounts]);
    await admin.query("delete from app.consent_texts where id = any($1::uuid[])", [
      [consentTextId, vendorConsentTextId],
    ]);
    await admin.query("delete from app.sessions where staff_id = any($1::uuid[])", [staff]);
    await admin.query("delete from pii.staff_profiles where staff_id = any($1::uuid[])", [staff]);
    await admin.query("delete from app.staff where id = any($1::uuid[])", [staff]);
  } catch (err) {
    console.warn("[staff-ops] уборка тестовых данных не удалась — строки останутся в локальной базе", err);
  } finally {
    await admin.query("reset session_replication_role").catch(() => {});
    await admin.end();
  }
});

// ════════════════════════════════════════════════════════════════════════════

describe("заявки: очередь просроченных и срок ответа по шагам", () => {
  it("sla=late — просроченные, самый давний срок первым; модератору заявки недоступны", async () => {
    const list = await ok<StaffRequestList>(api("manager", "GET", "/staff/requests?sla=late&limit=100"));
    expect(list.items.map((r) => r.id)).toContain(ra.id);
    expect(list.items.map((r) => r.id)).not.toContain(rb.id);
    expect(list.items.every((r) => r.sla === "overdue" || r.sla === "breached")).toBe(true);
    const due = list.items.map((r) => r.slaDueAt);
    expect([...due].sort()).toEqual(due);
    expect(await status(api("moderator", "GET", "/staff/requests?sla=late"))).toBe(403);
  });

  it("заявка: создана, срок прошёл; ждёт ответа; напоминание дойдёт одному пользователю вендора", async () => {
    const detail = await ok<StaffRequestDetail>(api("manager", "GET", `/staff/requests/${ra.id}`));
    expect(detail).toMatchObject({
      sla: "overdue",
      awaiting: true,
      vendorReachable: 1,
      nextReminderAt: null,
    });
    expect(detail.timeline.map((e) => e.kind)).toEqual(["created", "due"]);
    expect(detail.timeline[1]).toMatchObject({ kind: "due", passed: true });
    expect(detail.notes).toEqual([]);
  });
});

describe("заявки: напомнить вендору", () => {
  it("модератор не напоминает; менеджер — да: событие в сроке ответа, в outbox — только id", async () => {
    expect(await status(api("moderator", "POST", `/staff/requests/${ra.id}/remind`))).toBe(403);
    const detail = await ok<StaffRequestDetail>(api("manager", "POST", `/staff/requests/${ra.id}/remind`));
    const reminder = detail.timeline.find((e) => e.kind === "reminder");
    expect(reminder).toMatchObject({ source: "ops", by: `Ops manager ${tag}`, recipients: 1, stage: null });
    expect(detail.reminders).toBe(1);
    expect(detail.nextReminderAt).not.toBeNull();

    const { rows } = await admin.query<{ kind: string; payload: unknown; status: string }>(
      "select kind, payload, status from app.outbox where request_id = $1 and kind = 'vendor.ops_reminder'",
      [ra.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({ request_id: ra.id, staff_id: staffIds.manager });
    // Telegram в тестах «недоступен»: строка ждёт повтора, а не потеряна
    expect(["pending", "failed"]).toContain(rows[0]?.status);
  });

  it("второе подряд — 429; вендору без Telegram — 409 vendor_unreachable (звонить)", async () => {
    expect(await error(api("manager", "POST", `/staff/requests/${ra.id}/remind`))).toMatchObject({
      status: 429,
      code: "reminder_too_soon",
    });
    expect(await error(api("admin", "POST", `/staff/requests/${rb.id}/remind`))).toMatchObject({
      status: 409,
      code: "vendor_unreachable",
    });
    const detail = await ok<StaffRequestDetail>(api("manager", "GET", `/staff/requests/${rb.id}`));
    expect(detail.vendorReachable).toBe(0);
    expect(detail.reminders).toBe(0);
  });

  it("чужой id — 404", async () => {
    expect(await status(api("manager", "POST", `/staff/requests/${randomUUID()}/remind`))).toBe(404);
  });
});

describe("заявки: заметки и «связались»", () => {
  it("заметка: добавляет менеджер, автор и время — из базы; пустая — 422; модератор — 403", async () => {
    const detail = await ok<StaffRequestDetail>(
      api("manager", "POST", `/staff/requests/${rc.id}/notes`, { text: "  Вендор в отпуске до пятницы " }),
      201,
    );
    expect(detail.notes).toMatchObject([
      { text: "Вендор в отпуске до пятницы", authorName: `Ops manager ${tag}` },
    ]);
    expect(
      await error(api("manager", "POST", `/staff/requests/${rc.id}/notes`, { text: " " })),
    ).toMatchObject({
      status: 422,
      details: ["text"],
    });
    expect(await status(api("moderator", "POST", `/staff/requests/${rc.id}/notes`, { text: "x" }))).toBe(403);
  });

  it("«связались»: первый ответ — сотрудника, в метрику вендора не идёт; повтор — 409", async () => {
    const detail = await ok<StaffRequestDetail>(
      api("manager", "POST", `/staff/requests/${rc.id}/contacted`, { comment: "Созвонились с клиентом" }),
    );
    expect(detail).toMatchObject({
      status: "contacted",
      sla: "ops_contacted",
      firstResponseBy: "staff",
      awaiting: false,
    });
    expect(detail.history[0]).toMatchObject({
      from: "new",
      to: "contacted",
      actorKind: "staff",
      source: "admin",
      reason: "Созвонились с клиентом",
    });
    // Ответ — до срока: срок ответа в шагах идёт после него
    expect(detail.timeline.map((e) => e.kind)).toEqual(["created", "response", "due"]);
    expect(detail.timeline[1]).toMatchObject({ kind: "response", by: "staff" });

    expect(await error(api("manager", "POST", `/staff/requests/${rc.id}/contacted`, {}))).toMatchObject({
      status: 409,
      code: "illegal_transition",
    });
    expect(await error(api("manager", "POST", `/staff/requests/${rc.id}/remind`))).toMatchObject({
      status: 409,
      code: "request_not_awaiting",
    });
    const list = await ok<StaffRequestList>(
      api("manager", "GET", "/staff/requests?sla=ops_contacted&limit=100"),
    );
    expect(list.items.map((r) => r.id)).toContain(rc.id);
    expect(list.counts.ops_contacted).toBeGreaterThanOrEqual(1);
  });
});

describe("клиенты", () => {
  it("поиск — по номеру заявки и id; по имени — ничего; модератору — 403", async () => {
    const byNo = await ok<ClientList>(api("manager", "GET", `/staff/clients?q=${ra.no}`));
    expect(byNo.items.map((c) => c.id)).toEqual([clientA]);
    expect(byNo.items[0]).toMatchObject({ ref: `C-${clientA.slice(0, 8)}`, requests: 2, blocked: false });
    const byRef = await ok<ClientList>(api("manager", "GET", `/staff/clients?q=C-${clientA.slice(0, 8)}`));
    expect(byRef.items.map((c) => c.id)).toContain(clientA);
    const byName = await ok<ClientList>(api("manager", "GET", "/staff/clients?q=Ops%20Client"));
    expect(byName).toEqual({ total: 0, items: [] });
    // В списке — только псевдоним: ни имени, ни телефона
    expect(JSON.stringify(byNo)).not.toContain("Ops Client");
    expect(JSON.stringify(byNo)).not.toContain(clientPhone.slice(4));
    expect(await status(api("moderator", "GET", "/staff/clients"))).toBe(403);
  });

  it("клиент: имя, заявки и журнал согласий; телефона в ответе нет", async () => {
    const detail = await ok<ClientDetail>(api("manager", "GET", `/staff/clients/${clientA}`));
    expect(detail.profile).toMatchObject({ firstName: "Ops Client" });
    expect(detail.requestList.map((r) => r.id).sort()).toEqual([ra.id, rc.id].sort());
    expect(detail.consents).toHaveLength(2);
    expect(detail.consents[0]).toMatchObject({ purpose: "request_transfer", action: "grant" });
    expect(JSON.stringify(detail)).not.toContain(clientPhone.slice(4));
  });

  it("телефон: только администратор и только с причиной; чтение — в журнале доступа к ПДн", async () => {
    expect(await status(api("manager", "POST", `/staff/clients/${clientA}/phone`, { reason: "x" }))).toBe(
      403,
    );
    expect(await error(api("admin", "POST", `/staff/clients/${clientA}/phone`, {}))).toMatchObject({
      status: 422,
      details: ["reason"],
    });
    const revealed = await ok<{ phone: string }>(
      api("admin", "POST", `/staff/clients/${clientA}/phone`, { reason: "Жалоба вендора" }),
    );
    expect(revealed.phone).toBe(clientPhone);
    const pii = await ok<PiiAccessList>(api("admin", "GET", `/staff/audit/pii?object=${clientA}`));
    expect(pii.items).toMatchObject([
      {
        subjectKind: "client",
        purpose: "staff_reveal",
        reason: "Жалоба вендора",
        actor: { id: staffIds.admin },
      },
    ]);
  });

  it("блокировка: с причиной; заблокированный клиент не входит; снятие возвращает доступ", async () => {
    const user = newTelegramUser();
    const clientToken = await loginToken(user);
    const { rows } = await admin.query<{ id: string }>("select id from app.clients where tg_id_hash = $1", [
      tgIdHash(user.id),
    ]);
    const id = rows[0]?.id ?? "";
    clientIds.push(id);

    expect(await status(api("moderator", "POST", `/staff/clients/${id}/block`, { reason: "Спам" }))).toBe(
      403,
    );
    expect(await error(api("manager", "POST", `/staff/clients/${id}/block`, { reason: "" }))).toMatchObject({
      status: 422,
      details: ["reason"],
    });
    const blocked = await ok<ClientDetail>(
      api("manager", "POST", `/staff/clients/${id}/block`, { reason: "Спам заявками" }),
    );
    expect(blocked).toMatchObject({
      blocked: true,
      blockedInfo: { reason: "Спам заявками", by: `Ops manager ${tag}` },
    });
    // Сессия — аккаунта: клиентские маршруты закрыты, свой аккаунт виден с отметкой блокировки
    expect(await error(call("/requests", bearer(clientToken)))).toMatchObject({
      status: 403,
      code: "client_blocked",
    });

    const list = await ok<ClientList>(api("manager", "GET", "/staff/clients?blocked=1&limit=50"));
    expect(list.items.every((c) => c.blocked)).toBe(true);
    expect(list.items.map((c) => c.id)).toContain(id);

    const unblocked = await ok<ClientDetail>(api("manager", "POST", `/staff/clients/${id}/unblock`));
    expect(unblocked.blockedInfo).toBeNull();
    expect(await status(call("/requests", bearer(clientToken)))).toBe(200);

    const audit = await ok<AuditList>(api("admin", "GET", `/staff/audit?type=client&object=${id}`));
    expect(audit.items.map((e) => e.action)).toEqual(["client.unblock", "client.block"]);
  });
});

describe("уведомления", () => {
  let deadId = "";

  beforeAll(async () => {
    const { rows } = await admin.query<{ id: string }>(
      `insert into app.outbox (kind, recipient_kind, recipient_id, request_id, payload, status, attempts, last_error)
       values ('vendor.request_new', 'vendor_user', $1, $2, $3, 'dead', 8, 'api 403: Forbidden: bot was blocked by the user')
       returning id`,
      [A.userId, ra.id, JSON.stringify({ request_id: ra.id })],
    );
    deadId = rows[0]?.id ?? "";
    outboxIds.push(deadId);
  });

  it("счётчики и недоставленные: вид, получатель (начало id), причина, заявка; модератору — 403", async () => {
    const health = await ok<OutboxHealth>(api("manager", "GET", "/staff/outbox"));
    expect(health.counts.dead).toBeGreaterThanOrEqual(1);
    const dead = health.dead.find((d) => d.id === deadId);
    expect(dead).toMatchObject({
      kind: "vendor.request_new",
      recipientKind: "vendor_user",
      attempts: 8,
      error: "api 403: Forbidden: bot was blocked by the user",
      request: { id: ra.id, publicNo: ra.no },
    });
    expect(dead?.recipientRef).toHaveLength(8);
    expect(JSON.stringify(health)).not.toContain("payload");
    expect(await status(api("moderator", "GET", "/staff/outbox"))).toBe(403);
  });

  it("повтор: только администратор; строка снова в очереди; второй раз — 409", async () => {
    expect(await status(api("manager", "POST", `/staff/outbox/${deadId}/retry`))).toBe(403);
    const health = await ok<OutboxHealth>(api("admin", "POST", `/staff/outbox/${deadId}/retry`));
    expect(health.dead.map((d) => d.id)).not.toContain(deadId);
    const { rows } = await admin.query<{ status: string; attempts: number }>(
      "select status, attempts from app.outbox where id = $1",
      [deadId],
    );
    // Снова в очереди с нуля попыток; отправитель (outboxKick) мог уже попробовать —
    // Telegram в тестах «недоступен», строка ждёт повтора
    expect(["pending", "failed"]).toContain(rows[0]?.status);
    expect(rows[0]?.attempts).toBeLessThanOrEqual(1);
    expect(await error(api("admin", "POST", `/staff/outbox/${deadId}/retry`))).toMatchObject({
      status: 409,
      code: "illegal_transition",
    });
    const audit = await ok<AuditList>(api("admin", "GET", `/staff/audit?type=outbox&object=${deadId}`));
    expect(audit.items[0]).toMatchObject({ action: "outbox.retry", detail: { kind: "vendor.request_new" } });
  });
});

describe("журнал действий", () => {
  it("по заявке: напоминание, заметка, «связались» — кто и что, без текста; только администратор", async () => {
    const ofRa = await ok<AuditList>(api("admin", "GET", `/staff/audit?type=request&object=${ra.id}`));
    expect(ofRa.items).toMatchObject([
      {
        action: "request.remind",
        actor: { id: staffIds.manager, name: `Ops manager ${tag}` },
        detail: { recipients: 1 },
      },
    ]);
    const ofRc = await ok<AuditList>(api("admin", "GET", `/staff/audit?type=request&object=${rc.id}`));
    expect(ofRc.items.map((e) => e.action).sort()).toEqual(["request.update", "request_note.create"]);
    expect(JSON.stringify(ofRc)).not.toMatch(/отпуске|Созвонились/);
    expect(await status(api("manager", "GET", "/staff/audit"))).toBe(403);
  });

  it("фильтры: сотрудник, начало кода действия, дни; неверный фильтр — 422 с именем", async () => {
    const mine = await ok<AuditList>(
      api("admin", "GET", `/staff/audit?actor=${staffIds.manager}&action=request&limit=100`),
    );
    expect(mine.total).toBeGreaterThanOrEqual(3);
    expect(mine.items.every((e) => e.actor?.id === staffIds.manager && e.action.startsWith("request"))).toBe(
      true,
    );
    const future = await ok<AuditList>(api("admin", "GET", "/staff/audit?from=2099-01-01"));
    expect(future.total).toBe(0);
    expect(await error(api("admin", "GET", "/staff/audit?actor=nope&to=2026-13-01"))).toMatchObject({
      status: 422,
      details: ["actor", "to"],
    });
  });
});

describe("правки карточек (ревизии)", () => {
  let revisionId = "";

  beforeAll(async () => {
    const { rows } = await admin.query<{ id: string }>(
      `insert into app.listing_revisions (listing_id, payload, base_version)
       select id, $2, version from app.listings where id = $1 returning id`,
      [
        A.listingId,
        JSON.stringify({
          name: `Ops Hall A Grand ${tag}`,
          price_from_uzs: 200000,
          packages: [
            { kind: "weekday", name_ru: "Будни", name_uz: "Ish kunlari", price_uzs: 200000 },
            { kind: "weekend", name_ru: "Выходные", name_uz: "Dam olish kunlari", price_uzs: 240000 },
          ],
        }),
      ],
    );
    revisionId = rows[0]?.id ?? "";
  });

  it("очередь и сравнение «сейчас / предлагает вендор»", async () => {
    const list = await ok<RevisionList>(api("moderator", "GET", "/staff/revisions?limit=100"));
    const item = list.items.find((r) => r.id === revisionId);
    expect(item).toMatchObject({
      status: "pending",
      fields: ["name", "priceFromUzs", "packages"],
      stale: false,
    });
    const detail = await ok<RevisionDetail>(api("moderator", "GET", `/staff/revisions/${revisionId}`));
    expect(detail.valid).toBe(true);
    expect(detail.changes[0]).toEqual({
      field: "name",
      before: `Ops Hall A ${tag}`,
      after: `Ops Hall A Grand ${tag}`,
    });
    expect(detail.changes[1]).toEqual({ field: "priceFromUzs", before: 150000, after: 200000 });
  });

  it("одобрить: менеджер — 403; модератор — правка применяется к карточке; повтор — 409", async () => {
    expect(await status(api("manager", "POST", `/staff/revisions/${revisionId}/approve`))).toBe(403);
    const approved = await ok<RevisionDetail>(
      api("moderator", "POST", `/staff/revisions/${revisionId}/approve`),
    );
    expect(approved).toMatchObject({ status: "approved", decidedBy: `Ops moderator ${tag}` });
    const listing = await ok<ListingDetail>(api("moderator", "GET", `/staff/listings/${A.listingId}`));
    expect(listing).toMatchObject({
      name: `Ops Hall A Grand ${tag}`,
      priceFromUzs: 200000,
      status: "active",
    });
    expect(listing.packages.map((p) => p.priceUzs)).toEqual([200000, 240000]);
    expect(await error(api("moderator", "POST", `/staff/revisions/${revisionId}/approve`))).toMatchObject({
      status: 409,
      code: "illegal_transition",
    });
  });

  it("правка с неверным значением: одобрить нельзя (422), отклонить — только с причиной", async () => {
    const { rows } = await admin.query<{ id: string }>(
      `insert into app.listing_revisions (listing_id, payload, base_version)
       select id, '{"price_from_uzs": "по запросу"}', version - 1 from app.listings where id = $1 returning id`,
      [A.listingId],
    );
    const id = rows[0]?.id ?? "";
    const detail = await ok<RevisionDetail>(api("moderator", "GET", `/staff/revisions/${id}`));
    expect(detail).toMatchObject({ valid: false, stale: true });
    expect(detail.changes).toEqual([{ field: "priceFromUzs", before: 200000, after: "по запросу" }]);
    expect(await error(api("moderator", "POST", `/staff/revisions/${id}/approve`))).toMatchObject({
      status: 422,
      code: "revision_invalid",
    });
    expect(await error(api("moderator", "POST", `/staff/revisions/${id}/decline`, {}))).toMatchObject({
      status: 422,
      details: ["reason"],
    });
    const declined = await ok<RevisionDetail>(
      api("moderator", "POST", `/staff/revisions/${id}/decline`, { reason: "Цена обязательна числом" }),
    );
    expect(declined).toMatchObject({ status: "declined", decisionReason: "Цена обязательна числом" });
  });
});

describe("команда", () => {
  it("список — только администратору; себя видно как «вы»", async () => {
    const list = await ok<TeamList>(api("admin", "GET", "/staff/team"));
    expect(list.items.find((m) => m.id === staffIds.admin)).toMatchObject({
      self: true,
      role: "admin",
      linked: true,
    });
    expect(await status(api("manager", "GET", "/staff/team"))).toBe(403);
  });

  it("приглашение: имя без «@» в нижнем регистре; занятое — 409; неверное — 422", async () => {
    const username = `Ops_${randomBytes(4).toString("hex")}`;
    const list = await ok<TeamList>(
      api("admin", "POST", "/staff/team", {
        username: `@${username}`,
        displayName: "Новый модератор",
        role: "moderator",
      }),
      201,
    );
    const invited = list.items.find((m) => m.username === username.toLowerCase());
    expect(invited).toMatchObject({
      displayName: "Новый модератор",
      role: "moderator",
      active: true,
      linked: false,
    });
    if (invited) extraStaff.push(invited.id);
    expect(
      await error(api("admin", "POST", "/staff/team", { username, displayName: "Двойник", role: "manager" })),
    ).toMatchObject({ status: 409, code: "username_taken" });
    expect(
      await error(api("admin", "POST", "/staff/team", { username: "ab", displayName: "", role: "boss" })),
    ).toMatchObject({ status: 422, details: ["username", "displayName", "role"] });
    expect(
      await status(api("manager", "POST", "/staff/team", { username, displayName: "x", role: "admin" })),
    ).toBe(403);
  });

  it("себя не отключить и роль не сменить — 409 staff_self", async () => {
    expect(await error(api("admin", "POST", `/staff/team/${staffIds.admin}/deactivate`))).toMatchObject({
      status: 409,
      code: "staff_self",
    });
    expect(
      await error(api("admin", "POST", `/staff/team/${staffIds.admin}/role`, { role: "manager" })),
    ).toMatchObject({ status: 409, code: "staff_self" });
  });

  it("смена роли и отключение действуют сразу; журнал — кто и что", async () => {
    const username = newStaffUsername();
    const id = await inviteStaff(admin, { username, role: "manager", displayName: `Ops extra ${tag}` });
    extraStaff.push(id);
    const token = await staffLoginToken(username);
    expect(await status(api(token, "GET", "/staff/requests"))).toBe(200);

    await ok<TeamList>(api("admin", "POST", `/staff/team/${id}/role`, { role: "moderator" }));
    expect(await status(api(token, "GET", "/staff/requests"))).toBe(403);

    const list = await ok<TeamList>(api("admin", "POST", `/staff/team/${id}/deactivate`));
    expect(list.items.find((m) => m.id === id)).toMatchObject({ active: false, role: "moderator" });
    expect(await status(api(token, "GET", "/staff/me"))).toBe(401);
    await ok<TeamList>(api("admin", "POST", `/staff/team/${id}/activate`));

    const audit = await ok<AuditList>(api("admin", "GET", `/staff/audit?type=staff&object=${id}`));
    expect(audit.items.map((e) => e.action)).toEqual([
      "staff.activate",
      "staff.deactivate",
      "staff.role",
      // вход в панель — сессия сотрудника по свежему доказательству
      "staff.elevate",
      "staff.telegram_claim",
    ]);
    expect(audit.items[2]?.detail).toEqual({ from: "manager", to: "moderator" });
  });
});

describe("настройки", () => {
  it("список — только администратору", async () => {
    const list = await ok<StaffSettings>(api("admin", "GET", "/staff/settings"));
    expect(list.items.map((s) => s.key)).toContain("sla_hours");
    expect(list.items.find((s) => s.key === "sla_reminder_hours")?.value).toEqual([4, 8]);
    expect(await status(api("manager", "GET", "/staff/settings"))).toBe(403);
    expect(await status(api("manager", "PUT", "/staff/settings/sla_hours", { value: 24 }))).toBe(403);
  });

  it("изменение: кто и когда; вне границ и несогласованное — 422 с ключом; чужой ключ — 404", async () => {
    const list = await ok<StaffSettings>(api("admin", "PUT", "/staff/settings/sla_hours", { value: 24 }));
    expect(list.items.find((s) => s.key === "sla_hours")).toMatchObject({
      value: 24,
      updatedBy: `Ops admin ${tag}`,
    });
    // Напоминания (4 и 8 часов) не могут быть позже срока ответа — проверяет база
    expect(await error(api("admin", "PUT", "/staff/settings/sla_hours", { value: 6 }))).toMatchObject({
      status: 422,
      code: "invalid_input",
      details: ["sla_hours"],
    });
    expect(await error(api("admin", "PUT", "/staff/settings/min_photos", { value: 2 }))).toMatchObject({
      status: 422,
      details: ["min_photos"],
    });
    const quiet = await ok<StaffSettings>(
      api("admin", "PUT", "/staff/settings/quiet_hours", { value: { from: "23:00", to: "07:00" } }),
    );
    expect(quiet.items.find((s) => s.key === "quiet_hours")?.value).toEqual({ from: "23:00", to: "07:00" });
    expect(await status(api("admin", "PUT", "/staff/settings/id_hash_key", { value: 1 }))).toBe(404);

    const audit = await ok<AuditList>(api("admin", "GET", "/staff/audit?type=setting&object=sla_hours"));
    expect(audit.items[0]).toMatchObject({ action: "settings.update", detail: { to: 24 } });
  });
});
