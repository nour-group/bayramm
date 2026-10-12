import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env";
import { closePreamble } from "./actor";
import { createDb } from "./client";

// База на время запроса. Пул закрывается после ответа (waitUntil), чтобы
// закрытие соединения не задерживало клиента
export const database = createMiddleware<AppEnv>(async (c, next) => {
  const db = createDb(c.env.HYPERDRIVE.connectionString);
  c.set("db", db);
  try {
    await next();
  } finally {
    // Транзакция преамбулы (db/actor.ts), которую никто не взял, не должна дожить до закрытия пула
    await closePreamble(db);
    c.executionCtx.waitUntil(
      db.destroy().catch((err: unknown) => console.error("db: pool close failed", err)),
    );
  }
});
