import type { AppCode } from "./auth/account";
import type { Actor } from "./db/actor";
import type { Db } from "./db/client";

/** Сессия запроса (middleware authenticate) */
export interface SessionInfo {
  readonly id: string;
  readonly accountId: string;
  /** account — сессия аккаунта; staff — сессия сотрудника (по свежему доказательству) */
  readonly kind: "account" | "staff";
  /** Где выдана: клиентское приложение, кабинет, панель */
  readonly app: AppCode;
  /** Чем доказан вход (app.sessions.via) */
  readonly via: string;
  /** Когда человек в последний раз доказал, кто он */
  readonly proofAt: Date;
  /** Роль клиента аккаунта; null — её нет */
  readonly client: { readonly id: string; readonly blocked: boolean; readonly deleted: boolean } | null;
}

// Контекст Hono: привязки Worker'а и переменные запроса
export interface AppEnv {
  Bindings: Env;
  Variables: {
    /** База запроса (middleware database). Запросы — только через withActor. */
    db: Db;
    /** Кто делает запрос (middleware authenticate, уточняют requireClient и requireVendor). */
    actor: Actor;
    /** Сессия запроса; null — без токена. */
    session: SessionInfo | null;
    /** id сессии запроса; null — без токена. */
    sessionId: string | null;
  };
}
