import { sessionGetJson, sessionRemove, sessionSetJson } from "../storage";
import { ApiError } from "./errors";
import type { SessionToken } from "./types";

/* Сессия клиента: initData Telegram → POST /auth/telegram → токен.

   Токен — только в хранилище вкладки (sessionStorage, иначе память), не в localStorage.
   initData нигде не сохраняется и не пишется в лог: она живёт в SDK и уходит только
   в тело запроса входа. Сессия привязана к Telegram ID из initDataUnsafe: другой
   пользователь в той же вкладке старый токен не получит. */

export interface Auth {
  /** Действующий токен; входа нет (обычный браузер) — ApiError 401 no_session */
  token(): Promise<string>;
  /** Сервер отверг токен — забыть его, следующий token() войдёт заново */
  invalidate(): void;
}

export const SESSION_KEY = "bayramm.web.session";
// Входим заново чуть раньше срока: часы клиента и сервера расходятся
const EXPIRY_SKEW_MS = 60_000;

interface StoredSession {
  readonly userId: number | null;
  readonly token: string;
  readonly expiresAt: string;
}

function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== "object" || value === null) return false;
  const { userId, token, expiresAt } = value as Record<string, unknown>;
  return (
    (userId === null || typeof userId === "number") &&
    typeof token === "string" &&
    token.length > 0 &&
    typeof expiresAt === "string"
  );
}

export interface TelegramAuthOptions {
  readonly initData: string;
  /** initDataUnsafe.user.id — только чтобы не отдать чужой токен; права даёт сервер */
  readonly userId: number | null;
  readonly signIn: (initData: string) => Promise<SessionToken>;
  readonly now?: () => number;
}

export function createTelegramAuth({ initData, userId, signIn, now = Date.now }: TelegramAuthOptions): Auth {
  let pending: Promise<string> | null = null;

  const fresh = (): string | null => {
    const stored = sessionGetJson(SESSION_KEY, isStoredSession);
    if (!stored || stored.userId !== userId) return null;
    const expires = Date.parse(stored.expiresAt);
    return Number.isFinite(expires) && expires - EXPIRY_SKEW_MS > now() ? stored.token : null;
  };

  return {
    token() {
      const token = fresh();
      if (token) return Promise.resolve(token);
      // Несколько запросов сразу после старта — один вход на всех
      pending ??= signIn(initData)
        .then((session) => {
          sessionSetJson(SESSION_KEY, { userId, token: session.token, expiresAt: session.expiresAt });
          return session.token;
        })
        .finally(() => {
          pending = null;
        });
      return pending;
    },
    invalidate() {
      sessionRemove(SESSION_KEY);
    },
  };
}

/** Вне Telegram входа нет: заявки и «Мои заявки» недоступны, каталог — да */
export const guestAuth: Auth = {
  token: () => Promise.reject(new ApiError(401, "no_session")),
  invalidate() {},
};
