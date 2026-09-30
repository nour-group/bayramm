/* Вызовы API кабинета. Всё идёт через свой origin: /api/* воркер кабинета отдаёт API.

   Сессия — сессия аккаунта партнёра (7 дней): в Telegram — по initData из кнопки бота,
   вне Telegram — через хаб входа на сайте (hub.ts). Токен — в sessionStorage: переживает
   перезагрузку, но не закрытие вкладки. sessionStorage недоступен (старый вебвью,
   запрет) — токен только в памяти, до перезагрузки. */

import type { AuthMethods } from "@bayramm/shared/api/account";
import type { Me } from "@bayramm/shared/api/me";
import type {
  BusyDay,
  ListingRevisionPayload,
  VendorCalendar,
  VendorListing,
  VendorMe,
  VendorRequestDetail,
  VendorRequestItem,
  VendorRequestPage,
  VendorRequestPatch,
  VendorRevision,
  VendorRevisionList,
  VendorSignIn,
} from "@bayramm/shared/api/vendor";
import { vendorHeaders } from "./hub";

const API = "/api";
const TOKEN_KEY = "bayramm.vendor.session";

let memoryToken: string | null = null;

export const tokenStore = {
  get(): string | null {
    try {
      return window.sessionStorage.getItem(TOKEN_KEY) ?? memoryToken;
    } catch {
      return memoryToken;
    }
  },
  set(token: string): void {
    memoryToken = token;
    try {
      window.sessionStorage.setItem(TOKEN_KEY, token);
    } catch {
      // только в памяти
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
 * Отказ API: статус и стабильный код ошибки. status 0 — сеть или API не ответило.
 * details — у 422 invalid_input имена неверных полей
 */
export class ApiFailure extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: readonly string[];

  constructor(status: number, code: string, details: readonly string[] = []) {
    super(`${status} ${code}`);
    this.name = "ApiFailure";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function send(path: string, init: RequestInit = {}): Promise<Response> {
  const token = tokenStore.get();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  // Партнёр нескольких вендоров: какой из них — заголовок (hub.ts)
  for (const [name, value] of Object.entries(vendorHeaders())) headers.set(name, value);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  try {
    return await fetch(`${API}${path}`, { ...init, headers, credentials: "omit", cache: "no-store" });
  } catch {
    throw new ApiFailure(0, "network");
  }
}

// Сессия кончилась посреди работы (12 часов, отключили доступ) — App показывает «откройте заново»
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

async function failure(res: Response): Promise<ApiFailure> {
  const body = (await res.json().catch(() => null)) as {
    error?: { code?: unknown; details?: unknown };
  } | null;
  const code = typeof body?.error?.code === "string" ? body.error.code : "unknown";
  const details = Array.isArray(body?.error?.details)
    ? body.error.details.filter((d): d is string => typeof d === "string")
    : [];
  return new ApiFailure(res.status, code, details);
}

async function checked(path: string, init?: RequestInit): Promise<Response> {
  const res = await send(path, init);
  if (res.ok) return res;
  if (res.status === 401 && path.startsWith("/vendor/")) {
    tokenStore.clear();
    onUnauthorized?.();
  }
  throw await failure(res);
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  return (await (await checked(path, init)).json()) as T;
}

async function empty(path: string, init?: RequestInit): Promise<void> {
  await checked(path, init);
}

// ── вход ───────────────────────────────────────────────────────────────────

/** Свой аккаунт и роли (GET /me): вендоры для выбора, роль сотрудника для кнопки панели */
export const accountMe = () => json<Me>("/me");

/** Выйти: отозвать сессию; токен забывается в любом случае */
export async function signOut(): Promise<void> {
  try {
    await send("/auth/logout", { method: "POST" });
  } finally {
    tokenStore.clear();
  }
}

/** Вход по initData Mini App. Токен сохраняется; отказ — ApiFailure (403 vendor_not_linked…) */
export async function signIn(initData: string): Promise<void> {
  const body: VendorSignIn = { initData, app: "vendor" };
  const session = await json<{ token: string }>("/auth/telegram", {
    method: "POST",
    body: JSON.stringify(body),
  });
  tokenStore.set(session.token);
}

/** Чем можно войти на сайте (GET /auth/methods); null — API не ответило */
export async function fetchAuthMethods(): Promise<AuthMethods | null> {
  try {
    return await json<AuthMethods>("/auth/methods");
  } catch {
    return null;
  }
}

// Имя бота: 5–32 символа латиницы, цифр и _, в конце — bot (правила @BotFather)
const BOT_USERNAME_RE = /^[A-Za-z0-9_]{2,29}bot$/i;

/** Ссылка на бота окружения со стартом партнёра; null — API не ответило */
export async function fetchBotLink(): Promise<string | null> {
  try {
    const { username } = await json<{ username?: unknown }>("/telegram/bot");
    return typeof username === "string" && BOT_USERNAME_RE.test(username)
      ? `https://t.me/${username}?start=partner`
      : null;
  } catch {
    return null;
  }
}

// ── кабинет ────────────────────────────────────────────────────────────────

export const api = {
  me: () => json<VendorMe>("/vendor/me"),
  setLocale: (locale: VendorMe["user"]["locale"]) =>
    json<VendorMe>("/vendor/me", { method: "PATCH", body: JSON.stringify({ locale }) }),

  requests: (tab: string, cursor?: string | null) => {
    const query = new URLSearchParams({ tab });
    if (cursor) query.set("cursor", cursor);
    return json<VendorRequestPage>(`/vendor/requests?${query}`);
  },
  request: (id: string) => json<VendorRequestDetail>(`/vendor/requests/${encodeURIComponent(id)}`),
  updateRequest: (id: string, patch: VendorRequestPatch) =>
    json<VendorRequestItem>(`/vendor/requests/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  callAttempt: (id: string) => empty(`/vendor/requests/${encodeURIComponent(id)}/call`, { method: "POST" }),

  listing: (id: string) => json<VendorListing>(`/vendor/listings/${encodeURIComponent(id)}`),
  calendar: (listingId: string, month: string) =>
    json<VendorCalendar>(`/vendor/listings/${encodeURIComponent(listingId)}/calendar?month=${month}`),
  markBusy: (listingId: string, day: string) =>
    json<BusyDay>(`/vendor/listings/${encodeURIComponent(listingId)}/calendar/${day}`, { method: "PUT" }),
  markFree: (listingId: string, day: string) =>
    empty(`/vendor/listings/${encodeURIComponent(listingId)}/calendar/${day}`, { method: "DELETE" }),

  revisions: (listingId: string) =>
    json<VendorRevisionList>(`/vendor/listings/${encodeURIComponent(listingId)}/revisions`),
  proposeRevision: (listingId: string, payload: ListingRevisionPayload) =>
    json<VendorRevision>(`/vendor/listings/${encodeURIComponent(listingId)}/revisions`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  withdrawRevision: (listingId: string, revisionId: string) =>
    json<VendorRevision>(
      `/vendor/listings/${encodeURIComponent(listingId)}/revisions/${encodeURIComponent(revisionId)}/withdraw`,
      { method: "POST" },
    ),
};
