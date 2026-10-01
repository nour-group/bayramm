import { trimTrailingSlashes } from "@bayramm/shared";
import type { StaffPermission } from "@bayramm/shared/api/staff";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

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
 * Нижняя панель телефона — только разделы, в которые заходят с телефона каждый день, по
 * частоте. Их названия целиком влезают в кнопку и на 320px (сокращений в панели нет).
 * Остальные — очередь уведомлений, журнал, команда, настройки — всегда в «Ещё»: «Уведомления»
 * в кнопку пятой части экрана не помещаются
 */
export const TAB_SECTIONS: readonly Section[] = ["requests", "moderation", "vendors", "metrics", "clients"];

export const TAB_SLOTS = 5;

/**
 * Разделы роли → кнопки нижней панели и «Ещё» (в порядке NAV). Всё влезает — кнопками без
 * «Ещё»; иначе четыре частых кнопками, остальное — в «Ещё»
 */
export function tabsFor(
  sections: readonly Section[],
  slots = TAB_SLOTS,
): { readonly tabs: readonly Section[]; readonly more: readonly Section[] } {
  const daily = TAB_SECTIONS.filter((section) => sections.includes(section));
  const rest = NAV.filter((section) => sections.includes(section) && !daily.includes(section));
  if (rest.length === 0 && daily.length <= slots) return { tabs: daily, more: [] };
  const tabs = daily.slice(0, slots - 1);
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

export type Navigate = (
  view: View,
  options?: {
    readonly replace?: boolean;
    /** Без вопроса о несохранённом: форма только что сохранилась и сама уводит на результат */
    readonly force?: boolean;
  },
) => void;

/**
 * Что держит уход с экрана: несохранённые правки (unsaved.tsx). holding — есть что терять:
 * адрес и запись истории экрана с правками; ask — спросить, leave — уйти
 */
export interface LeaveGuard {
  readonly holding: () => { readonly url: string; readonly state: unknown } | null;
  readonly ask: (leave: () => void) => void;
}

/**
 * Текущий экран по адресной строке и переход без перезагрузки. guard — уход с экрана с
 * несохранёнными правками сначала спрашивает: и переход по ссылке, и «назад» браузера
 * или Telegram (адрес экрана возвращается в историю, «Уйти» — снова назад)
 */
export function useRoute(guard?: RefObject<LeaveGuard | null>): readonly [View | null, Navigate] {
  const [path, setPath] = useState(() => window.location.pathname);
  // «Уйти» после вопроса: следующий popstate — тот самый уход, не держать
  const passing = useRef(false);

  useEffect(() => {
    // Корень и страницы входа у вошедшего показывают главный экран; в адресе — его настоящий путь
    const { pathname, search, hash } = window.location;
    if (pathname === "/" || isLoginPath(pathname)) {
      window.history.replaceState(null, "", `${ROUTES[HOME]}${pathname === "/" ? search + hash : ""}`);
      setPath(ROUTES[HOME]);
    }
    const onPop = () => {
      const held = passing.current ? null : (guard?.current?.holding() ?? null);
      passing.current = false;
      if (held && guard?.current) {
        // Браузер уже ушёл: вернуть экран с правками новой записью поверх той, куда ушли
        window.history.pushState(held.state, "", held.url);
        guard.current.ask(() => {
          passing.current = true;
          window.history.back();
        });
        return;
      }
      setPath(window.location.pathname);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [guard]);

  const navigate = useCallback<Navigate>(
    (view, options) => {
      const next = pathOf(view);
      const go = () => {
        if (options?.replace) window.history.replaceState({ idx: historyIndex() }, "", next);
        else if (window.location.pathname !== next)
          window.history.pushState({ idx: historyIndex() + 1 }, "", next);
        setPath(next);
      };
      // Тот же экран (раздел, где уже стоим) — никуда не уходим, спрашивать не о чем
      const held = options?.force || next === window.location.pathname ? null : guard?.current?.holding();
      if (held && guard?.current) guard.current.ask(go);
      else go();
    },
    [guard],
  );

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
