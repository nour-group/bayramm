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

export function makeEnv(): Env {
  return {
    APP_ENV: "local",
    GIT_SHA: "dev",
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_SYNC_KEY: "",
    ID_HASH_KEY,
    WEB_APP_URL: "http://localhost:5173",
    VENDOR_APP_URL: "http://localhost:5174",
    API_URL: "http://localhost:8787",
    HYPERDRIVE: { connectionString: apiDatabaseUrl } as Hyperdrive,
    // Storage нужен только тестам фото — у них свои адрес и ключ (photos.test.ts)
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SERVICE_ROLE_KEY: "",
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

/** Удаляет сотрудников, созданных тестами (сессии, профили, сами сотрудники). */
export async function cleanupStaff(admin: Client): Promise<void> {
  const ids = [...usedStaffIds];
  if (ids.length === 0) return;
  await admin.query("delete from app.sessions where staff_id = any($1::uuid[])", [ids]);
  await admin.query("delete from app.staff where id = any($1::uuid[])", [ids]);
}

/** Удаляет клиентов, созданных тестами (сессии, профили, сами клиенты). */
export async function cleanup(admin: Client): Promise<void> {
  const hashes = [...usedTelegramIds].map(tgIdHash);
  if (hashes.length === 0) return;
  await admin.query(
    `with c as (select id from app.clients where tg_id_hash = any($1::bytea[]))
     delete from app.sessions where client_id in (select id from c)`,
    [hashes],
  );
  await admin.query("delete from app.clients where tg_id_hash = any($1::bytea[])", [hashes]);
}
