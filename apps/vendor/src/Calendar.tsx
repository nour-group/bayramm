/* Календарь занятости: месяц, одно нажатие — день занят или свободен. Отметка сразу
   видна на экране и уходит в API; не сохранилось — возвращается как было. Дни, занятые
   отказом «занято», вендор может освободить; закрытые менеджером — нет. Прошедшие дни
   не меняются. «Сегодня» и границы — по Ташкенту, их отдаёт сервер.

   Календарь площадки ведут несколько человек: партнёр, его коллеги, менеджер, а отказ
   «занято» занимает дату сам. Каждая правка несёт версию календаря, которую видел
   человек (If-Match); правки уходят по очереди, каждая — от версии из прошлого ответа.
   Кто-то успел изменить календарь раньше (409 calendar_conflict) — месяц перечитывается,
   человек видит, что его изменили, и отмечает заново: чужая правка молча не затирается.

   Подпись дня для диктора называет всё, что видно глазами: занят ли, кем (отказ «занято»,
   менеджер), есть ли заявка, сегодня ли. На компьютере месяц крупнее, легенда — сбоку. */

import type { BusyDay, VendorCalendar, VendorListingRef } from "@bayramm/shared/api/vendor";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiFailure, api } from "./api";
import { formatDate, tashkentToday, weekdayIndex } from "./format";
import { fill, type VendorDict } from "./i18n";
import { Icon } from "./icons";
import { ListingPicker } from "./ListingPicker";
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

interface MonthProps {
  readonly calendar: VendorCalendar;
  readonly t: VendorDict;
  readonly pendingDays: ReadonlySet<string>;
  readonly onToggle: (day: string, busy: BusyDay | undefined) => void;
}

/** Подпись дня: дата, занят ли и кем, есть ли заявка, сегодня ли */
export function dayLabel(
  day: string,
  entry: BusyDay | undefined,
  extras: { readonly request: boolean; readonly today: boolean },
  t: VendorDict,
): string {
  const date = formatDate(day, t, true);
  const state = !entry
    ? t.dayFree
    : entry.source === "request_decline"
      ? t.dayBusyDecline
      : entry.source === "staff"
        ? t.dayBusyStaff
        : t.dayBusy;
  const parts = [fill(state, { date })];
  if (extras.request) parts.push(t.legendRequest);
  if (extras.today) parts.push(t.legendToday);
  return parts.join(", ");
}

function MonthGrid({ calendar, t, pendingDays, onToggle }: MonthProps) {
  const busy = new Map(calendar.busy.map((entry) => [entry.day, entry]));
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
        const entry = busy.get(day);
        const past = day < calendar.today;
        const beyond = day > calendar.maxDay;
        const locked = entry?.source === "staff";
        const classes = [
          "cal-day",
          weekdayIndex(day) > 4 ? "cal-we" : "",
          entry ? `cal-busy cal-${entry.source}` : "",
          day === calendar.today ? "cal-today" : "",
          requests.has(day) ? "cal-req" : "",
        ]
          .filter(Boolean)
          .join(" ");
        const label = dayLabel(day, entry, { request: requests.has(day), today: day === calendar.today }, t);
        return (
          <button
            key={day}
            type="button"
            className={classes}
            aria-pressed={entry !== undefined}
            aria-label={label}
            aria-current={day === calendar.today ? "date" : undefined}
            aria-disabled={locked || undefined}
            disabled={past || beyond || pendingDays.has(day)}
            onClick={() => onToggle(day, entry)}
          >
            <span className="cal-num">{Number(day.slice(8))}</span>
            {locked ? <Icon name="lock" size={12} /> : null}
          </button>
        );
      })}
    </div>
  );
}

type Message = "staff" | "failed" | "conflict";

const MESSAGE_TEXT = {
  staff: "staffLocked",
  failed: "calendarSaveFailed",
  conflict: "calendarConflict",
} as const satisfies Readonly<Record<Message, keyof VendorDict>>;

interface CalendarProps extends Omit<ScreenProps, "lang"> {
  readonly listings: readonly VendorListingRef[];
  readonly listingId: string | null;
  readonly onListing: (id: string) => void;
}

/** Отметка дня в загруженном месяце: busy — занят (как ответил сервер), null — свободен */
function withDay(calendar: VendorCalendar, day: string, busy: BusyDay | null): VendorCalendar {
  const rest = calendar.busy.filter((b) => b.day !== day);
  return { ...calendar, busy: busy ? [...rest, busy] : rest };
}

export function Calendar({ t, headingRef, listings, listingId, onListing }: CalendarProps) {
  const [month, setMonth] = useState(() => tashkentToday().slice(0, 7));
  const key = listingId ? `${listingId}/${month}` : null;
  const [calendar, reload, setCalendar, refresh] = useLoad<VendorCalendar>(key, (k) => {
    const [id = "", m = ""] = k.split("/");
    return api.calendar(id, m);
  });
  const [pendingDays, setPendingDays] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState<Message | null>(null);
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

  if (listings.length === 0 || !listingId) {
    return (
      <section className="page" aria-labelledby="page-title">
        <Heading headingRef={headingRef}>{t.calendar}</Heading>
        <Empty icon="calendar" title={t.noListings} text={t.noListingsText} />
      </section>
    );
  }

  const setPending = (day: string, on: boolean) =>
    setPendingDays((current) => {
      const next = new Set(current);
      if (on) next.add(day);
      else next.delete(day);
      return next;
    });

  // День — в том месяце той площадки, что на экране; иначе правка его не касается
  const onScreen = (current: VendorCalendar, listing: string, day: string) =>
    current.listingId === listing && day.startsWith(current.month);

  const save = async (listing: string, day: string, entry: BusyDay | undefined, asked: number) => {
    try {
      // Пока правка ждала очереди, календарь перечитали из-за чужой правки: на экране уже
      // то, что в базе, — человек проверит и отметит заново
      if (round.current !== asked) return;
      const version = known.current?.listingId === listing ? known.current.version : null;
      if (version === null) throw new Error("calendar version is unknown");
      const change = entry
        ? await api.markFree(listing, day, version)
        : await api.markBusy(listing, day, version);
      remember(listing, change.version);
      setCalendar((current) => {
        if (current.listingId !== listing) return current;
        const next = onScreen(current, listing, day) ? withDay(current, day, change.busy) : current;
        return { ...next, version: Math.max(current.version, change.version) };
      });
    } catch (err) {
      const conflict = err instanceof ApiFailure && err.code === "calendar_conflict";
      // День успел закрыть менеджер — тоже чужая правка: показать календарь как в базе
      const locked = err instanceof ApiFailure && err.code === "forbidden_for_actor";
      if (conflict || locked) {
        round.current += 1;
        setMessage(conflict ? "conflict" : "staff");
        if (!(await refresh())) reload();
      } else {
        setMessage("failed");
        setCalendar((current) =>
          onScreen(current, listing, day) ? withDay(current, day, entry ?? null) : current,
        );
      }
    } finally {
      setPending(day, false);
    }
  };

  const toggle = (day: string, entry: BusyDay | undefined) => {
    if (entry?.source === "staff") {
      setMessage("staff");
      return;
    }
    setMessage(null);
    setPending(day, true);
    // Сразу на экране; не сохранилось — вернём как было
    setCalendar((current) =>
      withDay(current, day, entry ? null : { day, source: "vendor", requestId: null }),
    );
    const listing = listingId;
    const asked = round.current;
    queue.current = queue.current.then(() => save(listing, day, entry, asked));
  };

  const [year, mon] = month.split("-");
  const monthName = t.months[Number(mon) - 1] ?? "";
  const ready = calendar.state === "ready" ? calendar.data : null;
  const canPrev = ready ? month > ready.today.slice(0, 7) : false;
  const canNext = ready ? month < ready.maxDay.slice(0, 7) : false;

  return (
    <section className="page page-calendar" aria-labelledby="page-title">
      <Heading headingRef={headingRef}>{t.calendar}</Heading>
      <p className="lead">{t.calendarNote}</p>
      <ListingPicker listings={listings} value={listingId} onChange={onListing} t={t} />

      <div className="cal-layout">
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
          {calendar.state === "loading" ? <Loading t={t} /> : null}
          {calendar.state === "error" ? <LoadError t={t} onRetry={reload} /> : null}
          {ready ? <MonthGrid calendar={ready} t={t} pendingDays={pendingDays} onToggle={toggle} /> : null}
          {/* Сообщение — у самого месяца: на компьютере легенда сбоку, низ страницы далеко */}
          {message ? (
            <p className={message === "failed" ? "form-error" : "notice"} role="alert">
              {t[MESSAGE_TEXT[message]]}
            </p>
          ) : null}
        </div>
        <aside className="cal-aside" aria-labelledby="legend-title">
          <h2 className="panel-title" id="legend-title">
            {t.legendTitle}
          </h2>
          <ul className="cal-legend">
            <li>
              <span className="dot dot-busy" />
              {t.legendBusy}
            </li>
            <li>
              <span className="dot dot-decline" />
              {t.legendDecline}
            </li>
            <li>
              <span className="dot dot-staff" />
              {t.legendStaff}
            </li>
            <li>
              <span className="dot dot-req" />
              {t.legendRequest}
            </li>
            <li>
              <span className="dot dot-today" />
              {t.legendToday}
            </li>
          </ul>
          <p className="note">
            {t.calendarHint} {t.tz}
          </p>
        </aside>
      </div>
    </section>
  );
}
