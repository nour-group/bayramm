import { trimTrailingSlashes } from "@bayramm/shared";
import type { StaffPermission } from "@bayramm/shared/api/staff";
import { useCallback, useEffect, useState } from "react";

/* Все маршруты панели — в одной карте. Пути, вписанные по месту, разъезжаются
   (ловушка №9 в CLAUDE.md). login — страница входа, loginTelegram — куда виджет Telegram
   возвращает браузер с подписанными данными (data-auth-url). */
export const ROUTES = {
  vendors: "/vendors",
  moderation: "/moderation",
  requests: "/requests",
  clients: "/clients",
  notifications: "/notifications",
  audit: "/audit",
  team: "/team",
  settings: "/settings",
  login: "/login",
  loginTelegram: "/login/telegram",
} as const;

export type Route = keyof typeof ROUTES;

/** Разделы в навигации, по порядку */
export const NAV = [
  "vendors",
  "moderation",
  "requests",
  "clients",
  "notifications",
  "audit",
  "team",
  "settings",
] as const satisfies readonly Route[];

export type Section = (typeof NAV)[number];

/**
 * Право, без которого раздела нет в навигации. Решает сервер — панель только не
 * показывает то, что роли всё равно ответит 403
 */
export const SECTION_PERMISSION: Readonly<Record<Section, StaffPermission>> = {
  vendors: "catalog.read",
  moderation: "catalog.read",
  requests: "requests.read",
  clients: "clients.read",
  notifications: "outbox.read",
  audit: "audit.read",
  team: "team.manage",
  settings: "settings.write",
};

/** Главный экран: сюда ведёт корень сайта и сюда попадают после входа */
export const HOME: Section = "vendors";

/** Маршрут по пути. Корень — главный экран, неизвестный путь — null */
export function matchRoute(pathname: string): Route | null {
  const path = trimTrailingSlashes(pathname) || "/";
  if (path === "/") return HOME;
  return (Object.keys(ROUTES) as Route[]).find((route) => ROUTES[route] === path) ?? null;
}

/** Раздел по пути; страницы входа и неизвестные пути — null */
export function matchSection(pathname: string): Section | null {
  const route = matchRoute(pathname);
  return (NAV as readonly (Route | null)[]).includes(route) ? (route as Section) : null;
}

// ── экраны внутри разделов ─────────────────────────────────────────────────
// Экран — раздел или страница объекта. Шаблоны путей — здесь и только здесь

export type View =
  | { readonly name: Section }
  | { readonly name: "vendorNew" }
  | { readonly name: "vendor"; readonly id: string }
  | { readonly name: "listingNew"; readonly vendorId: string }
  | { readonly name: "listing"; readonly id: string }
  | { readonly name: "request"; readonly id: string }
  | { readonly name: "client"; readonly id: string }
  | { readonly name: "revision"; readonly id: string };

const ID = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";

const PATTERNS: readonly [RegExp, (id: string) => View][] = [
  [/^\/vendors\/new$/, () => ({ name: "vendorNew" })],
  [new RegExp(`^/vendors/${ID}/listings/new$`), (id) => ({ name: "listingNew", vendorId: id })],
  [new RegExp(`^/vendors/${ID}$`), (id) => ({ name: "vendor", id })],
  [new RegExp(`^/listings/${ID}$`), (id) => ({ name: "listing", id })],
  [new RegExp(`^/requests/${ID}$`), (id) => ({ name: "request", id })],
  [new RegExp(`^/clients/${ID}$`), (id) => ({ name: "client", id })],
  [new RegExp(`^/revisions/${ID}$`), (id) => ({ name: "revision", id })],
];

/** Экран по пути; неизвестный путь — null */
export function parseView(pathname: string): View | null {
  const section = matchSection(pathname);
  if (section) return { name: section };
  const path = trimTrailingSlashes(pathname).toLowerCase();
  for (const [re, make] of PATTERNS) {
    const match = re.exec(path);
    if (match) return make(match[1] ?? "");
  }
  return null;
}

/** Путь экрана — обратное к parseView */
export function pathOf(view: View): string {
  switch (view.name) {
    case "vendorNew":
      return "/vendors/new";
    case "vendor":
      return `/vendors/${view.id}`;
    case "listingNew":
      return `/vendors/${view.vendorId}/listings/new`;
    case "listing":
      return `/listings/${view.id}`;
    case "request":
      return `/requests/${view.id}`;
    case "client":
      return `/clients/${view.id}`;
    case "revision":
      return `/revisions/${view.id}`;
    default:
      return ROUTES[view.name];
  }
}

/** Раздел навигации, к которому относится экран */
export function sectionOf(view: View): Section {
  switch (view.name) {
    case "vendorNew":
    case "vendor":
    case "listingNew":
    case "listing":
      return "vendors";
    case "request":
      return "requests";
    case "client":
      return "clients";
    case "revision":
      return "moderation";
    default:
      return view.name;
  }
}

const isLoginPath = (pathname: string) => {
  const route = matchRoute(pathname);
  return route === "login" || route === "loginTelegram";
};

export type Navigate = (view: View) => void;

/** Текущий экран по адресной строке и переход без перезагрузки */
export function useRoute(): readonly [View | null, Navigate] {
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

  const navigate = useCallback((view: View) => {
    const next = pathOf(view);
    if (window.location.pathname !== next) window.history.pushState(null, "", next);
    setPath(next);
  }, []);

  return [isLoginPath(path) ? { name: HOME } : parseView(path), navigate] as const;
}
