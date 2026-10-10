/* Вызовы API кабинета. Всё идёт через свой origin: /api/* воркер кабинета отдаёт API.

   Сессия — сессия аккаунта партнёра (7 дней): в Telegram — по initData из кнопки бота,
   вне Telegram — через хаб входа на сайте (hub.ts). Токен — в sessionStorage: переживает
   перезагрузку, но не закрытие вкладки. sessionStorage недоступен (старый вебвью,
   запрет) — токен только в памяти, до перезагрузки. */

import type { Me } from "@bayramm/shared/api/me";
import type {
  DayPart,
  ListingRevisionPayload,
  ListingService,
  ListingServices,
  ServiceInput,
  VendorCalendar,
  VendorCalendarChange,
  VendorCapacityChange,
  VendorListing,
  VendorMe,
  VendorPhoto,
  VendorRequestDetail,
  VendorRequestItem,
  VendorRequestPage,
  VendorRequestPatch,
  VendorRevision,
  VendorRevisionList,
  VendorSignIn,
} from "@bayramm/shared/api/vendor";
import { CALENDAR_VERSION_HEADER, NO_FACES_HEADER, PHOTO_CONSENT_HEADER } from "@bayramm/shared/api/vendor";
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
 * details — у 422 invalid_input имена неверных полей, у 422 invalid_image — код проверки файла
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
  // Тело-файл (фото) уходит как есть, со своим типом; остальное — JSON
  if (init.body instanceof Blob) headers.set("content-type", init.body.type || "application/octet-stream");
  else if (init.body !== undefined) headers.set("content-type", "application/json");
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

// ── кабинет ────────────────────────────────────────────────────────────────

/**
 * Подтверждение к фото по правилу категории: noFaces — лиц на фото нет (X-No-Faces), consent —
 * люди на фото согласны на публикацию (X-Photo-Consent, только у портфолио). Хоть одно — да
 */
export interface PhotoAck {
  readonly noFaces: boolean;
  readonly consent: boolean;
}

const listingPath = (listingId: string) => `/vendor/listings/${encodeURIComponent(listingId)}`;
const servicePath = (listingId: string, serviceId: string) =>
  `${listingPath(listingId)}/services/${encodeURIComponent(serviceId)}`;
/** День календаря и, у режима parts, его часть: ?part=morning|day|evening */
const dayPath = (listingId: string, day: string, part: DayPart | null) =>
  `${listingPath(listingId)}/calendar/${day}${part ? `?part=${part}` : ""}`;

export const api = {
  me: () => json<VendorMe>("/vendor/me"),
  setLocale: (locale: VendorMe["user"]["locale"]) =>
    json<VendorMe>("/vendor/me", { method: "PATCH", body: JSON.stringify({ locale }) }),

  /** Входящие вкладки; listingId — только заявки этой витрины (null — всех) */
  requests: (tab: string, cursor?: string | null, listingId?: string | null) => {
    const query = new URLSearchParams({ tab });
    if (cursor) query.set("cursor", cursor);
    if (listingId) query.set("listingId", listingId);
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
  /** Черновик (или отклонённую) — на проверку команде: в ответе витрина уже на проверке */
  submitListing: (id: string) =>
    json<VendorListing>(`/vendor/listings/${encodeURIComponent(id)}/submit`, { method: "POST" }),
  /**
   * Фото площадки (только владелец кабинета): photo — результат compressForUpload
   * (@bayramm/media/browser), без метаданных. Подтверждение — заголовками: X-No-Faces — лиц
   * нет, X-Photo-Consent — люди на фото согласны (правило portfolio)
   */
  uploadPhoto: (listingId: string, photo: Blob, ack: PhotoAck = { noFaces: true, consent: false }) => {
    const headers: Record<string, string> = {};
    if (ack.noFaces) headers[NO_FACES_HEADER] = "1";
    if (ack.consent) headers[PHOTO_CONSENT_HEADER] = "1";
    return json<VendorPhoto>(`${listingPath(listingId)}/photos`, { method: "POST", headers, body: photo });
  },
  deletePhoto: (listingId: string, photoId: string) =>
    empty(`/vendor/listings/${encodeURIComponent(listingId)}/photos/${encodeURIComponent(photoId)}`, {
      method: "DELETE",
    }),

  calendar: (listingId: string, month: string) =>
    json<VendorCalendar>(`/vendor/listings/${encodeURIComponent(listingId)}/calendar?month=${month}`),
  /**
   * Правка дня (part — части дня у режима parts) — от версии календаря, которую видел
   * человек: устарела — 409 calendar_conflict
   */
  markBusy: (listingId: string, day: string, version: number, part: DayPart | null = null) =>
    json<VendorCalendarChange>(dayPath(listingId, day, part), {
      method: "PUT",
      headers: { [CALENDAR_VERSION_HEADER]: String(version) },
    }),
  markFree: (listingId: string, day: string, version: number, part: DayPart | null = null) =>
    json<VendorCalendarChange>(dayPath(listingId, day, part), {
      method: "DELETE",
      headers: { [CALENDAR_VERSION_HEADER]: String(version) },
    }),
  /** Сколько заказов витрина берёт одновременно — тоже от версии календаря */
  setCapacity: (listingId: string, parallelCapacity: number, version: number) =>
    json<VendorCapacityChange>(`${listingPath(listingId)}/calendar/capacity`, {
      method: "PUT",
      headers: { [CALENDAR_VERSION_HEADER]: String(version) },
      body: JSON.stringify({ parallelCapacity }),
    }),

  // Услуги витрины: менять — только владелец кабинета (403 vendor_owner_required)
  services: (listingId: string) => json<ListingServices>(`${listingPath(listingId)}/services`),
  createService: (listingId: string, input: ServiceInput) =>
    json<ListingService>(`${listingPath(listingId)}/services`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateService: (listingId: string, serviceId: string, input: ServiceInput) =>
    json<ListingService>(servicePath(listingId, serviceId), {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  submitService: (listingId: string, serviceId: string) =>
    json<ListingService>(`${servicePath(listingId, serviceId)}/submit`, { method: "POST" }),
  withdrawService: (listingId: string, serviceId: string) =>
    json<ListingService>(`${servicePath(listingId, serviceId)}/withdraw`, { method: "POST" }),
  deleteService: (listingId: string, serviceId: string) =>
    empty(servicePath(listingId, serviceId), { method: "DELETE" }),

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
