import { trimTrailingSlashes } from "@bayramm/shared";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

/* Все маршруты клиента — в одной карте. Пути и номера экранов, вписанные по месту,
   разъезжаются (ловушка №9 в CLAUDE.md): ссылки собираем только через hrefFor. */
export const ROUTES = {
  catalog: "/",
  venue: "/venue/:slug",
  request: "/venue/:slug/request",
  favorites: "/favorites",
  requests: "/requests",
  profile: "/profile",
  // Хаб входа: вход на сайт и вход в кабинет и панель (hub.ts). Ссылки сюда — только
  // полной загрузкой: CSP виджета Telegram — у страниц /auth
  auth: "/auth",
  authTelegram: "/auth/telegram",
} as const;

export type RouteName = keyof typeof ROUTES;

export type Match =
  | { readonly name: "catalog" }
  | { readonly name: "venue"; readonly slug: string }
  | { readonly name: "request"; readonly slug: string }
  | { readonly name: "favorites" }
  | { readonly name: "requests" }
  | { readonly name: "profile" }
  | { readonly name: "auth" }
  | { readonly name: "authTelegram" };

/** Вкладки нижней панели, по порядку: как в прототипе — главная, сохранённое, заявки; и профиль */
export const TABS = ["catalog", "favorites", "requests", "profile"] as const satisfies readonly RouteName[];
export type Tab = (typeof TABS)[number];

// Как slug листинга в базе и id в start_param: строчная латиница, цифры, дефис
const SLUG = "([a-z0-9-]{1,64})";
const VENUE_RE = new RegExp(`^/venue/${SLUG}$`);
const REQUEST_RE = new RegExp(`^/venue/${SLUG}/request$`);

/** Маршрут по пути; неизвестный путь — null */
export function matchRoute(pathname: string): Match | null {
  const path = trimTrailingSlashes(pathname) || "/";
  if (path === ROUTES.catalog) return { name: "catalog" };
  if (path === ROUTES.favorites) return { name: "favorites" };
  if (path === ROUTES.requests) return { name: "requests" };
  if (path === ROUTES.profile) return { name: "profile" };
  if (path === ROUTES.auth) return { name: "auth" };
  if (path === ROUTES.authTelegram) return { name: "authTelegram" };
  const venue = VENUE_RE.exec(path)?.[1];
  if (venue) return { name: "venue", slug: venue };
  const request = REQUEST_RE.exec(path)?.[1];
  if (request) return { name: "request", slug: request };
  return null;
}

type Query = Readonly<Record<string, string | number | null | undefined>>;

/** Адрес экрана: путь из карты плюс строка запроса без пустых значений */
export function hrefFor(match: Match, query: Query = {}): string {
  const path = "slug" in match ? ROUTES[match.name].replace(":slug", match.slug) : ROUTES[match.name];
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== null && value !== undefined && value !== "") params.set(key, String(value));
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

/** Куда ведёт «назад», если в истории вкладки до этого экрана ничего нет */
export function parentOf(match: Match | null): Match | null {
  if (match?.name === "request") return { name: "venue", slug: match.slug };
  if (match?.name === "venue") return { name: "catalog" };
  return null;
}

/** Вкладка, к которой относится экран: внутренние экраны — к каталогу */
export function tabOf(match: Match | null): Tab | null {
  if (!match || match.name === "auth" || match.name === "authTelegram") return null;
  if (match.name === "favorites" || match.name === "requests" || match.name === "profile") return match.name;
  return "catalog";
}

export interface Router {
  readonly match: Match | null;
  readonly query: URLSearchParams;
  /** Переход без перезагрузки; replace — не добавлять запись в историю */
  navigate(href: string, options?: { replace?: boolean }): void;
  /** Назад по истории вкладки, а если её нет — к родителю экрана */
  back(): void;
}

// Номер записи в истории вкладки: по нему «назад» знает, есть ли куда возвращаться
interface HistoryState {
  readonly bayrammIdx: number;
}

function historyIdx(): number {
  const state = window.history.state as Partial<HistoryState> | null;
  return typeof state?.bayrammIdx === "number" ? state.bayrammIdx : 0;
}

export function useRouter(): Router {
  const [location, setLocation] = useState(() => ({
    path: window.location.pathname,
    search: window.location.search,
  }));

  useEffect(() => {
    if (typeof (window.history.state as Partial<HistoryState> | null)?.bayrammIdx !== "number") {
      window.history.replaceState({ bayrammIdx: 0 } satisfies HistoryState, "");
    }
    const onPop = () => setLocation({ path: window.location.pathname, search: window.location.search });
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((href: string, options?: { replace?: boolean }) => {
    const url = new URL(href, window.location.origin);
    const next = `${url.pathname}${url.search}`;
    const current = `${window.location.pathname}${window.location.search}`;
    if (options?.replace) {
      window.history.replaceState({ bayrammIdx: historyIdx() } satisfies HistoryState, "", next);
    } else if (next !== current) {
      window.history.pushState({ bayrammIdx: historyIdx() + 1 } satisfies HistoryState, "", next);
    }
    setLocation({ path: url.pathname, search: url.search });
  }, []);

  const match = useMemo(() => matchRoute(location.path), [location.path]);
  const query = useMemo(() => new URLSearchParams(location.search), [location.search]);

  const back = useCallback(() => {
    if (historyIdx() > 0) {
      window.history.back();
      return;
    }
    const parent = parentOf(match);
    navigate(hrefFor(parent ?? { name: "catalog" }), { replace: true });
  }, [match, navigate]);

  return useMemo(() => ({ match, query, navigate, back }), [match, query, navigate, back]);
}

export const RouterContext = createContext<Router | null>(null);

export function useNav(): Router {
  const router = useContext(RouterContext);
  if (!router) throw new Error("RouterContext не задан");
  return router;
}
