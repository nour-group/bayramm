import { sessionGetJson, sessionRemove, sessionSetJson } from "../storage";
import { ApiError } from "./errors";
import type { SessionToken } from "./types";

/* Сессия аккаунта во вкладке.

   Внутри Telegram: initData → POST /auth/telegram → токен; сессия привязана к Telegram ID
   из initDataUnsafe — другой пользователь в той же вкладке старый токен не получит.
   На сайте: вход на странице хаба (/auth) — виджетом Telegram или кодом из сообщения;
   токен сохраняется без Telegram ID (userId null), заново сам не входит.

   Токен — только в хранилище вкладки (sessionStorage, иначе память), не в localStorage.
   initData нигде не сохраняется и не пишется в лог: она живёт в SDK и уходит только
   в тело запроса входа. */

export interface Auth {
  /** Действующий токен; входа нет — ApiError 401 no_session */
  token(): Promise<string>;
  /** Сервер отверг токен — забыть его, следующий token() войдёт заново (или скажет no_session) */
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

/** Сохранённый токен этого пользователя, если он ещё не истёк */
function storedToken(userId: number | null, now: number): string | null {
  const stored = sessionGetJson(SESSION_KEY, isStoredSession);
  if (!stored || stored.userId !== userId) return null;
  const expires = Date.parse(stored.expiresAt);
  return Number.isFinite(expires) && expires - EXPIRY_SKEW_MS > now ? stored.token : null;
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

  return {
    token() {
      const token = storedToken(userId, now());
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

/** Сайт: вход на странице хаба сохранил токен (userId null) */
export function saveSiteSession(session: SessionToken): void {
  sessionSetJson(SESSION_KEY, { userId: null, token: session.token, expiresAt: session.expiresAt });
}

/** Есть ли на сайте действующий вход */
export function hasSiteSession(now = Date.now()): boolean {
  return storedToken(null, now) !== null;
}

/** Сайт: токен из хранилища вкладки; нет или истёк — 401 no_session (войти в хабе) */
export function createSiteAuth(now: () => number = Date.now): Auth {
  return {
    token() {
      const token = storedToken(null, now());
      return token ? Promise.resolve(token) : Promise.reject(new ApiError(401, "no_session"));
    },
    invalidate() {
      sessionRemove(SESSION_KEY);
    },
  };
}

/** Вне Telegram и без входа: заявки и «Мои заявки» — после входа в хабе, каталог — сразу */
export const guestAuth: Auth = {
  token: () => Promise.reject(new ApiError(401, "no_session")),
  invalidate() {},
};
