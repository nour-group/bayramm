import {
  type CatalogPage,
  type CatalogQuery,
  CLIENT_SOURCE_HEADER,
  type ClientRequest,
  type ClientRequests,
  type ClientSource,
  type ConsentTexts,
  type CreateRequest,
  type Dictionaries,
  type ListingCards,
  type ListingDetail,
  type Locale,
  type RequestCreated,
} from "@bayramm/shared/api";
import type {
  AuthMethods,
  HubCode,
  HubCodeRequest,
  LinkTelegram,
  OtpSent,
} from "@bayramm/shared/api/account";
import type {
  ClientDataExport,
  ClientMePatch,
  ConsentWithdrawn,
  Favorites,
  Me,
  WithdrawConsent,
} from "@bayramm/shared/api/me";
import { ApiError, errorFromResponse, isAbort } from "./errors";
import type { Auth } from "./session";
import type { BotInfo, ClientApi, SessionToken } from "./types";

/* Настоящий API. Сайт ходит в свой /api: воркер web отдаёт его API по сервисной привязке,
   отрезав префикс (packages/edge). Куки не нужны и не шлются — сессия в заголовке Bearer. */

export const API_BASE = "/api";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

interface CallOptions {
  readonly method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly body?: unknown;
  /** Нужна сессия клиента: Authorization: Bearer, при 401 — один повторный вход */
  readonly auth?: Auth;
  /** Откуда заявка: tma — Mini App в Telegram (заголовок CLIENT_SOURCE_HEADER) */
  readonly source?: ClientSource;
  readonly signal?: AbortSignal | undefined;
}

function url(base: string, path: string, query: CallOptions["query"]): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const search = params.toString();
  return `${base}${path}${search ? `?${search}` : ""}`;
}

async function call<T>(fetchFn: Fetch, base: string, path: string, options: CallOptions = {}): Promise<T> {
  const { method = "GET", query, body, auth, signal, source } = options;
  const target = url(base, path, query);

  for (let attempt = 0; ; attempt++) {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (source === "tma") headers[CLIENT_SOURCE_HEADER] = source;
    if (auth) headers.authorization = `Bearer ${await auth.token()}`;

    let res: Response;
    try {
      res = await fetchFn(target, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        credentials: "omit",
        // Личные данные не кладём в кэш браузера
        cache: auth ? "no-store" : "default",
      });
    } catch (error) {
      if (isAbort(error)) throw error;
      throw new ApiError(0, "network");
    }

    // Токен истёк или отозван: забываем и входим заново, но только один раз. reauth_required —
    // сессия жива, но вход был давно для этого действия: её не забываем, решает экран
    if (res.status === 401 && auth && attempt === 0) {
      const error = await errorFromResponse(res);
      if (error.code === "reauth_required") throw error;
      auth.invalidate();
      continue;
    }
    if (!res.ok) throw await errorFromResponse(res);
    // 204 — тела нет (DELETE /me)
    if (res.status === 204) return undefined as T;
    try {
      return (await res.json()) as T;
    } catch {
      throw new ApiError(res.status, "bad_response");
    }
  }
}

/** Вход по initData: POST /auth/telegram { initData } → { token, expiresAt } */
export function telegramSignIn(fetchFn: Fetch, base: string = API_BASE) {
  return (initData: string) =>
    call<SessionToken>(fetchFn, base, "/auth/telegram", { method: "POST", body: { initData } });
}

export interface HttpApiOptions {
  readonly auth: Auth;
  /** tma — внутри Telegram; сайт заголовок не шлёт, сервер пишет web */
  readonly source?: ClientSource;
  readonly fetch?: Fetch;
  readonly base?: string;
}

export function createHttpApi({
  auth,
  source = "web",
  fetch: fetchFn = (input, init) => globalThis.fetch(input, init),
  base = API_BASE,
}: HttpApiOptions): ClientApi {
  // Аккаунт удалён — в этой вкладке больше не входим: новый вход создал бы его заново
  // (так решено для возврата клиента). Заново — только при следующем открытии приложения
  let ended = false;
  const session: Auth = {
    token: () => (ended ? Promise.reject(new ApiError(401, "account_deleted")) : auth.token()),
    invalidate: () => auth.invalidate(),
  };

  const get = <T>(path: string, signal?: AbortSignal, query?: CallOptions["query"]) =>
    call<T>(fetchFn, base, path, { query, signal });

  return {
    mode: "live",
    dictionaries: (signal) => get<Dictionaries>("/dictionaries", signal),
    catalog: (query: CatalogQuery, signal) =>
      get<CatalogPage>("/catalog/listings", signal, {
        category: query.category,
        district: query.district,
        date: query.date,
        guests: query.guests,
        sort: query.sort,
        cursor: query.cursor,
        limit: query.limit,
      }),
    listing: (slug, signal) => get<ListingDetail>(`/catalog/listings/${encodeURIComponent(slug)}`, signal),
    consentTexts: (locale: Locale, signal) => get<ConsentTexts>("/consent-texts", signal, { locale }),
    bot: (signal) => get<BotInfo>("/telegram/bot", signal),
    listingCards: (ids, signal) =>
      ids.length === 0
        ? Promise.resolve({ items: [] })
        : get<ListingCards>("/catalog/cards", signal, { ids: ids.join(",") }),
    createRequest: (body: CreateRequest) =>
      call<RequestCreated>(fetchFn, base, "/requests", { method: "POST", body, auth: session, source }),
    myRequests: (signal) =>
      call<ClientRequests>(fetchFn, base, "/requests", { auth: session, signal, source }),
    withdrawRequest: (id) =>
      call<ClientRequest>(fetchFn, base, `/requests/${encodeURIComponent(id)}/withdraw`, {
        method: "POST",
        auth: session,
        source,
      }),
    me: (signal) => call<Me>(fetchFn, base, "/me", { auth: session, signal, source }),
    updateMe: (patch: ClientMePatch) =>
      call<Me>(fetchFn, base, "/me", { method: "PATCH", body: patch, auth: session, source }),
    exportMyData: () => call<ClientDataExport>(fetchFn, base, "/me/export", { auth: session, source }),
    withdrawConsent: (body: WithdrawConsent) =>
      call<ConsentWithdrawn>(fetchFn, base, "/me/consents/withdraw", {
        method: "POST",
        body,
        auth: session,
        source,
      }),
    deleteAccount: async () => {
      await call<void>(fetchFn, base, "/me", { method: "DELETE", auth: session, source });
      ended = true;
      auth.invalidate();
    },
    favorites: (signal) => call<Favorites>(fetchFn, base, "/me/favorites", { auth: session, signal, source }),
    addFavorite: (listingId) =>
      call<void>(fetchFn, base, `/me/favorites/${encodeURIComponent(listingId)}`, {
        method: "PUT",
        auth: session,
        source,
      }),
    removeFavorite: (listingId) =>
      call<void>(fetchFn, base, `/me/favorites/${encodeURIComponent(listingId)}`, {
        method: "DELETE",
        auth: session,
        source,
      }),
    mergeFavorites: (listingIds) =>
      call<Favorites>(fetchFn, base, "/me/favorites", {
        method: "POST",
        body: { listingIds },
        auth: session,
        source,
      }),
    authMethods: (signal) => get<AuthMethods>("/auth/methods", signal),
    signInWidget: (widget, locale) =>
      call<SessionToken>(fetchFn, base, "/auth/widget", { method: "POST", body: { widget, locale } }),
    sendPhoneCode: (phone, proof = {}) =>
      call<OtpSent>(fetchFn, base, "/auth/phone/send", { method: "POST", body: { phone, ...proof } }),
    verifyPhoneCode: (phone, code, locale) =>
      call<SessionToken>(fetchFn, base, "/auth/phone/verify", {
        method: "POST",
        body: { phone, code, locale },
      }),
    hubCode: (request: HubCodeRequest) =>
      call<HubCode>(fetchFn, base, "/auth/hub/code", { method: "POST", body: request, auth: session }),
    linkPhone: (phone, code) =>
      call<Me>(fetchFn, base, "/me/identities/phone", {
        method: "POST",
        body: { phone, code },
        auth: session,
        source,
      }),
    linkTelegram: (body: LinkTelegram) =>
      call<Me>(fetchFn, base, "/me/identities/telegram", { method: "POST", body, auth: session, source }),
    forgetSession: () => auth.invalidate(),
    signOut: async () => {
      try {
        await call<void>(fetchFn, base, "/auth/logout", { method: "POST", auth: session });
      } finally {
        auth.invalidate();
      }
    },
  };
}
