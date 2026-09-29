/* Календарь занятости: месяц, одно нажатие — день занят или свободен. Отметка сразу
   видна на экране и уходит в API; не сохранилось — возвращается как было. Дни, занятые
   отказом «занято», вендор может освободить; закрытые менеджером — нет. Прошедшие дни
   не меняются. «Сегодня» и границы — по Ташкенту, их отдаёт сервер. */

import type { BusyDay, VendorCalendar, VendorListingRef } from "@bayramm/shared/api/vendor";
import { useState } from "react";
import { api } from "./api";
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
        const label = fill(entry ? t.dayBusy : t.dayFree, { date: formatDate(day, t, true) });
        return (
          <button
            key={day}
            type="button"
            className={classes}
            aria-pressed={entry !== undefined}
            aria-label={label}
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

interface CalendarProps extends Omit<ScreenProps, "lang"> {
  readonly listings: readonly VendorListingRef[];
  readonly listingId: string | null;
  readonly onListing: (id: string) => void;
}

export function Calendar({ t, headingRef, listings, listingId, onListing }: CalendarProps) {
  const [month, setMonth] = useState(() => tashkentToday().slice(0, 7));
  const key = listingId ? `${listingId}/${month}` : null;
  const [calendar, reload, setCalendar] = useLoad<VendorCalendar>(key, (k) => {
    const [id = "", m = ""] = k.split("/");
    return api.calendar(id, m);
  });
  const [pendingDays, setPendingDays] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState<"staff" | "failed" | null>(null);

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

  const toggle = async (day: string, entry: BusyDay | undefined) => {
    if (entry?.source === "staff") {
      setMessage("staff");
      return;
    }
    setMessage(null);
    setPending(day, true);
    // Сразу на экране; не сохранилось — вернём как было
    setCalendar((current) => ({
      ...current,
      busy: entry
        ? current.busy.filter((b) => b.day !== day)
        : [...current.busy, { day, source: "vendor", requestId: null }],
    }));
    try {
      if (entry) await api.markFree(listingId, day);
      else {
        const saved = await api.markBusy(listingId, day);
        setCalendar((current) => ({
          ...current,
          busy: [...current.busy.filter((b) => b.day !== day), saved],
        }));
      }
    } catch {
      setMessage("failed");
      setCalendar((current) => ({
        ...current,
        busy: entry
          ? [...current.busy.filter((b) => b.day !== day), entry]
          : current.busy.filter((b) => b.day !== day),
      }));
    } finally {
      setPending(day, false);
    }
  };

  const [year, mon] = month.split("-");
  const monthName = t.months[Number(mon) - 1] ?? "";
  const ready = calendar.state === "ready" ? calendar.data : null;
  const canPrev = ready ? month > ready.today.slice(0, 7) : false;
  const canNext = ready ? month < ready.maxDay.slice(0, 7) : false;

  return (
    <section className="page" aria-labelledby="page-title">
      <Heading headingRef={headingRef}>{t.calendar}</Heading>
      <p className="lead">{t.calendarNote}</p>
      <ListingPicker listings={listings} value={listingId} onChange={onListing} t={t} />

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
        {ready ? (
          <MonthGrid
            calendar={ready}
            t={t}
            pendingDays={pendingDays}
            onToggle={(d, e) => void toggle(d, e)}
          />
        ) : null}
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
        </ul>
      </div>
      {message ? (
        <p className={message === "failed" ? "form-error" : "notice"} role="alert">
          {message === "failed" ? t.calendarSaveFailed : t.staffLocked}
        </p>
      ) : null}
      <p className="note">
        {t.calendarHint} {t.tz}
      </p>
    </section>
  );
}
