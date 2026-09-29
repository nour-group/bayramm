import type {
  CatalogPage,
  CatalogQuery,
  ClientRequest,
  ClientRequests,
  ConsentTexts,
  CreateRequest,
  Dictionaries,
  ListingDetail,
  Locale,
  RequestCreated,
} from "@bayramm/shared/api";
import { ApiError, errorFromResponse, isAbort } from "./errors";
import type { Auth } from "./session";
import type { BotInfo, ClientApi, SessionToken } from "./types";

/* Настоящий API. Сайт ходит в свой /api: воркер web отдаёт его API по сервисной привязке,
   отрезав префикс (packages/edge). Куки не нужны и не шлются — сессия в заголовке Bearer. */

export const API_BASE = "/api";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

interface CallOptions {
  readonly method?: "GET" | "POST";
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly body?: unknown;
  /** Нужна сессия клиента: Authorization: Bearer, при 401 — один повторный вход */
  readonly auth?: Auth;
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
  const { method = "GET", query, body, auth, signal } = options;
  const target = url(base, path, query);

  for (let attempt = 0; ; attempt++) {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
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

    // Токен истёк или отозван: забываем и входим заново, но только один раз
    if (res.status === 401 && auth && attempt === 0) {
      auth.invalidate();
      continue;
    }
    if (!res.ok) throw await errorFromResponse(res);
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
  readonly fetch?: Fetch;
  readonly base?: string;
}

export function createHttpApi({
  auth,
  fetch: fetchFn = (input, init) => globalThis.fetch(input, init),
  base = API_BASE,
}: HttpApiOptions): ClientApi {
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
    createRequest: (body: CreateRequest) =>
      call<RequestCreated>(fetchFn, base, "/requests", { method: "POST", body, auth }),
    myRequests: (signal) => call<ClientRequests>(fetchFn, base, "/requests", { auth, signal }),
    withdrawRequest: (id) =>
      call<ClientRequest>(fetchFn, base, `/requests/${encodeURIComponent(id)}/withdraw`, {
        method: "POST",
        auth,
      }),
  };
}
