// Общее для интеграционных тестов: окружение Worker'а, вызов приложения,
// вход тестового клиента и уборка за собой.

import { createHmac, randomBytes, randomInt } from "node:crypto";
import { Client } from "pg";
import { inject } from "vitest";
import app from "../../src/index";
import { initDataFor, type TestTelegramUser } from "../../src/testing/init-data";

export const BOT_TOKEN = "123456:integration-test-bot-token";
// Свой ключ псевдонимов на каждый прогон
export const ID_HASH_KEY = randomBytes(32).toString("base64url");

export const apiDatabaseUrl = inject("apiDatabaseUrl");
export const adminDatabaseUrl = inject("adminDatabaseUrl");

const allowAll: RateLimit = { limit: async () => ({ success: true }) };

export function makeEnv(): Env {
  return {
    APP_ENV: "local",
    GIT_SHA: "dev",
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_SYNC_KEY: "",
    DEMO_SEED_KEY: "",
    ID_HASH_KEY,
    WEB_APP_URL: "http://localhost:5173",
    VENDOR_APP_URL: "http://localhost:5174",
    ADMIN_APP_URL: "http://localhost:5175",
    API_URL: "http://localhost:8787",
    // Виджет входа не настроен; коды из сообщения — в лог (console, только local)
    TELEGRAM_LOGIN_DOMAIN: "",
    OTP_PROVIDER: "console",
    TELEGRAM_GATEWAY_TOKEN: "",
    HYPERDRIVE: { connectionString: apiDatabaseUrl } as Hyperdrive,
    // Storage нужен только тестам фото — у них свои адрес и ключ (photos.test.ts)
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SERVICE_ROLE_KEY: "",
    // Лимиты частоты проверяют юнит-тесты (src/ratelimit.test.ts); здесь — пропускают всё
    RATE_LIMIT_AUTH_IP: allowAll,
    RATE_LIMIT_REQUESTS_IP: allowAll,
    RATE_LIMIT_REQUESTS_ACTOR: allowAll,
  };
}

/** Запрос к приложению как в Worker'е; ждёт и waitUntil (закрытие пула). */
export async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  const res = await app.request(path, init, makeEnv(), ctx);
  await Promise.all(pending);
  return res;
}

export function postLogin(initData: string): Promise<Response> {
  return call("/auth/telegram", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ initData }),
  });
}

export const bearer = (token: string): RequestInit => ({ headers: { Authorization: `Bearer ${token}` } });

// Telegram ID тестовых клиентов — случайные на каждый прогон, чтобы не мешать
// другим данным в локальной базе; по ним же убираем за собой
const usedTelegramIds = new Set<number>();

export function newTelegramUser(patch: Partial<TestTelegramUser> = {}): TestTelegramUser {
  const id = 7_000_000_000 + randomInt(0, 999_999_999);
  usedTelegramIds.add(id);
  return { id, first_name: "Test", ...patch };
}

export async function loginToken(user: TestTelegramUser): Promise<string> {
  const res = await postLogin(await initDataFor(user, { botToken: BOT_TOKEN }));
  if (res.status !== 200) throw new Error(`вход не удался: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { token: string }).token;
}

export function tgIdHash(telegramId: number): Buffer {
  return createHmac("sha256", ID_HASH_KEY).update(String(telegramId)).digest();
}

export async function adminClient(): Promise<Client> {
  const client = new Client({ connectionString: adminDatabaseUrl });
  await client.connect();
  return client;
}

// ── сотрудники ──────────────────────────────────────────────────────────────

export function postStaffLogin(fields: Record<string, unknown>): Promise<Response> {
  return call("/auth/staff/telegram", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(fields),
  });
}

// Приглашения тестов — со случайными вымышленными именами; по id убираем за собой
const usedStaffIds = new Set<string>();

export function newStaffUsername(): string {
  return `test_${randomBytes(6).toString("hex")}`;
}

export interface Invite {
  username: string;
  role?: "admin" | "manager" | "moderator";
  displayName?: string;
  active?: boolean;
}

/** Приглашение сотрудника, как его заводят SQL-ом: строка app.staff и профиль с именем. */
export async function inviteStaff(admin: Client, invite: Invite): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    "insert into app.staff (role, active) values ($1, $2) returning id",
    [invite.role ?? "moderator", invite.active ?? true],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("сотрудник не создан");
  usedStaffIds.add(id);
  await admin.query(
    "insert into pii.staff_profiles (staff_id, display_name, telegram_username) values ($1, $2, $3)",
    [id, invite.displayName ?? "Test Staff", invite.username],
  );
  return id;
}

/** Сотрудник, которого тест завёл через API (приглашение из панели): убрать вместе с остальными */
export function trackStaff(id: string): void {
  usedStaffIds.add(id);
}

/**
 * Удаляет аккаунты и их роли клиента; роли партнёра и сотрудника отвязываются (их
 * убирают тесты, которые их завели). Сессии, способы входа и профили уходят с аккаунтом.
 */
export async function deleteAccounts(admin: Client, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await admin.query(
    "update app.vendor_users set account_id = null, tg_user_hash = null, tg_linked_at = null where account_id = any($1::uuid[])",
    [ids],
  );
  await admin.query(
    "update app.staff set account_id = null, tg_id_hash = null, tg_linked_at = null where account_id = any($1::uuid[])",
    [ids],
  );
  await admin.query("delete from app.clients where account_id = any($1::uuid[])", [ids]);
  await admin.query("delete from app.accounts where id = any($1::uuid[])", [ids]);
}

/** Аккаунты по хэшам Telegram ID: способ входа или клиент с этим хэшем */
export async function accountsOfTelegram(admin: Client, hashes: readonly Buffer[]): Promise<string[]> {
  if (hashes.length === 0) return [];
  const { rows } = await admin.query<{ id: string }>(
    `select account_id as id from app.account_identities where kind = 'telegram' and value_hash = any($1::bytea[])
     union select account_id from app.clients where tg_id_hash = any($1::bytea[])`,
    [hashes],
  );
  return rows.map((row) => row.id);
}

/** Аккаунт клиента */
export async function accountOfClient(admin: Client, clientId: string): Promise<string | undefined> {
  const { rows } = await admin.query<{ id: string }>(
    "select account_id as id from app.clients where id = $1",
    [clientId],
  );
  return rows[0]?.id;
}

/** Удаляет сотрудников, созданных тестами (сессии, профили, сами сотрудники, их аккаунты). */
export async function cleanupStaff(admin: Client): Promise<void> {
  const ids = [...usedStaffIds];
  if (ids.length === 0) return;
  const { rows } = await admin.query<{ id: string }>(
    "select account_id as id from app.staff where id = any($1::uuid[]) and account_id is not null",
    [ids],
  );
  await admin.query("delete from app.sessions where staff_id = any($1::uuid[])", [ids]);
  await admin.query("delete from pii.staff_profiles where staff_id = any($1::uuid[])", [ids]);
  await admin.query("delete from app.staff where id = any($1::uuid[])", [ids]);
  await deleteAccounts(
    admin,
    rows.map((row) => row.id),
  );
}

/** Удаляет клиентов, созданных тестами, вместе с их аккаунтами (сессии, профили). */
export async function cleanup(admin: Client): Promise<void> {
  const hashes = [...usedTelegramIds].map(tgIdHash);
  await deleteAccounts(admin, await accountsOfTelegram(admin, hashes));
}
