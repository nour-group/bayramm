// Юнит-тесты приложения целиком, без базы: окружение Worker'а и вызов app.request
// с ExecutionContext, который собирает waitUntil.

import app from "../index";

export const BOT_TOKEN = "123456:unit-test-bot-token";

export function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    APP_ENV: "local",
    GIT_SHA: "dev",
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    // Пусто — /telegram/sync не настроен (404); тесты синхронизации задают свой
    TELEGRAM_SYNC_KEY: "",
    ID_HASH_KEY: "unit-test-id-hash-key-0123456789abcdef",
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SERVICE_ROLE_KEY: "unit-test-service-role-key",
    WEB_APP_URL: "http://localhost:5173",
    VENDOR_APP_URL: "http://localhost:5174",
    API_URL: "http://localhost:8787",
    // Порт 1: соединение, если бы до него дошло, сразу упало бы
    HYPERDRIVE: { connectionString: "postgresql://nobody:nothing@127.0.0.1:1/none" } as Hyperdrive,
    ...overrides,
  };
}

export function makeCtx() {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  return { ctx, pending };
}

/** Запрос к приложению; ждёт и всё, что отложено через waitUntil */
export async function call(path: string, init: RequestInit = {}, env = makeEnv()) {
  const { ctx, pending } = makeCtx();
  const res = await app.request(path, init, env, ctx);
  await Promise.all(pending);
  return { res, pending };
}
