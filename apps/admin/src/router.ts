import { useCallback, useEffect, useState } from "react";

/* Все маршруты панели — в одной карте. Пути, вписанные по месту, разъезжаются
   (ловушка №9 в CLAUDE.md). login — страница входа, loginTelegram — куда виджет Telegram
   возвращает браузер с подписанными данными (data-auth-url). */
export const ROUTES = {
  vendors: "/vendors",
  moderation: "/moderation",
  requests: "/requests",
  clients: "/clients",
  login: "/login",
  loginTelegram: "/login/telegram",
} as const;

export type Route = keyof typeof ROUTES;

/** Разделы в навигации, по порядку */
export const NAV = ["vendors", "moderation", "requests", "clients"] as const satisfies readonly Route[];

export type Section = (typeof NAV)[number];

/** Главный экран: сюда ведёт корень сайта и сюда попадают после входа */
export const HOME: Section = "vendors";

/** Маршрут по пути. Корень — главный экран, неизвестный путь — null */
export function matchRoute(pathname: string): Route | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return HOME;
  return (Object.keys(ROUTES) as Route[]).find((route) => ROUTES[route] === path) ?? null;
}

/** Раздел по пути; страницы входа и неизвестные пути — null */
export function matchSection(pathname: string): Section | null {
  const route = matchRoute(pathname);
  return (NAV as readonly (Route | null)[]).includes(route) ? (route as Section) : null;
}

const isLoginPath = (pathname: string) => {
  const route = matchRoute(pathname);
  return route === "login" || route === "loginTelegram";
};

/** Текущий раздел по адресной строке и переход без перезагрузки (после входа) */
export function useRoute(): readonly [Section | null, (section: Section) => void] {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    // Корень и страницы входа у вошедшего показывают главный экран; в адресе — его настоящий путь
    const { pathname, search, hash } = window.location;
    if (pathname === "/" || isLoginPath(pathname)) {
      window.history.replaceState(null, "", `${ROUTES[HOME]}${pathname === "/" ? search + hash : ""}`);
      setPath(ROUTES[HOME]);
    }
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((section: Section) => {
    const next = ROUTES[section];
    if (window.location.pathname !== next) window.history.pushState(null, "", next);
    setPath(next);
  }, []);

  return [isLoginPath(path) ? HOME : matchSection(path), navigate] as const;
}
