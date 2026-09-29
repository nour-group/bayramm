/* Вход сотрудника. Сотрудник — роль на аккаунте Bayramm; сессия сотрудника (12 часов)
   выдаётся только по свежему входу:
     · панель как Mini App (кнопка «Панель оператора» в боте): initData → POST /auth/staff/webapp;
     · в браузере — хаб входа на сайте Bayramm: панель создаёт verifier и state (PKCE S256),
       хаб после входа возвращает на /auth/callback?code=…&state=…, код + verifier меняются на
       сессию аккаунта (POST /auth/hub/exchange), она — на сессию сотрудника
       (POST /auth/staff/elevate) и сразу отзывается: в панели живёт только сессия сотрудника.
   Виджета Telegram здесь нет: он работает на одном домене бота — на сайте.

   Токен живёт в sessionStorage: до закрытия вкладки, другим вкладкам и после перезапуска
   браузера не виден. localStorage — нельзя: токен панели не должен жить неделями на
   общем компьютере. Если sessionStorage недоступен (приватный режим, запрет) — только
   в памяти, до перезагрузки. */

import type { AuthMethods } from "@bayramm/shared/api/account";
import type { Me } from "@bayramm/shared/api/me";
import type { StaffMe, StaffPermission, StaffRole } from "@bayramm/shared/api/staff";
import { newPkce } from "@bayramm/shared/pkce";

export type { StaffRole };

/** Вошедший сотрудник: GET /staff/me */
export type Staff = StaffMe;

/**
 * Почему не вошли: вход не завершился или ссылка устарела · нет роли сотрудника ·
 * вход был давно (больше 12 часов) · API не ответило
 */
export type SignInError = "invalid" | "denied" | "reauth" | "unavailable";

const TOKEN_KEY = "bayramm.admin.session";
const PENDING_KEY = "bayramm.admin.hub";
const API = "/api";
export const CALLBACK_PATH = "/auth/callback";
/** ?signin=1 — пришли из другого приложения Bayramm: в хаб сразу */
export const SIGNIN_PARAM = "signin";

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

/** Переходы с полной загрузкой страницы — через этот объект: тесты подменяют его */
export const browser = {
  assign(url: string): void {
    window.location.assign(url);
  },
};

async function request(path: string, init: RequestInit): Promise<Response | null> {
  try {
    return await fetch(`${API}${path}`, { ...init, credentials: "omit", cache: "no-store" });
  } catch {
    return null;
  }
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

async function errorCode(res: Response): Promise<string | null> {
  const body = (await res.json().catch(() => null)) as { error?: { code?: unknown } } | null;
  return typeof body?.error?.code === "string" ? body.error.code : null;
}

async function tokenOf(
  res: Response | null,
): Promise<{ ok: true; token: string } | { ok: false; error: SignInError }> {
  if (res === null || res.status >= 500) return { ok: false, error: "unavailable" };
  if (!res.ok) {
    const code = await errorCode(res);
    if (code === "reauth_required") return { ok: false, error: "reauth" };
    if (res.status === 403) return { ok: false, error: "denied" };
    return { ok: false, error: "invalid" };
  }
  const body = (await res.json().catch(() => null)) as { token?: unknown } | null;
  return typeof body?.token === "string"
    ? { ok: true, token: body.token }
    : { ok: false, error: "unavailable" };
}

export type SignInResult = { ok: true; token: string } | { ok: false; error: SignInError };

/** Чем входить и адреса приложений (GET /auth/methods); null — API не ответило */
export async function fetchMethods(): Promise<AuthMethods | null> {
  const res = await request("/auth/methods", {});
  if (res === null || !res.ok) return null;
  return (await res.json().catch(() => null)) as AuthMethods | null;
}

/** Панель как Mini App: сессия сотрудника по свежей initData */
export async function signInWebApp(initData: string): Promise<SignInResult> {
  return tokenOf(await request("/auth/staff/webapp", json({ initData })));
}

interface Pending {
  readonly verifier: string;
  readonly state: string;
  readonly back: string;
}

const isPending = (value: unknown): value is Pending =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Pending).verifier === "string" &&
  typeof (value as Pending).state === "string" &&
  typeof (value as Pending).back === "string";

function readPending(): Pending | null {
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(PENDING_KEY) ?? "null");
    return isPending(value) ? value : null;
  } catch {
    return null;
  }
}

/** В хаб входа на сайте: false — адрес сайта не узнать (API не ответило) */
export async function startHub(back: string): Promise<boolean> {
  const methods = await fetchMethods();
  if (methods === null) return false;
  const { verifier, challenge, state } = await newPkce();
  try {
    window.sessionStorage.setItem(PENDING_KEY, JSON.stringify({ verifier, state, back } satisfies Pending));
  } catch {
    return false;
  }
  const hub = new URL("/auth", methods.apps.web);
  hub.searchParams.set("app", "admin");
  hub.searchParams.set("state", state);
  hub.searchParams.set("challenge", challenge);
  browser.assign(hub.href);
  return true;
}

/**
 * Возврат из хаба: state — наш, код + verifier → сессия аккаунта → сессия сотрудника;
 * сессия аккаунта сразу отзывается. Параметры убираются из адреса до запросов
 */
export async function finishHub(search: string): Promise<SignInResult & { back?: string }> {
  const params = new URLSearchParams(search);
  const code = params.get("code");
  const state = params.get("state");
  const pending = readPending();
  try {
    window.sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // нечего чистить
  }
  if (!code || !state || !pending || pending.state !== state) return { ok: false, error: "invalid" };

  const account = await tokenOf(
    await request("/auth/hub/exchange", json({ app: "admin", code, codeVerifier: pending.verifier, state })),
  );
  if (!account.ok) return account;
  const staff = await tokenOf(
    await request("/auth/staff/elevate", { method: "POST", headers: bearer(account.token) }),
  );
  void request("/auth/logout", { method: "POST", headers: bearer(account.token) });
  return staff.ok ? { ...staff, back: pending.back } : staff;
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

/** Свой аккаунт (GET /me): роли — для ссылки на кабинет партнёра. null — не ответило */
export async function fetchAccount(token: string): Promise<Me | null> {
  const res = await request("/me", { headers: bearer(token) });
  if (res === null || !res.ok) return null;
  return (await res.json().catch(() => null)) as Me | null;
}

/** Отзывает сессию на сервере. Ошибку сети не показываем: токен всё равно стирается у нас. */
export async function signOut(token: string): Promise<void> {
  await request("/auth/logout", { method: "POST", headers: bearer(token) });
}
