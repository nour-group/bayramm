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

/**
 * Разделы в навигации, по порядку: сначала ежедневные — в том же порядке, что кнопки нижней
 * панели телефона (TAB_SECTIONS), потом уведомления, журнал, команда и настройки. Один порядок
 * на компьютере, планшете и телефоне: раздел не переезжает, когда меняется ширина окна
 */
export const NAV = [
  "requests",
  "moderation",
  "vendors",
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

/** Главный экран, пока разделы роли не известны (проверка адреса возврата после входа) */
export const HOME: Section = "requests";

/**
 * Нижняя панель телефона — только разделы, в которые заходят с телефона каждый день, по
 * частоте. Их названия целиком влезают в кнопку и на 320px (сокращений в панели нет).
 * Остальные — очередь уведомлений, журнал, команда, настройки — всегда в «Ещё»: «Уведомления»
 * в кнопку пятой части экрана не помещаются
 */
export const TAB_SECTIONS: readonly Section[] = ["requests", "moderation", "vendors", "metrics", "clients"];

export const TAB_SLOTS = 5;

/**
 * Главный экран роли: сюда ведёт корень сайта и сюда попадают после входа — первый раздел
 * нижней панели, который роли доступен (администратор и менеджер — «Заявки», модератор —
 * «Модерация»: заявок он не видит)
 */
export function homeOf(sections: readonly Section[]): Section {
  return TAB_SECTIONS.find((section) => sections.includes(section)) ?? sections[0] ?? HOME;
}

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

/**
 * Параметры адреса экрана (?sla=late, ?q=V101, ?focus=photos): ссылка ведёт сразу на
 * отфильтрованный список или к блоку страницы. Пустые значения в адрес не попадают
 */
export type Query = Readonly<Record<string, string>>;

interface WithQuery {
  readonly query?: Query;
}

export type View =
  | ({ readonly name: Section } & WithQuery)
  | ({ readonly name: "vendorNew" } & WithQuery)
  | ({ readonly name: "vendor"; readonly id: string } & WithQuery)
  | ({ readonly name: "listingNew"; readonly vendorId: string } & WithQuery)
  | ({ readonly name: "listing"; readonly id: string } & WithQuery)
  | ({ readonly name: "request"; readonly id: string } & WithQuery)
  | ({ readonly name: "client"; readonly id: string } & WithQuery)
  | ({ readonly name: "revision"; readonly id: string } & WithQuery);

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

/** Путь экрана без параметров — обратное к parseView */
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

/** Адрес экрана с параметрами: /requests?sla=late */
export function hrefOf(view: View): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(view.query ?? {})) if (value !== "") params.set(key, value);
  const search = params.toString();
  return search ? `${pathOf(view)}?${search}` : pathOf(view);
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
   запись (панель открыли по ссылке или из бота): «Назад» из неё — к разделу, а не прочь.
   scroll — где была прокрутка, когда с экрана ушли: «назад» возвращает список на то же место */
interface HistoryState {
  readonly idx?: unknown;
  readonly scroll?: unknown;
}

const historyState = (): HistoryState | null => window.history.state as HistoryState | null;

export function historyIndex(): number {
  const idx = historyState()?.idx;
  return typeof idx === "number" && idx > 0 ? idx : 0;
}

/** Прокрутка, запомненная у текущей записи истории; нет — null */
export function savedScroll(): number | null {
  const scroll = historyState()?.scroll;
  return typeof scroll === "number" && scroll > 0 ? scroll : null;
}

/** Адрес в адресной строке без хоста: путь и параметры */
const currentHref = () => `${window.location.pathname}${window.location.search}`;

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
 * Каким переходом открыт экран: seq — номер перехода (новый экран, даже если путь тот же, а
 * параметры другие: «Заявки» → «Заявки ?sla=late»), back — пришли «назад» или «вперёд»
 * браузера: прокрутку запомненной записи вернуть
 */
export interface Arrival {
  readonly seq: number;
  readonly back: boolean;
}

/**
 * Текущий экран по адресной строке и переход без перезагрузки. guard — уход с экрана с
 * несохранёнными правками сначала спрашивает: и переход по ссылке, и «назад» браузера
 * или Telegram (адрес экрана возвращается в историю, «Уйти» — снова назад). home — главный
 * экран роли: на него ведут корень и страницы входа
 */
export function useRoute(
  guard?: RefObject<LeaveGuard | null>,
  home: Section = HOME,
): readonly [View | null, Navigate, Arrival] {
  // Корень и страницы входа у вошедшего — сразу главный экран: без лишней первой отрисовки
  // чужого раздела (и его запроса к API)
  const [route, setRoute] = useState(() => {
    const { pathname } = window.location;
    const path = pathname === "/" || isLoginPath(pathname) ? ROUTES[home] : pathname;
    return { path, seq: 0, back: false };
  });
  // «Уйти» после вопроса: следующий popstate — тот самый уход, не держать
  const passing = useRef(false);

  useEffect(() => {
    // Прокрутку при «назад» возвращает панель сама: список догружается после перехода
    if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual";
    // Корень и страницы входа у вошедшего показывают главный экран; в адресе — его настоящий путь
    const { pathname, search, hash } = window.location;
    if (pathname === "/" || isLoginPath(pathname)) {
      window.history.replaceState(null, "", `${ROUTES[home]}${pathname === "/" ? search + hash : ""}`);
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
      setRoute((prev) => ({ path: window.location.pathname, seq: prev.seq + 1, back: true }));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [guard, home]);

  const navigate = useCallback<Navigate>(
    (view, options) => {
      const next = hrefOf(view);
      const go = () => {
        if (options?.replace) window.history.replaceState({ idx: historyIndex() }, "", next);
        else {
          // Где была прокрутка — у записи, с которой уходим: «назад» вернёт туда же
          window.history.replaceState(
            { ...historyState(), scroll: window.scrollY || 0 },
            "",
            `${currentHref()}${window.location.hash}`,
          );
          window.history.pushState({ idx: historyIndex() + 1 }, "", next);
        }
        setRoute((prev) => ({ path: pathOf(view), seq: prev.seq + 1, back: false }));
      };
      // Тот же экран с теми же параметрами (раздел, где уже стоим) — никуда не уходим
      if (next === currentHref()) return;
      const held = options?.force ? null : guard?.current?.holding();
      if (held && guard?.current) guard.current.ask(go);
      else go();
    },
    [guard],
  );

  const view = isLoginPath(route.path) ? { name: home } : parseView(route.path);
  return [view, navigate, { seq: route.seq, back: route.back }] as const;
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

/**
 * Вернуть прокрутку записи истории, когда страница до неё дорастёт: список после «назад»
 * грузится заново, сразу прокрутить некуда. Ждём не дольше timeout; человек сам крутит или
 * нажимает — перестаём. Возвращает отмену. scrollTo есть не везде (ловушка №5)
 */
export function restoreScroll(y: number, timeout = 3000): () => void {
  if (typeof window.scrollTo !== "function") return () => {};
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const events = ["wheel", "touchstart", "keydown", "mousedown"] as const;
  const stop = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    for (const name of events) window.removeEventListener(name, stop);
  };
  const tick = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    if (max >= y || Date.now() - started >= timeout) {
      window.scrollTo(0, Math.max(0, Math.min(y, max)));
      stop();
      return;
    }
    timer = setTimeout(tick, 50);
  };
  for (const name of events) window.addEventListener(name, stop, { passive: true });
  tick();
  return stop;
}

// ── параметры в адресе ─────────────────────────────────────────────────────

/**
 * Параметры адреса экрана — значения ключей keys (пустые и чужие не берём). Длинное
 * значение обрезается: адрес мог прийти пересланной ссылкой
 */
export function readQuery<K extends string>(keys: readonly K[], search = window.location.search) {
  const params = new URLSearchParams(search);
  const values: Partial<Record<K, string>> = {};
  for (const key of keys) {
    const value = params.get(key)?.trim();
    if (value) values[key] = value.slice(0, 100);
  }
  return values;
}

/**
 * Записать параметры в адрес без новой записи истории (replaceState): номер записи и
 * прокрутка в history.state нужны «назад» панели. Чужие параметры адреса остаются. path —
 * экран, для которого пишем: ушли с него (поиск дописался с задержкой) — адрес не трогаем
 */
export function writeQuery<K extends string>(
  keys: readonly K[],
  values: Partial<Record<K, string>>,
  path: string = window.location.pathname,
): void {
  if (window.location.pathname !== path) return;
  const params = new URLSearchParams(window.location.search);
  for (const key of keys) {
    const value = values[key];
    if (value) params.set(key, value);
    else params.delete(key);
  }
  const search = params.toString();
  const next = `${path}${search ? `?${search}` : ""}`;
  if (next !== currentHref())
    window.history.replaceState(window.history.state, "", `${next}${window.location.hash}`);
}

export type QueryPatch<K extends string> = Partial<Record<K, string | null>>;

/**
 * Фильтры раздела в адресе страницы (?q=&status=&page=): ссылку можно переслать, а «назад»
 * из объекта возвращает список с теми же фильтрами. Начальные значения — из адреса при
 * открытии экрана; set — поменять часть ключей (null и "" — убрать)
 */
export function useQueryState<K extends string>(
  keys: readonly K[],
): readonly [Readonly<Partial<Record<K, string>>>, (patch: QueryPatch<K>) => void] {
  const [path] = useState(() => window.location.pathname);
  const [values, setValues] = useState(() => readQuery(keys));
  const current = useRef(values);
  const allowed = useRef(keys);
  const set = useCallback(
    (patch: QueryPatch<K>) => {
      const next: Partial<Record<K, string>> = { ...current.current };
      for (const key of Object.keys(patch) as K[]) {
        if (!allowed.current.includes(key)) continue;
        const value = patch[key];
        if (value) next[key] = value;
        else delete next[key];
      }
      current.current = next;
      writeQuery(allowed.current, next, path);
      setValues(next);
    },
    [path],
  );
  return [values, set] as const;
}
