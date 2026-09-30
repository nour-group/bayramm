// Ключи служебных маршрутов — их вызывают workflow GitHub, а не люди:
//
//   POST /telegram/sync   TELEGRAM_SYNC_KEY   настройка бота (деплой)
//   POST /ops/demo        DEMO_SEED_KEY       демо-данные staging (workflow Demo data)
//
// Заголовок Authorization: Bearer <ключ>, сравнение за постоянное время (secretsEqual).
//   ключ не задан            → 404: маршрута как будто нет;
//   ключ короче 32 символов  → 500: ошибка настройки, а не запроса — короткий легко подобрать;
//   заголовка нет, ключ не тот → 401.

import type { MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env";
import { notFound, unauthorized } from "../errors";
import { secretsEqual } from "./crypto";

export const MIN_SERVICE_KEY_LENGTH = 32;

export type ServiceKeyName = "TELEGRAM_SYNC_KEY" | "DEMO_SEED_KEY";

export function requireServiceKey(name: ServiceKeyName): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    const expected = c.env[name];
    if (!expected) throw notFound();
    if (expected.length < MIN_SERVICE_KEY_LENGTH) {
      throw new Error(`${name} короче ${MIN_SERVICE_KEY_LENGTH} символов`);
    }
    const received = /^Bearer (\S+)$/i.exec(c.req.header("Authorization")?.trim() ?? "")?.[1];
    if (received === undefined || !(await secretsEqual(received, expected))) throw unauthorized();
    await next();
  });
}
