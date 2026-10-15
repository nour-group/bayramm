/* Календарь занятости витрины. У категорий с календарём день делится на утро, день и вечер;
   как витрина работает — «Время работы» (раздел «Витрина»): одно мероприятие в день (whole) или
   несколько — в своих частях дня, со своими окнами и числом заказов одновременно. Здесь —
   строка с ним и (владельцу) ссылка туда, где оно меняется.

     · месяц: у каждого дня — три маленькие отметки рабочих частей (свободна, есть договорённость,
       занята); весь день занят — подложка «занято»; есть заявка — точка; сегодня — своя точка;
     · нажатие на день открывает его: на телефоне и планшете — шторка, на компьютере — колонка
       справа от месяца. Там «Весь день» (закрыть или открыть день целиком) и рабочие части —
       окно, «занято N из M мест», заявки на эту часть (ссылки) и переключатель «занято». У одного
       мероприятия в день частей нет — только день целиком;
     · «Несколько дней»: первое нажатие — начало, второе — конец (как в панели оператора), дни
       недели — только эти (все вечера суббот месяца), что — весь день или часть; «Закрыть» и
       «Открыть» — одной правкой. «Открыть» больше одного дня — через подтверждение; отметки
       менеджера остаются;
     · lead (цветы, торты, подарки) — календаря нет: одно предложение про срок «заказ не позже
       чем за N дней» из поля витрины и одна ссылка туда, где он меняется (владельцу).

   Над месяцем — одна строка, как закрыть день или часть. «Обозначения» — только то, что есть в
   показанном месяце; открыты, пока партнёр их не свернёт (помнит вкладка — sessionStorage).

   Отметка сразу видна на экране и уходит в API; не сохранилось — возвращается как было. Дни,
   занятые отказом «занято», вендор может освободить; закрытые менеджером — нет. Прошедшие дни
   не меняются. «Сегодня» и границы — по Ташкенту, их отдаёт сервер.

   Календарь ведут несколько человек: партнёр, его коллеги, менеджер, а отказ «занято» занимает
   дату сам. Каждая правка несёт версию календаря, которую видел человек (If-Match); правки
   уходят по очереди, каждая — от версии из прошлого ответа. Кто-то успел изменить календарь
   раньше (409 calendar_conflict) — месяц перечитывается, человек видит, что его изменили, и
   отмечает заново: чужая правка молча не затирается.

   Подпись дня для диктора называет всё, что видно глазами: занят ли (и какие части), кем
   (отказ «занято», менеджер), есть ли заявка, сегодня ли. */

import type {
  BusyDay,
  BusyPart,
  CalendarRequest,
  DayPart,
  VendorCalendar,
  VendorCalendarBatch,
  VendorCalendarBatchResult,
  VendorListing,
  VendorListingRef,
  VendorRole,
} from "@bayramm/shared/api/vendor";
import {
  DAY_PARTS,
  type DayLoad,
  type DayMarks,
  DEFAULT_DAY_PARTS,
  dayLoadOf,
  type PartLoad,
  partLoads,
  windowText,
} from "@bayramm/shared/categories";
import { ConfirmSheet, Dialog, Switch } from "@bayramm/ui/react";
import { type MouseEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ApiFailure, api } from "./api";
import { availabilityOf, partName } from "./category";
import { Disclosure } from "./Disclosure";
import { errorText } from "./errors";
import { formatDate, tashkentToday, weekdayIndex } from "./format";
import { fill, textOf, type VendorDict } from "./i18n";
import { Icon } from "./icons";
import { ListingPicker } from "./ListingPicker";
import { useLayout } from "./layout";
import { type Location, type Navigate, pathOf } from "./router";
import { Empty, Heading, LoadError, Loading, type ScreenProps } from "./ui";
import { useLoad } from "./useLoad";

/** "2026-10" ± n месяцев */
export function shiftMonth(month: string, delta: number): string {
  const [year, mon] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year ?? 2000, (mon ?? 1) - 1 + delta, 1));
  return date.toISOString().slice(0, 7);
}

function daysOf(month: string): string[] {
  const [year, mon] = month.split("-").map(Number);
  const last = new Date(Date.UTC(year ?? 2000, mon ?? 1, 0)).getUTCDate();
  return Array.from({ length: last }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}

const DAY_MS = 86_400_000;
const addDay = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

// ── день ───────────────────────────────────────────────────────────────────

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

/** Отметки и договорённости дня — для правил занятости из @bayramm/shared/categories */
export function marksOf(calendar: VendorCalendar, day: string): DayMarks {
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
export function dayView(calendar: VendorCalendar, day: string): DayView {
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
function markText(t: VendorDict, source: BusyDay["source"]): string {
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

/** «Весь день»: занят (кем), частично занят, свободен */
export function wholeStateText(t: VendorDict, view: DayView): string {
  if (view.entry) return markText(t, view.entry.source);
  if (view.load === "busy") return t.partBusy;
  if (view.load === "partial") return t.wholePartial;
  return t.partFree;
}

/** Подпись дня для диктора: дата, загрузка (и части), есть ли заявка, сегодня ли */
export function dayLabel(
  calendar: VendorCalendar,
  day: string,
  extras: { readonly request: boolean; readonly today: boolean },
  t: VendorDict,
): string {
  const view = dayView(calendar, day);
  const date = formatDate(day, t, true);
  const head = view.entry
    ? fill(
        view.entry.source === "request_decline"
          ? t.dayBusyDecline
          : view.entry.source === "staff"
            ? t.dayBusyStaff
            : t.dayBusy,
        { date },
      )
    : view.load === "free" && view.parts.every((p) => p.booked === 0)
      ? fill(t.dayFree, { date })
      : `${date}: ${
          view.parts.length === 0
            ? t.partBusy
            : view.parts
                .map((p) =>
                  fill(t.partState, {
                    part: partName(t, p.part),
                    state: partStateText(t, p, calendar.sessions.parallelCapacity, false),
                  }),
                )
                .join(", ")
        }`;
  const parts = [head];
  if (extras.request) parts.push(t.legendRequest);
  if (extras.today) parts.push(t.legendToday);
  return parts.join(", ");
}

// ── несколько дней ─────────────────────────────────────────────────────────

/** Что закрыть или открыть на нескольких днях: весь день или часть */
export type RangeWhat = "whole" | DayPart;

/**
 * Дни выбора «несколько дней» по порядку (концы — в любом порядке): от today до max, только
 * эти дни недели (0 — понедельник; пусто — все). Не больше 400 — как примет сервер
 */
export function rangeDays(
  a: string,
  b: string,
  bounds: { readonly today: string; readonly max: string },
  weekdays: ReadonlySet<number> = new Set(),
): string[] {
  const [from, to] = a <= b ? [a, b] : [b, a];
  const days: string[] = [];
  for (let day = from; day <= to && days.length < 400; day = addDay(day, 1)) {
    if (day < bounds.today || day > bounds.max) continue;
    if (weekdays.size > 0 && !weekdays.has(weekdayIndex(day))) continue;
    days.push(day);
  }
  return days;
}

/** Тело правки нескольких дней */
export function batchOf(days: readonly string[], what: RangeWhat, close: boolean): VendorCalendarBatch {
  if (what === "whole") return close ? { busy: days } : { free: days };
  const refs = days.map((day) => ({ day, part: what }));
  return close ? { busyParts: refs } : { freeParts: refs };
}

/** Ответ правки нескольких дней — в показанный месяц: на отрезке ответа — как ответил сервер */
export function mergeBatch(calendar: VendorCalendar, result: VendorCalendarBatchResult): VendorCalendar {
  const outside = (item: { day: string }) => item.day < result.from || item.day > result.to;
  const inMonth = (item: { day: string }) => item.day.startsWith(calendar.month);
  return {
    ...calendar,
    busy: [...calendar.busy.filter(outside), ...result.busy.filter(inMonth)],
    parts: [...calendar.parts.filter(outside), ...result.parts.filter(inMonth)],
    bookings: [...calendar.bookings.filter(outside), ...result.bookings.filter(inMonth)],
    version: Math.max(calendar.version, result.version),
  };
}

// ── месяц ──────────────────────────────────────────────────────────────────

interface MonthProps {
  readonly calendar: VendorCalendar;
  readonly t: VendorDict;
  readonly pending: ReadonlySet<string>;
  /** Открытый день */
  readonly opened: string | null;
  /** Выбор нескольких дней: выбранные дни */
  readonly chosen: ReadonlySet<string> | null;
  readonly onDay: (day: string) => void;
}

function MonthGrid({ calendar, t, pending, opened, chosen, onDay }: MonthProps) {
  const requests = new Set(calendar.requestDays);
  const days = daysOf(calendar.month);
  const lead = days[0] ? weekdayIndex(days[0]) : 0;

  return (
    <div className="cal-grid">
      {t.weekdays.map((name, index) => (
        <span key={name} className={`cal-wd${index > 4 ? " cal-we" : ""}`} aria-hidden="true">
          {name}
        </span>
      ))}
      {Array.from({ length: lead }, (_, i) => `pad-${i}`).map((key) => (
        <span key={key} className="cal-pad" aria-hidden="true" />
      ))}
      {days.map((day) => {
        const view = dayView(calendar, day);
        const past = day < calendar.today;
        const beyond = day > calendar.maxDay;
        const locked = view.entry?.source === "staff";
        const today = day === calendar.today;
        const extras = { request: requests.has(day), today };
        const picked = chosen?.has(day) ?? false;
        const classes = [
          "cal-day",
          weekdayIndex(day) > 4 ? "cal-we" : "",
          view.entry ? `cal-busy cal-${view.entry.source}` : view.load === "busy" ? "cal-busy cal-full" : "",
          !view.entry && view.load === "partial" ? "cal-partial" : "",
          today ? "cal-today" : "",
          requests.has(day) ? "cal-req" : "",
          day === opened ? "cal-selected" : "",
          picked ? "cal-chosen" : "",
        ]
          .filter(Boolean)
          .join(" ");
        const label = `${dayLabel(calendar, day, extras, t)}${picked ? `, ${t.rangeInside}` : ""}`;
        return (
          <button
            key={day}
            type="button"
            className={classes}
            aria-pressed={chosen ? picked : day === opened}
            aria-label={label}
            aria-current={today ? "date" : undefined}
            disabled={past || beyond || (chosen === null && pending.has(day))}
            onClick={() => onDay(day)}
          >
            {today ? <span className="cal-today-dot" aria-hidden="true" /> : null}
            <span className="cal-num">{Number(day.slice(8))}</span>
            {locked ? <Icon name="lock" size={12} /> : null}
            {view.parts.length > 0 ? (
              <span className="cal-parts" aria-hidden="true">
                {view.parts.map((p) => (
                  <i key={p.part} className={p.busy ? "is-busy" : p.booked > 0 ? "is-booked" : undefined} />
                ))}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

// ── открытый день ──────────────────────────────────────────────────────────

function RouteLink({
  to,
  navigate,
  className,
  children,
}: {
  to: Location;
  navigate: Navigate;
  className?: string;
  children: ReactNode;
}) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
  };
  return (
    <a className={className} href={pathOf(to)} onClick={onClick}>
      {children}
    </a>
  );
}

function RequestLinks({
  requests,
  t,
  navigate,
}: {
  requests: readonly CalendarRequest[];
  t: VendorDict;
  navigate: Navigate;
}) {
  if (requests.length === 0) return null;
  return (
    <ul className="day-requests">
      {requests.map((r) => (
        <li key={r.id}>
          <RouteLink to={{ route: "request", id: r.id }} navigate={navigate} className="day-request">
            {fill(t.dayRequest, { no: r.publicNo, status: textOf(t, `st_${r.status}`) })}
          </RouteLink>
        </li>
      ))}
    </ul>
  );
}

interface DayPanelProps {
  readonly calendar: VendorCalendar;
  readonly day: string;
  readonly t: VendorDict;
  readonly pending: ReadonlySet<string>;
  readonly navigate: Navigate;
  readonly onToggle: (day: string, part: DayPart | null, entry: BusyDay | BusyPart | undefined) => void;
  /** Заголовок дня — у колонки справа; в шторке его пишет сама шторка */
  readonly titled: boolean;
}

function DayPanel({ calendar, day, t, pending, navigate, onToggle, titled }: DayPanelProps) {
  const view = dayView(calendar, day);
  const locked = day < calendar.today || day > calendar.maxDay;
  const capacity = calendar.sessions.parallelCapacity;
  const wholeRequests = view.requests.filter((r) => r.parts.length === 0 || view.parts.length === 0);
  const wholeKey = day;
  const staffDay = view.entry?.source === "staff";

  return (
    <section className="panel day-panel" aria-labelledby={titled ? "day-panel-title" : undefined}>
      {titled ? (
        <h2 className="section-title" id="day-panel-title" tabIndex={-1}>
          {formatDate(day, t, true)}
        </h2>
      ) : null}
      <div className={view.load === "busy" ? "day-whole is-busy" : "day-whole"}>
        <p className="day-whole-name">
          <strong>{t.wholeDay}</strong>
          <span className="day-part-state">
            {staffDay ? <Icon name="lock" size={12} /> : null}
            {wholeStateText(t, view)}
          </span>
        </p>
        <button
          type="button"
          className={view.entry ? "btn btn-ghost" : "btn btn-dark"}
          disabled={locked || staffDay || pending.has(wholeKey)}
          onClick={() => onToggle(day, null, view.entry)}
        >
          {view.entry ? t.openWholeDay : t.closeWholeDay}
        </button>
        <RequestLinks requests={wholeRequests} t={t} navigate={navigate} />
      </div>
      {view.parts.length > 0 ? (
        <ul className="day-parts">
          {view.parts.map((info) => {
            const key = `${day}/${info.part}`;
            const window = windowText(calendar.sessions.windows[info.part]);
            const blocked = view.entry !== undefined || (!info.mark && info.full);
            return (
              <li key={info.part} className={info.busy ? "day-part is-busy" : "day-part"}>
                <Switch
                  className="day-part-switch"
                  checked={info.busy}
                  disabled={locked || blocked || info.mark?.source === "staff" || pending.has(key)}
                  onChange={() => onToggle(day, info.part, info.mark)}
                >
                  <span className="day-part-name">
                    <strong>
                      {partName(t, info.part)} <span className="day-part-window">{window}</span>
                    </strong>
                    <span className="day-part-state">
                      {info.mark?.source === "staff" ? <Icon name="lock" size={12} /> : null}
                      {partStateText(t, info, capacity, view.entry !== undefined)}
                      {info.mark && info.booked > 0 ? ` · ${seatsText(t, info.booked, capacity)}` : ""}
                    </span>
                  </span>
                </Switch>
                <RequestLinks
                  requests={view.requests.filter((r) => r.parts.includes(info.part))}
                  t={t}
                  navigate={navigate}
                />
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

// ── срок заказа (модель lead) ───────────────────────────────────────────────

function RouteButton({ to, navigate, children }: { to: Location; navigate: Navigate; children: ReactNode }) {
  return (
    <RouteLink to={to} navigate={navigate} className="btn btn-ghost">
      {children}
    </RouteLink>
  );
}

function LeadTime({
  listingId,
  owner,
  t,
  navigate,
}: {
  listingId: string;
  owner: boolean;
  t: VendorDict;
  navigate: Navigate;
}) {
  const [listing, reload] = useLoad<VendorListing>(listingId, (id) => api.listing(id));
  if (listing.state === "loading") return <Loading t={t} kind="card" />;
  if (listing.state === "error") return <LoadError t={t} onRetry={reload} error={listing.error} />;
  const leadDays = listing.data.attributes.lead_days;
  const known = typeof leadDays === "number";
  return (
    <div className="panel lead-panel">
      <p className="lead-days">
        <Icon name="clock" size={20} />
        <span>{known ? fill(t.leadText, { n: leadDays }) : t.leadUnset}</span>
      </p>
      {/* Срок — поле витрины: меняет владелец кабинета; сотруднику площадки ссылка вела бы в тупик */}
      {owner ? (
        <RouteButton to={{ route: "card" }} navigate={navigate}>
          {known ? t.leadEdit : t.leadSet}
        </RouteButton>
      ) : null}
    </div>
  );
}

// ── раздел ─────────────────────────────────────────────────────────────────

type Message = "staff" | "failed" | "conflict" | "skipped";

const MESSAGE_TEXT = {
  staff: "staffLocked",
  failed: "calendarSaveFailed",
  conflict: "calendarConflict",
  skipped: "rangeSkipped",
} as const satisfies Readonly<Record<Message, keyof VendorDict>>;

interface CalendarProps extends ScreenProps {
  readonly listings: readonly VendorListingRef[];
  readonly listingId: string | null;
  readonly onListing: (id: string) => void;
  /** Выбор витрины — в боковой панели (компьютер) */
  readonly inSidebar?: boolean;
  readonly navigate: Navigate;
  /** Срок заказа и время работы (категории без календаря и с ним) меняет владелец кабинета */
  readonly role?: VendorRole;
}

/** Отметка дня целиком в загруженном месяце: busy — занят (как ответил сервер), null — свободен */
function withDay(calendar: VendorCalendar, day: string, busy: BusyDay | null): VendorCalendar {
  const rest = calendar.busy.filter((b) => b.day !== day);
  return { ...calendar, busy: busy ? [...rest, busy] : rest };
}

/** Отметка части дня: busy — занята, null — свободна */
function withPart(
  calendar: VendorCalendar,
  day: string,
  part: DayPart,
  busy: BusyPart | null,
): VendorCalendar {
  const rest = calendar.parts.filter((p) => !(p.day === day && p.part === part));
  return { ...calendar, parts: busy ? [...rest, busy] : rest };
}

function withMark(
  calendar: VendorCalendar,
  day: string,
  part: DayPart | null,
  busy: BusyDay | BusyPart | null,
): VendorCalendar {
  return part === null
    ? withDay(calendar, day, busy as BusyDay | null)
    : withPart(calendar, day, part, busy as BusyPart | null);
}

export function Calendar({
  t,
  lang,
  headingRef,
  listings,
  listingId,
  onListing,
  inSidebar = false,
  navigate,
  role = "owner",
}: CalendarProps) {
  const listing = listings.find((l) => l.id === listingId);
  const header = (
    <>
      <Heading headingRef={headingRef}>{t.calendar}</Heading>
      {listing && listingId ? (
        <ListingPicker
          listings={listings}
          value={listingId}
          onChange={(id) => id && onListing(id)}
          t={t}
          lang={lang}
          inSidebar={inSidebar}
        />
      ) : null}
    </>
  );

  if (!listing || !listingId) {
    return (
      <section className="page" aria-labelledby="page-title">
        {header}
        <Empty icon="calendar" title={t.noListings} text={t.noListingsText} />
      </section>
    );
  }

  if (availabilityOf(listing.categoryCode) === "lead") {
    return (
      <section className="page" aria-labelledby="page-title">
        {header}
        <LeadTime key={listingId} listingId={listingId} owner={role === "owner"} t={t} navigate={navigate} />
      </section>
    );
  }

  return (
    <section className="page page-calendar" aria-labelledby="page-title">
      {header}
      <CalendarMonth t={t} listing={listing} navigate={navigate} owner={role === "owner"} />
    </section>
  );
}

/** Что из обозначений есть в показанном месяце: тем же правилам, что и раскраска дней */
type LegendKey = "busy" | "part" | "decline" | "staff" | "request" | "today";

const LEGEND: Readonly<
  Record<
    LegendKey,
    {
      dot: string;
      text: "legendBusy" | "legendPart" | "legendDecline" | "legendStaff" | "legendRequest" | "legendToday";
    }
  >
> = {
  busy: { dot: "dot-busy", text: "legendBusy" },
  part: { dot: "dot-part", text: "legendPart" },
  decline: { dot: "dot-decline", text: "legendDecline" },
  staff: { dot: "dot-staff", text: "legendStaff" },
  request: { dot: "dot-req", text: "legendRequest" },
  today: { dot: "dot-today", text: "legendToday" },
};

export function legendOf(calendar: VendorCalendar): LegendKey[] {
  const found = new Set<LegendKey>();
  for (const day of daysOf(calendar.month)) {
    const view = dayView(calendar, day);
    const sourceKey = (source: BusyDay["source"]): LegendKey =>
      source === "request_decline" ? "decline" : source === "staff" ? "staff" : "busy";
    if (view.entry) {
      found.add(sourceKey(view.entry.source));
      continue;
    }
    for (const p of view.parts) if (p.mark && p.mark.source !== "vendor") found.add(sourceKey(p.mark.source));
    if (view.load === "busy") found.add("busy");
    else if (view.load === "partial") found.add("part");
  }
  if (calendar.requestDays.some((day) => day.startsWith(calendar.month))) found.add("request");
  if (calendar.today.startsWith(calendar.month)) found.add("today");
  return (Object.keys(LEGEND) as LegendKey[]).filter((key) => found.has(key));
}

// «Обозначения» открыты, пока их не свернули: помнит вкладка (sessionStorage недоступен — открыты)
const LEGEND_KEY = "bayramm.vendor.calendar.legend";

function legendOpenStored(): boolean {
  try {
    return window.sessionStorage.getItem(LEGEND_KEY) !== "closed";
  } catch {
    return true;
  }
}

function storeLegendOpen(open: boolean): void {
  try {
    if (open) window.sessionStorage.removeItem(LEGEND_KEY);
    else window.sessionStorage.setItem(LEGEND_KEY, "closed");
  } catch {
    // без хранилища — только до перезагрузки
  }
}

/** Время работы одной строкой: «утро 06:00–11:00, вечер 18:00–24:00 · заказов одновременно: 2» */
export function sessionsLine(calendar: VendorCalendar, t: VendorDict): string {
  const { sessions } = calendar;
  const when =
    sessions.mode === "whole"
      ? t.sessionsWhole
      : sessions.parts
          .map((p) => `${partName(t, p).toLowerCase()} ${windowText(sessions.windows[p])}`)
          .join(", ");
  return `${when} · ${fill(t.sessionsCapacity, { n: sessions.parallelCapacity })}`;
}

function CalendarMonth({
  t,
  listing,
  navigate,
  owner,
}: {
  t: VendorDict;
  listing: VendorListingRef;
  navigate: Navigate;
  owner: boolean;
}) {
  const listingId = listing.id;
  const layout = useLayout();
  const desktop = layout === "desktop";
  const [month, setMonth] = useState(() => tashkentToday().slice(0, 7));
  const key = `${listingId}/${month}`;
  const [calendar, reload, setCalendar, refresh] = useLoad<VendorCalendar>(key, (k) => {
    const [id = "", m = ""] = k.split("/");
    return api.calendar(id, m);
  });
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState<Message | null>(null);
  // Почему правка не сохранилась (нет связи, прошедший день…): текст по коду ответа API
  const [failure, setFailure] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const dayPanel = useRef<HTMLDivElement>(null);
  // Несколько дней: выбор отрезка, дни недели, что закрыть или открыть
  const [ranging, setRanging] = useState(false);
  const [range, setRange] = useState<{ readonly start: string; readonly end: string | null } | null>(null);
  const [weekdays, setWeekdays] = useState<ReadonlySet<number>>(new Set());
  const [what, setWhat] = useState<RangeWhat>("whole");
  const [freeing, setFreeing] = useState(false);
  const [legendOpen, setLegendOpen] = useState(legendOpenStored);
  // Правки уходят по одной, каждая — от последней известной версии календаря площадки:
  // две правки от одной версии вторая не прошла бы (409), хотя чужих изменений не было
  const queue = useRef<Promise<void>>(Promise.resolve());
  const known = useRef<{ listingId: string; version: number } | null>(null);
  // Растёт, когда календарь перечитан из-за чужой правки: ждущие очереди правки не уходят
  const round = useRef(0);

  // Версия только растёт: ответ чтения, начатого до правки, не откатывает её назад
  const remember = useCallback((listing: string, version: number) => {
    const current = known.current;
    if (current?.listingId === listing && current.version >= version) return;
    known.current = { listingId: listing, version };
  }, []);
  useEffect(() => {
    if (calendar.state === "ready") remember(calendar.data.listingId, calendar.data.version);
  }, [calendar, remember]);
  // Другая витрина — открытый день и выбор нескольких дней не переносятся
  // biome-ignore lint/correctness/useExhaustiveDependencies: сброс — по смене витрины
  useEffect(() => {
    setOpened(null);
    setRanging(false);
    setRange(null);
    setMessage(null);
  }, [listingId]);

  const mark = (id: string, on: boolean) =>
    setPending((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  // День — в том месяце той площадки, что на экране; иначе правка его не касается
  const onScreen = (current: VendorCalendar, listing: string, day: string) =>
    current.listingId === listing && day.startsWith(current.month);

  /** Версия для правки: нет — правка не уходит (так не бывает: календарь уже загружен) */
  const versionOf = (listing: string) => {
    const version = known.current?.listingId === listing ? known.current.version : null;
    if (version === null) throw new Error("calendar version is unknown");
    return version;
  };

  /** Чужая правка (409) или день закрыл менеджер: показать календарь как в базе */
  const conflicted = async (err: unknown): Promise<boolean> => {
    const conflict = err instanceof ApiFailure && err.code === "calendar_conflict";
    const locked = err instanceof ApiFailure && err.code === "forbidden_for_actor";
    if (!conflict && !locked) return false;
    round.current += 1;
    setMessage(conflict ? "conflict" : "staff");
    if (!(await refresh())) reload();
    return true;
  };

  const save = async (
    listing: string,
    day: string,
    part: DayPart | null,
    entry: BusyDay | BusyPart | undefined,
    asked: number,
  ) => {
    const id = part === null ? day : `${day}/${part}`;
    try {
      // Пока правка ждала очереди, календарь перечитали из-за чужой правки: на экране уже
      // то, что в базе, — человек проверит и отметит заново
      if (round.current !== asked) return;
      const version = versionOf(listing);
      const change = entry
        ? await api.markFree(listing, day, version, part)
        : await api.markBusy(listing, day, version, part);
      remember(listing, change.version);
      setCalendar((current) => {
        if (current.listingId !== listing) return current;
        const next = onScreen(current, listing, day) ? withMark(current, day, part, change.busy) : current;
        return { ...next, version: Math.max(current.version, change.version) };
      });
    } catch (err) {
      if (!(await conflicted(err))) {
        setFailure(errorText(err, t));
        setMessage("failed");
        setCalendar((current) =>
          onScreen(current, listing, day) ? withMark(current, day, part, entry ?? null) : current,
        );
      }
    } finally {
      mark(id, false);
    }
  };

  const toggle = (day: string, part: DayPart | null, entry: BusyDay | BusyPart | undefined) => {
    if (entry?.source === "staff") {
      setMessage("staff");
      return;
    }
    setMessage(null);
    mark(part === null ? day : `${day}/${part}`, true);
    // Сразу на экране; не сохранилось — вернём как было
    const optimistic: BusyDay | BusyPart | null = entry
      ? null
      : part === null
        ? { day, source: "vendor", requestId: null }
        : { day, part, source: "vendor", requestId: null };
    setCalendar((current) => withMark(current, day, part, optimistic));
    const asked = round.current;
    queue.current = queue.current.then(() => save(listingId, day, part, entry, asked));
  };

  const ready = calendar.state === "ready" ? withDefaults(calendar.data) : null;
  const bounds = ready ? { today: ready.today, max: ready.maxDay } : null;
  const chosenDays =
    ranging && range && bounds ? rangeDays(range.start, range.end ?? range.start, bounds, weekdays) : [];

  /** Несколько дней одной правкой: закрыть или открыть день или часть */
  const applyRange = (close: boolean) => {
    if (chosenDays.length === 0) return;
    setMessage(null);
    setFreeing(false);
    mark("range", true);
    const asked = round.current;
    const batch = batchOf(chosenDays, what, close);
    queue.current = queue.current.then(async () => {
      try {
        if (round.current !== asked) return;
        const result = await api.markMany(listingId, batch, versionOf(listingId));
        remember(listingId, result.version);
        setCalendar((current) => (current.listingId === listingId ? mergeBatch(current, result) : current));
        if (result.skipped > 0) setMessage("skipped");
        setRange(null);
      } catch (err) {
        if (!(await conflicted(err))) {
          setFailure(errorText(err, t));
          setMessage("failed");
        }
      } finally {
        mark("range", false);
      }
    });
  };

  const [year, mon] = month.split("-");
  const monthName = t.months[Number(mon) - 1] ?? "";
  const canPrev = ready ? month > ready.today.slice(0, 7) : false;
  const canNext = ready ? month < ready.maxDay.slice(0, 7) : false;
  const whole = ready?.sessions.mode === "whole";
  // Открытый день на телефоне — шторка; на компьютере — колонка справа, рядом с месяцем
  const openDay = (day: string) => {
    setOpened(opened === day && desktop ? null : day);
    if (desktop) requestAnimationFrame(() => dayPanel.current?.focus?.({ preventScroll: true }));
  };
  const pick = (day: string) => {
    // Первое нажатие — начало; второе — конец; третье — новый выбор
    if (!range || range.end !== null) setRange({ start: day, end: null });
    else setRange({ start: range.start, end: day });
  };
  const toggleRanging = () => {
    setRanging(!ranging);
    setRange(null);
    setWeekdays(new Set());
    setWhat("whole");
    setOpened(null);
    setMessage(null);
  };
  const toggleWeekday = (index: number) =>
    setWeekdays((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  const legend = ready ? legendOf(ready) : [];
  const openedDay = ready && opened?.startsWith(ready.month) && !ranging ? opened : null;
  const rangeParts = ready && !whole ? ready.sessions.parts : [];
  const panel =
    ready && openedDay ? (
      <DayPanel
        calendar={ready}
        day={openedDay}
        t={t}
        pending={pending}
        navigate={navigate}
        onToggle={toggle}
        titled={desktop}
      />
    ) : null;

  return (
    <>
      <p className="lead cal-hint">{ranging ? t.rangeHint : whole ? t.calendarHintWhole : t.calendarHint}</p>
      <div className="cal-layout">
        <div className="cal-main">
          <div className="cal">
            <div className="cal-head">
              <p className="cal-month" aria-live="polite">
                {monthName} <span>{year}</span>
              </p>
              <div className="cal-nav">
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={t.prevMonth}
                  disabled={!canPrev}
                  onClick={() => setMonth((m) => shiftMonth(m, -1))}
                >
                  <Icon name="prev" size={14} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={t.nextMonth}
                  disabled={!canNext}
                  onClick={() => setMonth((m) => shiftMonth(m, 1))}
                >
                  <Icon name="next" size={14} />
                </button>
              </div>
            </div>
            <div className="cal-tools">
              <button type="button" className="pill" aria-pressed={ranging} onClick={toggleRanging}>
                {t.rangeMode}
              </button>
            </div>
            {calendar.state === "loading" ? <Loading t={t} kind="month" /> : null}
            {calendar.state === "error" ? <LoadError t={t} onRetry={reload} error={calendar.error} /> : null}
            {ready ? (
              <MonthGrid
                calendar={ready}
                t={t}
                pending={pending}
                opened={openedDay}
                chosen={ranging ? new Set(chosenDays) : null}
                onDay={(day) => (ranging ? pick(day) : openDay(day))}
              />
            ) : null}
            {/* Сообщение — у самого месяца: на компьютере обозначения сбоку, низ страницы далеко */}
            {message ? (
              <p className={message === "failed" ? "form-error" : "notice"} role="alert">
                {message === "failed" && failure ? failure : t[MESSAGE_TEXT[message]]}
              </p>
            ) : null}
          </div>
          {ranging && ready ? (
            <section className="panel range-panel" aria-label={t.rangeMode}>
              <p className="note" aria-live="polite">
                {range === null
                  ? t.rangePickStart
                  : range.end === null
                    ? t.rangePickEnd
                    : fill(t.rangeChosen, { n: chosenDays.length })}
              </p>
              <fieldset className="range-weekdays">
                <legend>{t.rangeWeekdays}</legend>
                <div className="chip-row">
                  {t.weekdays.map((name, index) => (
                    <button
                      key={name}
                      type="button"
                      className="pill"
                      aria-pressed={weekdays.has(index)}
                      aria-label={t.weekdaysLong[index] ?? name}
                      onClick={() => toggleWeekday(index)}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              </fieldset>
              {rangeParts.length > 0 ? (
                <fieldset className="range-what">
                  <legend>{t.rangeWhat}</legend>
                  <div className="chip-row">
                    {(["whole", ...rangeParts] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        className="pill"
                        aria-pressed={what === value}
                        onClick={() => setWhat(value)}
                      >
                        {value === "whole" ? t.wholeDay : partName(t, value)}
                      </button>
                    ))}
                  </div>
                </fieldset>
              ) : null}
              <div className="range-acts">
                <button
                  type="button"
                  className="btn btn-dark"
                  disabled={chosenDays.length === 0 || range?.end === null || pending.has("range")}
                  onClick={() => applyRange(true)}
                >
                  {fill(t.rangeClose, { n: chosenDays.length })}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={chosenDays.length === 0 || range?.end === null || pending.has("range")}
                  onClick={() => (chosenDays.length > 1 ? setFreeing(true) : applyRange(false))}
                >
                  {t.rangeOpen}
                </button>
                <button type="button" className="btn btn-ghost" onClick={toggleRanging}>
                  {t.cancel}
                </button>
              </div>
            </section>
          ) : null}
        </div>
        <div className="cal-aside">
          {desktop && panel ? (
            <div ref={dayPanel} className="day-panel-slot" tabIndex={-1}>
              {panel}
            </div>
          ) : null}
          {ready ? (
            <div className="sessions-line">
              <p className="capacity-text">
                <span className="sessions-title">{t.sessionsTitle}:</span> {sessionsLine(ready, t)}
              </p>
              {owner ? (
                <RouteLink to={{ route: "card" }} navigate={navigate} className="btn btn-ghost">
                  {t.sessionsEdit}
                </RouteLink>
              ) : null}
            </div>
          ) : null}
          {legend.length > 0 ? (
            <Disclosure
              label={t.legendTitle}
              open={legendOpen}
              onOpenChange={(open) => {
                setLegendOpen(open);
                storeLegendOpen(open);
              }}
            >
              <ul className="cal-legend">
                {legend.map((key) => (
                  <li key={key}>
                    <span className={`dot ${LEGEND[key].dot}`} />
                    {t[LEGEND[key].text]}
                  </li>
                ))}
              </ul>
            </Disclosure>
          ) : null}
        </div>
      </div>
      {!desktop ? (
        <Dialog
          open={panel !== null}
          title={openedDay ? formatDate(openedDay, t, true) : ""}
          onClose={() => setOpened(null)}
          className="day-sheet"
          actions={
            <button type="button" className="btn btn-ghost" onClick={() => setOpened(null)}>
              {t.close}
            </button>
          }
        >
          {panel}
        </Dialog>
      ) : null}
      <ConfirmSheet
        open={freeing}
        title={t.rangeOpenTitle}
        text={fill(t.rangeOpenText, { n: chosenDays.length })}
        confirmLabel={fill(t.rangeOpenConfirm, { n: chosenDays.length })}
        cancelLabel={t.cancel}
        busy={pending.has("range")}
        onConfirm={() => applyRange(false)}
        onCancel={() => setFreeing(false)}
      />
    </>
  );
}
