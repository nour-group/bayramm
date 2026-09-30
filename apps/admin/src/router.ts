import { trimTrailingSlashes } from "@bayramm/shared";
import type { StaffPermission } from "@bayramm/shared/api/staff";
import { useCallback, useEffect, useState } from "react";

/* Все маршруты панели — в одной карте. Пути, вписанные по месту, разъезжаются
   (ловушка №9 в CLAUDE.md). login — страница входа, authCallback — куда хаб входа на
   сайте возвращает браузер с одноразовым кодом (session.ts). */
export const ROUTES = {
  vendors: "/vendors",
  moderation: "/moderation",
  requests: "/requests",
  metrics: "/metrics",
  clients: "/clients",
  notifications: "/notifications",
  audit: "/audit",
  team: "/team",
  settings: "/settings",
  login: "/login",
  authCallback: "/auth/callback",
} as const;

export type Route = keyof typeof ROUTES;

/** Разделы в навигации, по порядку */
export const NAV = [
  "vendors",
  "moderation",
  "requests",
  "metrics",
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
  metrics: "metrics.read",
  clients: "clients.read",
  notifications: "outbox.read",
  audit: "audit.read",
  team: "team.manage",
  settings: "settings.write",
};

/** Главный экран: сюда ведёт корень сайта и сюда попадают после входа */
export const HOME: Section = "vendors";

/**
 * Нижняя панель телефона: разделы по тому, как часто в них заходят с телефона каждый день.
 * Помещается пять кнопок; если разделов у роли больше — четыре первых и «Ещё» с остальными
 */
export const TAB_PRIORITY: readonly Section[] = [
  "requests",
  "moderation",
  "vendors",
  "metrics",
  "clients",
  "notifications",
  "audit",
  "team",
  "settings",
];

export const TAB_SLOTS = 5;

/** Разделы роли → кнопки нижней панели и то, что уходит в «Ещё» (в порядке NAV) */
export function tabsFor(
  sections: readonly Section[],
  slots = TAB_SLOTS,
): { readonly tabs: readonly Section[]; readonly more: readonly Section[] } {
  const ranked = TAB_PRIORITY.filter((section) => sections.includes(section));
  if (ranked.length <= slots) return { tabs: ranked, more: [] };
  const tabs = ranked.slice(0, slots - 1);
  return { tabs, more: NAV.filter((section) => sections.includes(section) && !tabs.includes(section)) };
}

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

/** Экран объекта внутри раздела: у него есть «Назад» */
export function isNested(view: View | null): boolean {
  return view !== null && view.name !== sectionOf(view);
}

/**
 * Куда «Назад», если панель открыли сразу на этом экране (истории внутри панели нет):
 * новая карточка — к её вендору, остальное — к списку раздела
 */
export function parentOf(view: View): View {
  if (view.name === "listingNew") return { name: "vendor", id: view.vendorId };
  return { name: sectionOf(view) };
}

/* Номер записи истории внутри панели: переходы кладут его в history.state. 0 — первая
   запись (панель открыли по ссылке или из бота): «Назад» из неё — к разделу, а не прочь */
interface HistoryState {
  readonly idx?: unknown;
}

export function historyIndex(): number {
  const idx = (window.history.state as HistoryState | null)?.idx;
  return typeof idx === "number" && idx > 0 ? idx : 0;
}

const isLoginPath = (pathname: string) => {
  const route = matchRoute(pathname);
  return route === "login" || route === "authCallback";
};

export type Navigate = (view: View, options?: { readonly replace?: boolean }) => void;

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

  const navigate = useCallback<Navigate>((view, options) => {
    const next = pathOf(view);
    if (options?.replace) window.history.replaceState({ idx: historyIndex() }, "", next);
    else if (window.location.pathname !== next)
      window.history.pushState({ idx: historyIndex() + 1 }, "", next);
    setPath(next);
  }, []);

  return [isLoginPath(path) ? { name: HOME } : parseView(path), navigate] as const;
}

/**
 * «Назад» экрана объекта: по истории, если в панели уже переходили (как кнопка браузера),
 * иначе — к родительскому экрану вместо записи истории
 */
export function goBack(view: View | null, navigate: Navigate): void {
  if (historyIndex() > 0) {
    window.history.back();
    return;
  }
  navigate(view ? parentOf(view) : { name: HOME }, { replace: true });
}
