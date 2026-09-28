import type { Actor } from "./db/actor";
import type { Db } from "./db/client";

// Контекст Hono: привязки Worker'а и переменные запроса
export interface AppEnv {
  Bindings: Env;
  Variables: {
    /** База запроса (middleware database). Запросы — только через withActor. */
    db: Db;
    /** Кто делает запрос (middleware authenticate). Без токена — guest. */
    actor: Actor;
    /** Сессия, по которой пришёл запрос; null — без токена. */
    sessionId: string | null;
  };
}
