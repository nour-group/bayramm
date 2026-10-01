import { trimTrailingSlashes } from "@bayramm/shared";
import { useCallback, useEffect, useState } from "react";

/* Все экраны кабинета — в одной карте. Пути, вписанные по месту, разъезжаются
   (ловушка №9 в CLAUDE.md). :id — единственный параметр, UUID заявки. */
export const ROUTES = {
  requests: "/requests",
  request: "/requests/:id",
  calendar: "/calendar",
  card: "/card",
  services: "/services",
  account: "/account",
} as const;

export type Route = keyof typeof ROUTES;

/**
 * Разделы в нижней панели (на компьютере — в боковой), по порядку. Пять: на телефоне уже
 * 390px подписи — мельче (styles.css, .tabbar), «Календарь» влезает и на 320px без обрезки
 */
export const NAV = [
  "requests",
  "calendar",
  "card",
  "services",
  "account",
] as const satisfies readonly Route[];
export type Section = (typeof NAV)[number];

/** Главный экран: сюда ведёт корень сайта */
export const HOME: Section = "requests";

/** Раздел, к которому относится экран: карточка заявки — к заявкам */
export const SECTION_OF: Readonly<Record<Route, Section>> = {
  requests: "requests",
  request: "requests",
  calendar: "calendar",
  card: "card",
  services: "services",
  account: "account",
};

export interface Location {
  readonly route: Route;
  /** id заявки для route = request */
  readonly id?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Путь экрана */
export function pathOf(location: Location): string {
  return location.route === "request"
    ? ROUTES.request.replace(":id", location.id ?? "")
    : ROUTES[location.route];
}

/** Экран по пути. Корень — главный экран, неизвестный путь — null */
export function matchRoute(pathname: string): Location | null {
  const path = trimTrailingSlashes(pathname) || "/";
  if (path === "/") return { route: HOME };
  const request = /^\/requests\/([^/]+)$/.exec(path);
  if (request?.[1] !== undefined) {
    return UUID_RE.test(request[1]) ? { route: "request", id: request[1].toLowerCase() } : null;
  }
  const route = (Object.keys(ROUTES) as Route[]).find((key) => key !== "request" && ROUTES[key] === path);
  return route ? { route } : null;
}

export type Navigate = (location: Location, options?: { replace?: boolean }) => void;

/** Текущий экран по адресной строке и переход без перезагрузки */
export function useRoute(): readonly [Location | null, Navigate] {
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

  const navigate = useCallback<Navigate>((location, options) => {
    const next = pathOf(location);
    if (window.location.pathname !== next) {
      // hash (#tgWebAppData=…) не переносим: он нужен SDK только при первом открытии
      if (options?.replace) window.history.replaceState(null, "", next);
      else window.history.pushState(null, "", next);
    }
    setPath(next);
  }, []);

  return [matchRoute(path), navigate] as const;
}
