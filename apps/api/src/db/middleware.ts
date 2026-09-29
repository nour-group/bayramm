import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env";
import { createDb } from "./client";

// База на время запроса. Пул закрывается после ответа (waitUntil), чтобы
// закрытие соединения не задерживало клиента. Если база уже открыта раньше по
// цепочке (лимит по актору в ratelimit.ts), второй пул не создаётся
export const database = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get("db") !== undefined) {
    await next();
    return;
  }
  const db = createDb(c.env.HYPERDRIVE.connectionString);
  c.set("db", db);
  try {
    await next();
  } finally {
    c.executionCtx.waitUntil(
      db.destroy().catch((err: unknown) => console.error("db: pool close failed", err)),
    );
  }
});
