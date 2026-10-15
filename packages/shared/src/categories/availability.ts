/* Части дня (модель занятости parts): окна по умолчанию, «Время работы» витрины и занятость
   дня. Одни и те же правила у сервера (app.listing_busy, app.catalog_day_load — SQL), у демо-API
   клиента и в календарях кабинета и панели:

     · витрина работает в части дня: в режиме parts — в своих частях (day_parts), каждая со своим
       окном (свои окна витрины или окна категории); в режиме whole — одно мероприятие в день;
     · часть занята — отметкой части, отметкой всего дня или договорённостями (заявки deal) на неё
       не меньше, чем заказов одновременно (parallelCapacity). Заявка на весь день (без частей) и
       любая заявка витрины в режиме whole — в каждой части; в режиме whole любая занятая часть
       занимает весь день;
     · день: busy — заняты все рабочие части, partial — часть из них, free — ни одной. */

import {
  type CategoryConfig,
  DAY_PARTS,
  type DayPart,
  type DayPartWindow,
  type DayPartWindows,
  type DaySessions,
} from "./types";

/**
 * Окна частей дня по умолчанию, по Ташкенту: утро — нахорги ош, день — ЗАГС и фотосессия,
 * вечер — свадьба. У категории бывают свои (зал, студия), у витрины — свои поверх них
 */
export const DEFAULT_DAY_PARTS: DayPartWindows = {
  morning: { from: "05:00", to: "11:00" },
  day: { from: "11:00", to: "17:00" },
  evening: { from: "17:00", to: "24:00" },
};

/** Минуты от полуночи для «ЧЧ:ММ» («24:00» — 1440) */
export function toMinutes(time: string): number {
  const [h = "0", m = "0"] = time.split(":");
  return Number(h) * 60 + Number(m);
}

/** Окна частей дня категории — по умолчанию для её витрин */
export function dayPartWindows(category: CategoryConfig): DayPartWindows {
  return category.dayParts ?? DEFAULT_DAY_PARTS;
}

/** Окна витрины: свои (custom) поверх окон категории */
export function effectiveWindows(
  category: CategoryConfig,
  custom: Partial<DayPartWindows> | null | undefined,
): DayPartWindows {
  const base = dayPartWindows(category);
  if (!custom) return base;
  return {
    morning: custom.morning ?? base.morning,
    day: custom.day ?? base.day,
    evening: custom.evening ?? base.evening,
  };
}

/** Окно строкой: «06:00–11:00» */
export const windowText = (window: DayPartWindow): string => `${window.from}–${window.to}`;

/** Время «ЧЧ:ММ» внутри окна [from, to) */
export function inWindow(window: DayPartWindow, time: string): boolean {
  const at = toMinutes(time);
  return at >= toMinutes(window.from) && at < toMinutes(window.to);
}

/** Часть дня, в окно которой попадает время, из этих частей (по умолчанию — всех); нет — null */
export function dayPartOf(
  windows: DayPartWindows,
  time: string,
  parts: readonly DayPart[] = DAY_PARTS,
): DayPart | null {
  return parts.find((part) => inWindow(windows[part], time)) ?? null;
}

/** Есть ли у категории календарь по частям дня (модель parts); у lead — срок заказа */
export function hasDayParts(category: CategoryConfig): boolean {
  return category.availability === "parts";
}

/** Части по порядку DAY_PARTS, без повторов */
export const sortParts = (parts: Iterable<DayPart>): DayPart[] => {
  const set = new Set(parts);
  return DAY_PARTS.filter((part) => set.has(part));
};

/** «Время работы» по умолчанию: несколько мероприятий в день, все части, окна категории */
export function defaultDaySessions(category: CategoryConfig): DaySessions {
  return {
    mode: "parts",
    parts: [...DAY_PARTS],
    windows: dayPartWindows(category),
    custom: null,
    parallelCapacity: 1,
  };
}

/** Части, которые можно выбрать в заявке: в режиме whole — ни одной (заявка на весь день) */
export const choosableParts = (sessions: Pick<DaySessions, "mode" | "parts">): readonly DayPart[] =>
  sessions.mode === "whole" ? [] : sessions.parts;

// ── занятость дня ───────────────────────────────────────────────────────────

/** Что известно о дне витрины: отметки и договорённости */
export interface DayMarks {
  /** День отмечен занятым целиком */
  readonly whole: boolean;
  /** Отмеченные занятыми части */
  readonly marked: readonly DayPart[];
  /**
   * Договорённостей (deal) по частям. Заявка на весь день и заявки витрины в режиме whole —
   * в каждой части (так считает и сервер)
   */
  readonly booked: Readonly<Partial<Record<DayPart, number>>>;
}

export const FREE_DAY: DayMarks = { whole: false, marked: [], booked: {} };

export interface PartLoad {
  readonly part: DayPart;
  readonly marked: boolean;
  readonly booked: number;
  /** Мест не осталось: договорённостей не меньше, чем заказов одновременно */
  readonly full: boolean;
  readonly busy: boolean;
}

export type DayLoad = "free" | "partial" | "busy";

type SessionsCore = Pick<DaySessions, "mode" | "parts" | "parallelCapacity">;

/** Части дня витрины (все три, по порядку): отмечена ли, сколько договорённостей, занята ли */
export function partLoads(sessions: SessionsCore, day: DayMarks): PartLoad[] {
  const capacity = Math.max(1, sessions.parallelCapacity);
  const rows = DAY_PARTS.map((part) => {
    const booked = day.booked[part] ?? 0;
    const marked = day.marked.includes(part);
    const full = booked >= capacity;
    return { part, marked, booked, full, busy: day.whole || marked || full };
  });
  // Одно мероприятие в день: занятая часть — весь день
  if (sessions.mode === "whole" && rows.some((r) => r.busy)) return rows.map((r) => ({ ...r, busy: true }));
  return rows;
}

/** Занятые рабочие части дня */
export function busyParts(sessions: SessionsCore, day: DayMarks): DayPart[] {
  return partLoads(sessions, day)
    .filter((p) => p.busy && sessions.parts.includes(p.part))
    .map((p) => p.part);
}

/** Загрузка дня по рабочим частям витрины */
export function dayLoadOf(sessions: SessionsCore, day: DayMarks): DayLoad {
  const busy = busyParts(sessions, day).length;
  if (busy === 0) return "free";
  return busy >= sessions.parts.length ? "busy" : "partial";
}

/**
 * Свободна ли витрина в часть дня (фильтр каталога «Время»): whole — весь день свободен;
 * часть — витрина в ней работает (в режиме whole — в любой) и она не занята
 */
export function freeIn(sessions: SessionsCore, day: DayMarks, part: DayPart | "whole"): boolean {
  if (part === "whole") return dayLoadOf(sessions, day) === "free";
  if (sessions.mode === "whole") return dayLoadOf(sessions, day) === "free";
  if (!sessions.parts.includes(part)) return false;
  return !busyParts(sessions, day).includes(part);
}
