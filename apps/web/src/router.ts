import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { hrefFor, type Match, matchRoute, parentOf } from "./routes";

/* Навигация без перезагрузки поверх карты маршрутов (routes.ts — без React, её читает и воркер) */
export {
  ALL_CATEGORIES,
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
  /**
   * Куда прокрутить экран, на который вернулись «назад» (или «вперёд»): где человек был,
   * когда с него ушёл. null — новый переход, экран открывается сверху
   */
  readonly restoreScroll: number | null;
  /** Переход без перезагрузки; replace — не добавлять запись в историю */
  navigate(href: string, options?: { replace?: boolean }): void;
  /** Назад по истории вкладки, а если её нет — к родителю экрана */
  back(): void;
}

// Номер записи в истории вкладки: по нему «назад» знает, есть ли куда возвращаться.
// scroll — где был человек, когда ушёл с записи переходом вперёд: «назад» вернёт его туда
interface HistoryState {
  readonly bayrammIdx: number;
  readonly scroll?: number;
}

function historyState(): Partial<HistoryState> | null {
  return window.history.state as Partial<HistoryState> | null;
}

function historyIdx(): number {
  const state = historyState();
  return typeof state?.bayrammIdx === "number" ? state.bayrammIdx : 0;
}

/** Прокрутка страницы сейчас (pageYOffset — у старых вебвью без scrollY) */
const scrollTop = (): number => Math.round(window.scrollY ?? window.pageYOffset ?? 0);

interface Location {
  readonly path: string;
  readonly search: string;
  readonly restoreScroll: number | null;
}

const here = (restoreScroll: number | null = null): Location => ({
  path: window.location.pathname,
  search: window.location.search,
  restoreScroll,
});

export function useRouter(): Router {
  const [location, setLocation] = useState<Location>(() => here());

  useEffect(() => {
    if (typeof historyState()?.bayrammIdx !== "number") {
      window.history.replaceState({ bayrammIdx: 0 } satisfies HistoryState, "");
    }
    // Прокрутку при «назад» ставит приложение, когда экран уже нарисован (App.tsx):
    // браузер сделал бы это раньше, чем придут данные, и промахнулся бы
    if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual";
    const onPop = () => {
      const scroll = historyState()?.scroll;
      setLocation(here(typeof scroll === "number" && scroll > 0 ? scroll : null));
    };
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
      // Уходим с записи — запоминаем в ней прокрутку: «назад» вернёт туда же
      window.history.replaceState(
        { ...historyState(), bayrammIdx: historyIdx(), scroll: scrollTop() } satisfies HistoryState,
        "",
      );
      window.history.pushState({ bayrammIdx: historyIdx() + 1 } satisfies HistoryState, "", next);
    }
    setLocation({ path: url.pathname, search: url.search, restoreScroll: null });
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

  const { restoreScroll } = location;
  return useMemo(
    () => ({ match, query, restoreScroll, navigate, back }),
    [match, query, restoreScroll, navigate, back],
  );
}

export const RouterContext = createContext<Router | null>(null);

export function useNav(): Router {
  const router = useContext(RouterContext);
  if (!router) throw new Error("RouterContext не задан");
  return router;
}
