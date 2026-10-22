/* Занятость дня глазами кабинета — по тем же правилам, что каталог и сервер (partLoads,
   dayLoadOf из @bayramm/shared/categories): календарь (месяц и открытый день) и карточка заявки
   («на эту дату: занято 1 из 2 мест»). Без React — его берут оба экрана. */

import type {
  BusyDay,
  BusyPart,
  CalendarRequest,
  DayPart,
  VendorCalendar,
  VendorRequestDay,
} from "@bayramm/shared/api/vendor";
import {
  DAY_PARTS,
  type DayLoad,
  type DayMarks,
  DEFAULT_DAY_PARTS,
  dayLoadOf,
  type PartLoad,
  partLoads,
} from "@bayramm/shared/categories";
import { partName } from "./category";
import { fill, type VendorDict } from "./i18n";

/**
 * Ответ без времени работы и заявок дня (старый API во время выкладки) — как у витрины по
 * умолчанию: несколько мероприятий, все части, окна по умолчанию
 */
export function withDefaults(calendar: VendorCalendar): VendorCalendar {
  return {
    ...calendar,
    sessions: calendar.sessions ?? {
      mode: "parts",
      parts: [...DAY_PARTS],
      windows: DEFAULT_DAY_PARTS,
      custom: null,
      parallelCapacity: calendar.parallelCapacity ?? 1,
    },
    requests: calendar.requests ?? [],
    parts: calendar.parts ?? [],
    bookings: calendar.bookings ?? [],
  };
}

/** Что нужно о дне: месяц календаря или день заявки (eventDay карточки заявки) */
export type DayCalendar = Pick<VendorCalendar, "sessions" | "busy" | "parts" | "bookings" | "requests">;

/** Отметки и договорённости дня — для правил занятости из @bayramm/shared/categories */
export function marksOf(calendar: DayCalendar, day: string): DayMarks {
  const booked: Partial<Record<DayPart, number>> = {};
  for (const b of calendar.bookings) if (b.day === day) booked[b.part] = b.count;
  return {
    whole: calendar.busy.some((b) => b.day === day),
    marked: calendar.parts.filter((p) => p.day === day).map((p) => p.part),
    booked,
  };
}

export interface DayView {
  /** Отметка дня целиком */
  readonly entry: BusyDay | undefined;
  /** Рабочие части (у одного мероприятия в день — пусто): что занято и сколько договорённостей */
  readonly parts: readonly (PartLoad & { readonly mark: BusyPart | undefined })[];
  readonly load: DayLoad;
  readonly requests: readonly CalendarRequest[];
}

/** День глазами календаря: по тем же правилам, что каталог и сервер */
export function dayView(calendar: DayCalendar, day: string): DayView {
  const marks = marksOf(calendar, day);
  const { sessions } = calendar;
  const parts =
    sessions.mode === "whole"
      ? []
      : partLoads(sessions, marks)
          .filter((p) => sessions.parts.includes(p.part))
          .map((p) => ({ ...p, mark: calendar.parts.find((m) => m.day === day && m.part === p.part) }));
  return {
    entry: calendar.busy.find((b) => b.day === day),
    parts,
    load: dayLoadOf(sessions, marks),
    requests: calendar.requests.filter((r) => r.day === day),
  };
}

/** «Занято 1 из 2 мест» */
export function seatsText(t: VendorDict, booked: number, capacity: number): string {
  return fill(t.partSeats, { n: booked, cap: capacity, seats: capacity === 1 ? t.seatsOne : t.seatsMany });
}

/** Отметка дня или части словами: кем закрыто */
export function markText(t: VendorDict, source: BusyDay["source"]): string {
  return source === "staff" ? t.legendStaff : source === "request_decline" ? t.dayDeclined : t.partBusy;
}

/** Состояние части: закрыта (кем), все места заняты, «занято N из M мест», свободна */
export function partStateText(
  t: VendorDict,
  info: DayView["parts"][number],
  capacity: number,
  dayBusy: boolean,
): string {
  if (dayBusy) return t.partCovered;
  if (info.mark) return markText(t, info.mark.source);
  if (info.booked > 0) return seatsText(t, info.booked, capacity);
  return t.partFree;
}

/** «Весь день»: занят (кем), частично занят (и когда есть договорённость, а места остались), свободен */
export function wholeStateText(t: VendorDict, view: DayView): string {
  if (view.entry) return markText(t, view.entry.source);
  if (view.load === "busy") return t.partBusy;
  if (view.load === "partial" || view.parts.some((p) => p.booked > 0)) return t.wholePartial;
  return t.partFree;
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** Занятость даты заявки одной строкой и тоном плашки */
export interface RequestDayState {
  readonly tone: DayLoad;
  readonly text: string;
}

/**
 * Дата заявки в календаре: «свободно», «вечер — занято 1 из 2 мест», «занято». Заявка на части
 * дня — только её рабочие части; на весь день (или витрина с одним мероприятием) — весь день
 */
export function requestDayState(
  day: VendorRequestDay,
  date: string,
  asked: readonly DayPart[],
  t: VendorDict,
): RequestDayState {
  const view = dayView(
    {
      sessions: day.sessions,
      busy: day.busy ? [day.busy] : [],
      parts: day.parts,
      bookings: day.bookings,
      requests: [],
    },
    date,
  );
  const capacity = day.sessions.parallelCapacity;
  const own = view.parts.filter((p) => asked.includes(p.part));
  if (!view.entry && own.length > 0) {
    const tone: DayLoad = own.some((p) => p.busy)
      ? "busy"
      : own.some((p) => p.booked > 0)
        ? "partial"
        : "free";
    const text = own
      .map((p) =>
        fill(t.partState, {
          part: partName(t, p.part).toLowerCase(),
          state: lowerFirst(partStateText(t, p, capacity, false)),
        }),
      )
      .join(", ");
    return { tone, text };
  }
  // Весь день: занят, частично (или есть договорённость, а места остались), свободен
  const booked = Math.max(0, ...day.bookings.map((b) => b.count));
  if (!view.entry && view.load !== "busy" && view.parts.length === 0 && booked > 0) {
    return { tone: "partial", text: lowerFirst(seatsText(t, booked, capacity)) };
  }
  const tone: DayLoad = view.entry
    ? "busy"
    : view.load === "free" && view.parts.some((p) => p.booked > 0)
      ? "partial"
      : view.load;
  return { tone, text: wholeStateText(t, view) };
}
