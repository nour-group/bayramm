/* Вход сотрудника: данные виджета Telegram → API → токен сессии.

   Токен живёт в sessionStorage: до закрытия вкладки, другим вкладкам и после перезапуска
   браузера не виден. localStorage — нельзя: токен панели не должен жить неделями на
   общем компьютере. Если sessionStorage недоступен (приватный режим, запрет) — только
   в памяти, до перезагрузки. */

import type { StaffMe, StaffPermission, StaffRole } from "@bayramm/shared/api/staff";

export type { StaffRole };

/** Вошедший сотрудник: GET /staff/me */
export type Staff = StaffMe;

/** Почему не вошли: подпись не прошла или устарела · нет доступа · API не ответило */
export type SignInError = "invalid" | "denied" | "unavailable";

const TOKEN_KEY = "bayramm.admin.session";
const API = "/api";

let memoryToken: string | null = null;

export const tokenStore = {
  get(): string | null {
    try {
      // memoryToken не пуст, только если записать в sessionStorage не удалось
      return window.sessionStorage.getItem(TOKEN_KEY) ?? memoryToken;
    } catch {
      return memoryToken;
    }
  },
  set(token: string): void {
    try {
      window.sessionStorage.setItem(TOKEN_KEY, token);
    } catch {
      memoryToken = token;
    }
  },
  clear(): void {
    memoryToken = null;
    try {
      window.sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      // нечего чистить
    }
  },
};

/**
 * Поля виджета из адреса возврата (data-auth-url): id, first_name, …, auth_date, hash.
 * Без id, auth_date или hash — это не данные виджета: null.
 */
export function readWidgetCallback(search: string): Record<string, string> | null {
  const params = new URLSearchParams(search);
  if (!params.has("id") || !params.has("auth_date") || !params.has("hash")) return null;
  return Object.fromEntries(params);
}

async function request(path: string, init: RequestInit): Promise<Response | null> {
  try {
    return await fetch(`${API}${path}`, { ...init, credentials: "omit", cache: "no-store" });
  } catch {
    return null;
  }
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

// Имя бота: 5–32 символа латиницы, цифр и _, в конце — bot (правила @BotFather)
const BOT_USERNAME_RE = /^[A-Za-z0-9_]{2,29}bot$/i;

/**
 * Бот виджета входа. Имени нет ни в коде, ни в сборке: у каждого окружения свой бот,
 * API узнаёт его по своему токену (GET /telegram/bot). null — API не ответило или
 * ответ не похож на имя бота.
 */
export async function fetchBotUsername(): Promise<string | null> {
  const res = await request("/telegram/bot", {});
  if (res === null || !res.ok) return null;
  const body = (await res.json().catch(() => null)) as { username?: unknown } | null;
  const username = body?.username;
  return typeof username === "string" && BOT_USERNAME_RE.test(username) ? username : null;
}

export async function signIn(
  fields: Record<string, string>,
): Promise<{ ok: true; token: string } | { ok: false; error: SignInError }> {
  const res = await request("/auth/staff/telegram", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(fields),
  });
  if (res === null || res.status >= 500) return { ok: false, error: "unavailable" };
  if (res.status === 403) return { ok: false, error: "denied" };
  if (!res.ok) return { ok: false, error: "invalid" };
  const body = (await res.json().catch(() => null)) as { token?: unknown } | null;
  return typeof body?.token === "string"
    ? { ok: true, token: body.token }
    : { ok: false, error: "unavailable" };
}

/** Сотрудник по токену. null — токен больше не действует (401/403); "unavailable" — API не ответило. */
export async function fetchStaff(token: string): Promise<Staff | null | "unavailable"> {
  const res = await request("/staff/me", { headers: bearer(token) });
  if (res === null || res.status >= 500) return "unavailable";
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as
    | (Omit<Staff, "permissions"> & { permissions?: unknown })
    | null;
  if (body === null) return "unavailable";
  // Права — только для показа кнопок; нет списка — кнопок нет, решает всё равно сервер
  const permissions = Array.isArray(body.permissions)
    ? body.permissions.filter((p): p is StaffPermission => typeof p === "string")
    : [];
  return { ...body, permissions };
}

/** Отзывает сессию на сервере. Ошибку сети не показываем: токен всё равно стирается у нас. */
export async function signOut(token: string): Promise<void> {
  await request("/auth/logout", { method: "POST", headers: bearer(token) });
}
