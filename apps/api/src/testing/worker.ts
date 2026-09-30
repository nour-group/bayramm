// Юнит-тесты приложения целиком, без базы: окружение Worker'а и вызов app.request
// с ExecutionContext, который собирает waitUntil.

import app from "../index";

export const BOT_TOKEN = "123456:unit-test-bot-token";

/** Привязка ограничения частоты, которая пропускает всё; вызовы — в calls */
export function allowAllLimiter(): RateLimit & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async limit({ key }) {
      calls.push(key);
      return { success: true };
    },
  };
}

export function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    APP_ENV: "local",
    GIT_SHA: "dev",
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    // Пусто — /telegram/sync не настроен (404); тесты синхронизации задают свой
    TELEGRAM_SYNC_KEY: "",
    // Пусто — /ops/demo нет (404); тесты демо-данных задают свой
    DEMO_SEED_KEY: "",
    ID_HASH_KEY: "unit-test-id-hash-key-0123456789abcdef",
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SERVICE_ROLE_KEY: "unit-test-service-role-key",
    WEB_APP_URL: "http://localhost:5173",
    VENDOR_APP_URL: "http://localhost:5174",
    ADMIN_APP_URL: "http://localhost:5175",
    API_URL: "http://localhost:8787",
    // Виджет входа не настроен; коды из сообщения — в лог (console, только local)
    TELEGRAM_LOGIN_DOMAIN: "",
    OTP_PROVIDER: "console",
    TELEGRAM_GATEWAY_TOKEN: "",
    // Проверки «не робот» нет: её включает секрет Turnstile (тесты src/auth/turnstile.test.ts)
    TURNSTILE_SECRET_KEY: "",
    TURNSTILE_SITE_KEY: "",
    // Порт 1: соединение, если бы до него дошло, сразу упало бы
    HYPERDRIVE: { connectionString: "postgresql://nobody:nothing@127.0.0.1:1/none" } as Hyperdrive,
    RATE_LIMIT_AUTH_IP: allowAllLimiter(),
    RATE_LIMIT_REQUESTS_IP: allowAllLimiter(),
    RATE_LIMIT_REQUESTS_ACTOR: allowAllLimiter(),
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
