import { HUB_APPS, type HubApp, isCodeChallenge, isHubState } from "@bayramm/shared/api/account";
import { ROUTES } from "./router";
import { sessionGet, sessionGetJson, sessionRemove, sessionSet, sessionSetJson } from "./storage";

/* Хаб входа (/auth) — сайт клиента. Кабинет партнёра и панель оператора присылают сюда
   человека с app, state и challenge (PKCE S256): после входа хаб просит у API
   одноразовый код и ведёт браузер на <приложение>/auth/callback?code=…&state=…
   (адрес строит сервер). Без app — обычный вход на сайт: потом — назад, откуда пришли.

   Запрос хаба и путь возврата лежат в хранилище вкладки: вход виджетом Telegram уводит
   браузер на /auth/telegram и обратно, код из сообщения — нет, но страница после входа
   загружается заново (CSP виджета — только у страниц /auth, сессия — у всего сайта). */

/** Переходы с полной загрузкой страницы — через этот объект: тесты подменяют его методы */
export const browser = {
  replace(url: string): void {
    window.location.replace(url);
  },
};

export interface HubRequest {
  readonly app: HubApp;
  readonly state: string;
  readonly codeChallenge: string;
}

export const AUTH_PATH = ROUTES.auth;
const HUB_KEY = "bayramm.hub.request";
const RETURN_KEY = "bayramm.hub.return";
const LINK_KEY = "bayramm.hub.link";

const isHubApp = (value: unknown): value is HubApp => HUB_APPS.includes(value as HubApp);

function isHubRequest(value: unknown): value is HubRequest {
  if (typeof value !== "object" || value === null) return false;
  const { app, state, codeChallenge } = value as Record<string, unknown>;
  return isHubApp(app) && isHubState(state) && isCodeChallenge(codeChallenge);
}

/** Запрос хаба из адреса: app, state, challenge. Кривые — null (а не вход для чужого) */
export function parseHubRequest(query: URLSearchParams): HubRequest | null | "invalid" {
  const app = query.get("app");
  if (app === null) return null;
  const request = { app, state: query.get("state"), codeChallenge: query.get("challenge") };
  return isHubRequest(request) ? request : "invalid";
}

export const saveHubRequest = (request: HubRequest) => sessionSetJson(HUB_KEY, request);
export const loadHubRequest = (): HubRequest | null => sessionGetJson(HUB_KEY, isHubRequest);
export const clearHubRequest = () => sessionRemove(HUB_KEY);

/** Путь возврата после входа на сайт: только свой путь, не «//чужой.сайт» */
export function safeReturn(path: string | null): string | null {
  if (!path?.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) return null;
  if (path === AUTH_PATH || path.startsWith(`${AUTH_PATH}/`) || path.startsWith(`${AUTH_PATH}?`)) return null;
  return path.length <= 300 ? path : null;
}

export function saveReturn(path: string | null): void {
  const safe = safeReturn(path);
  if (safe) sessionSet(RETURN_KEY, safe);
}

/** Куда вернуть после входа (и забыть); по умолчанию — профиль */
export function takeReturn(fallback = "/profile"): string {
  const path = safeReturn(sessionGet(RETURN_KEY));
  sessionRemove(RETURN_KEY);
  return path ?? fallback;
}

/** Профиль → «Подключить Telegram»: виджет вернёт на /auth/telegram, там — добавить, а не войти */
export const startTelegramLink = () => sessionSet(LINK_KEY, "telegram");
export const isTelegramLink = () => sessionGet(LINK_KEY) === "telegram";
export const clearTelegramLink = () => sessionRemove(LINK_KEY);

/** Адрес хаба с запросом на вход (полная загрузка страницы: у /auth свой CSP) */
export function authHref(
  params: { return?: string; link?: "telegram" | "phone"; fresh?: boolean } = {},
): string {
  const query = new URLSearchParams();
  const back = safeReturn(params.return ?? null);
  if (back) query.set("return", back);
  if (params.link) query.set("link", params.link);
  if (params.fresh) query.set("fresh", "1");
  const search = query.toString();
  return search ? `${AUTH_PATH}?${search}` : AUTH_PATH;
}

/** Поля виджета из адреса возврата (data-auth-url): id, first_name, …, auth_date, hash */
export function readWidgetFields(search: string): Record<string, string> | null {
  const params = new URLSearchParams(search);
  if (!params.has("id") || !params.has("auth_date") || !params.has("hash")) return null;
  const fields: Record<string, string> = {};
  for (const [key, value] of params) if (/^[a-z_]{1,32}$/.test(key)) fields[key] = value;
  return fields;
}
