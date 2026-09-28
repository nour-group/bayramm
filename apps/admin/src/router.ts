import { useCallback, useEffect, useState } from "react";

/* Все маршруты панели — в одной карте. Пути, вписанные по месту, разъезжаются
   (ловушка №9 в CLAUDE.md). Входа нет: его делает Cloudflare Access до воркера. */
export const ROUTES = {
  vendors: "/vendors",
  moderation: "/moderation",
  requests: "/requests",
  clients: "/clients",
} as const;

export type Route = keyof typeof ROUTES;

/** Разделы в навигации, по порядку */
export const NAV: readonly Route[] = ["vendors", "moderation", "requests", "clients"];

/** Главный экран: сюда ведёт корень сайта */
export const HOME: Route = "vendors";

/** Маршрут по пути. Корень — главный экран, неизвестный путь — null */
export function matchRoute(pathname: string): Route | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return HOME;
  return (Object.keys(ROUTES) as Route[]).find((route) => ROUTES[route] === path) ?? null;
}

/** Текущий маршрут по адресной строке и переход без перезагрузки */
export function useRoute(): readonly [Route | null, (route: Route) => void] {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    // Корень показывает главный экран; в адресе оставляем его настоящий путь
    if (window.location.pathname === "/") {
      const { search, hash } = window.location;
      window.history.replaceState(null, "", `${ROUTES[HOME]}${search}${hash}`);
      setPath(ROUTES[HOME]);
    }
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((route: Route) => {
    const next = ROUTES[route];
    if (window.location.pathname !== next) window.history.pushState(null, "", next);
    setPath(next);
  }, []);

  return [matchRoute(path), navigate] as const;
}
