import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { hrefFor, type Match, matchRoute, parentOf } from "./routes";

/* Навигация без перезагрузки поверх карты маршрутов (routes.ts — без React, её читает и воркер) */
export {
  CATEGORY_CODES,
  canonicalHref,
  DEFAULT_CATEGORY,
  hrefFor,
  isAuth,
  isCategoryParam,
  isInner,
  type Match,
  matchRoute,
  parentOf,
  ROUTES,
  type RouteName,
  screenOf,
  TABS,
  type Tab,
  tabOf,
  widthOf,
} from "./routes";

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
