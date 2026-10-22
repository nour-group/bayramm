import { trimTrailingSlashes } from "@bayramm/shared";
import { historyBack, pushScreen } from "@bayramm/ui/react";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { tashkentToday } from "./format";

/* Все экраны кабинета — в одной карте. Пути, вписанные по месту, разъезжаются
   (ловушка №9 в CLAUDE.md). :id — единственный параметр пути, UUID заявки. Параметры адреса:
   календарь — ?listing=<витрина>&day=YYYY-MM-DD&from=<заявка> (открыть день: из заявки «Открыть
   день»; день вне календаря — от сегодня до горизонта — отбрасывается; from — куда «Назад»),
   витрина — ?focus=sessions|attributes (к блоку: из календаря «Изменить» и «Изменить срок»). */
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

/** Блоки витрины, к которым ведёт ссылка: время работы, данные витрины (срок заказа) */
export const VENUE_FOCUS = ["sessions", "attributes"] as const;
export type VenueFocus = (typeof VENUE_FOCUS)[number];

export interface Location {
  readonly route: Route;
  /** id заявки для route = request */
  readonly id?: string;
  /** Календарь: эта витрина (иначе — выбранная в кабинете) */
  readonly listing?: string;
  /** Календарь: открыть этот день, "YYYY-MM-DD" */
  readonly day?: string;
  /** Календарь: открыт из этой заявки — «Назад» Telegram ведёт к ней */
  readonly from?: string;
  /** Витрина: к этому блоку */
  readonly focus?: VenueFocus;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** Сколько дней вперёд открыт календарь — как у API (CALENDAR_HORIZON_DAYS) */
export const CALENDAR_HORIZON_DAYS = 730;

/** Настоящая дата от сегодня (по Ташкенту) до горизонта календаря: иначе день из адреса не открываем */
export function dayInCalendar(day: string, now: number = Date.now()): boolean {
  if (!DAY_RE.test(day)) return false;
  const time = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== day) return false;
  const today = tashkentToday(now);
  const last = new Date(Date.parse(`${today}T00:00:00Z`) + CALENDAR_HORIZON_DAYS * DAY_MS).toISOString();
  return day >= today && day <= last.slice(0, 10);
}

/** Путь экрана с параметрами адреса */
export function pathOf(location: Location): string {
  if (location.route === "request") return ROUTES.request.replace(":id", location.id ?? "");
  const query = new URLSearchParams();
  if (location.route === "calendar") {
    if (location.listing) query.set("listing", location.listing);
    if (location.day) query.set("day", location.day);
    if (location.from) query.set("from", location.from);
  }
  if (location.route === "card" && location.focus) query.set("focus", location.focus);
  const search = query.toString();
  return search ? `${ROUTES[location.route]}?${search}` : ROUTES[location.route];
}

/** Экран по пути (и параметрам адреса). Корень — главный экран, неизвестный путь — null */
export function matchRoute(pathname: string, search = ""): Location | null {
  const path = trimTrailingSlashes(pathname) || "/";
  if (path === "/") return { route: HOME };
  const request = /^\/requests\/([^/]+)$/.exec(path);
  if (request?.[1] !== undefined) {
    return UUID_RE.test(request[1]) ? { route: "request", id: request[1].toLowerCase() } : null;
  }
  const route = (Object.keys(ROUTES) as Route[]).find((key) => key !== "request" && ROUTES[key] === path);
  if (!route) return null;
  const query = new URLSearchParams(search);
  if (route === "calendar") {
    const listing = query.get("listing");
    const day = query.get("day");
    const from = query.get("from");
    return {
      route,
      ...(listing && UUID_RE.test(listing) ? { listing: listing.toLowerCase() } : {}),
      ...(day && dayInCalendar(day) ? { day } : {}),
      ...(from && UUID_RE.test(from) ? { from: from.toLowerCase() } : {}),
    };
  }
  if (route === "card") {
    const focus = VENUE_FOCUS.find((f) => f === query.get("focus"));
    return focus ? { route, focus } : { route };
  }
  return { route };
}

/** Адрес окна сейчас: путь и параметры — экран зависит от обоих */
const here = () => `${window.location.pathname}${window.location.search}`;

const split = (url: string): readonly [string, string] => {
  const at = url.indexOf("?");
  return at < 0 ? [url, ""] : [url.slice(0, at), url.slice(at)];
};

export type Navigate = (
  location: Location,
  options?: {
    readonly replace?: boolean;
    /** Без вопроса о несохранённом: форма только что отправилась и сама уводит дальше */
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
 * несохранёнными правками сначала спрашивает: и переход по ссылке, и «назад» браузера или
 * Telegram (адрес экрана возвращается в историю, «Уйти» — снова назад)
 */
export function useRoute(guard?: RefObject<LeaveGuard | null>): readonly [Location | null, Navigate] {
  const [path, setPath] = useState(here);
  // «Уйти» после вопроса: следующий popstate — тот самый уход, не держать
  const passing = useRef(false);

  useEffect(() => {
    // Корень показывает главный экран; в адресе оставляем его настоящий путь
    if (window.location.pathname === "/") {
      const { search, hash } = window.location;
      window.history.replaceState(null, "", `${ROUTES[HOME]}${search}${hash}`);
      setPath(`${ROUTES[HOME]}${search}`);
    }
    const onPop = () => {
      const held = passing.current ? null : (guard?.current?.holding() ?? null);
      passing.current = false;
      if (held && guard?.current) {
        // Браузер уже ушёл: вернуть экран с правками новой записью поверх той, куда ушли
        window.history.pushState(held.state, "", held.url);
        guard.current.ask(() => {
          passing.current = true;
          // Мимо записи открытого вопроса «Уйти без сохранения?»
          historyBack();
        });
        return;
      }
      setPath(here());
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [guard]);

  const navigate = useCallback<Navigate>(
    (location, options) => {
      const next = pathOf(location);
      const go = () => {
        if (here() !== next) {
          // hash (#tgWebAppData=…) не переносим: он нужен SDK только при первом открытии
          if (options?.replace) window.history.replaceState(null, "", next);
          // Ссылка в открытой шторке — новый экран на месте записи шторки (@bayramm/ui/react)
          else pushScreen(null, next);
        }
        setPath(next);
      };
      // Тот же экран — никуда не уходим, спрашивать не о чем
      const held = options?.force || next === here() ? null : guard?.current?.holding();
      if (held && guard?.current) guard.current.ask(go);
      else go();
    },
    [guard],
  );

  const [pathname, search] = split(path);
  return [matchRoute(pathname, search), navigate] as const;
}
