/* Занятые дни карточки: месяц сеткой, неделя с понедельника. Нажатие на день отмечает
   его занятым или снимает отметку. Прошедшие дни не меняются. «Сегодня» — по Ташкенту. */

import type { Availability, BusyDay } from "@bayramm/shared/api/staff";
import { Tooltip } from "@bayramm/ui/react";
import { useState } from "react";
import { type Failure, useCan, useLoad, useSession } from "../api";
import { t } from "../texts";
import { ErrorText, LoadedView } from "../ui";

const DAY_MS = 86_400_000;

/** «Сегодня» по Ташкенту (UTC+5 круглый год) */
export function tashkentToday(now = new Date()): string {
  return new Date(now.getTime() + 5 * 3600_000).toISOString().slice(0, 10);
}

/** Дни месяца «YYYY-MM» и сколько пустых клеток перед первым (неделя с понедельника) */
export function monthGrid(month: string): { days: string[]; offset: number } {
  const first = new Date(`${month}-01T00:00:00Z`);
  const days: string[] = [];
  for (let d = first.getTime(); new Date(d).getUTCMonth() === first.getUTCMonth(); d += DAY_MS) {
    days.push(new Date(d).toISOString().slice(0, 10));
  }
  return { days, offset: (first.getUTCDay() + 6) % 7 };
}

export function shiftMonth(month: string, delta: number): string {
  const [year = 0, mon = 1] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, mon - 1 + delta, 1));
  return date.toISOString().slice(0, 7);
}

const monthFormat = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" });

/** «Сентябрь 2026» — без «г.» и с заглавной */
export function monthTitle(month: string): string {
  const text = monthFormat.format(new Date(`${month}-01T00:00:00Z`)).replace(/\s*г\.?$/, "");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
const dayTitle = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" });

export function Calendar({ listingId }: { listingId: string }) {
  const { api } = useSession();
  const can = useCan();
  const today = tashkentToday();
  const [month, setMonth] = useState(today.slice(0, 7));
  const { days, offset } = monthGrid(month);
  const from = days[0] ?? today;
  const to = days.at(-1) ?? today;
  const { loaded, reload, set } = useLoad<Availability>(
    `/staff/listings/${listingId}/availability?from=${from}&to=${to}`,
  );
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const editable = can("listings.write");

  const toggle = async (day: string, busy: BusyDay | undefined, current: Availability) => {
    setPending(day);
    const result = await api.put<Availability>(
      `/staff/listings/${listingId}/availability`,
      busy ? { free: [day] } : { busy: [day] },
    );
    setPending(null);
    setFailure(result.ok ? null : result);
    if (result.ok) {
      // Ответ — только про изменённый день: вливаем в месяц
      const others = current.busy.filter((b) => b.day !== day);
      set({ ...current, busy: [...others, ...result.data.busy].sort((a, b) => a.day.localeCompare(b.day)) });
    }
  };

  return (
    <section className="panel" aria-labelledby="calendar-title">
      <h2 id="calendar-title">{t.availability}</h2>
      <p className="muted small">{t.availabilityHint}</p>
      <div className="cal-head">
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setMonth(shiftMonth(month, -1))}
          aria-label={t.prevMonth}
        >
          ←
        </button>
        <p className="cal-title" aria-live="polite">
          {monthTitle(month)}
        </p>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setMonth(shiftMonth(month, 1))}
          aria-label={t.nextMonth}
        >
          →
        </button>
      </div>
      <LoadedView loaded={loaded} onRetry={reload}>
        {(availability) => {
          const busyByDay = new Map(availability.busy.map((b) => [b.day, b]));
          return (
            <div className="cal">
              {t.weekdays.map((name) => (
                <span key={name} className="cal-wd" aria-hidden="true">
                  {name}
                </span>
              ))}
              {Array.from({ length: offset }, (_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: пустые клетки перед первым числом
                <span key={`pad-${i}`} className="cal-pad" aria-hidden="true" />
              ))}
              {days.map((day) => {
                const busy = busyByDay.get(day);
                const past = day < today;
                const label = `${dayTitle.format(new Date(`${day}T00:00:00Z`))}${busy ? ` — ${t.busy}, ${t.busySources[busy.source] ?? ""}` : ""}`;
                // Подсказка под мышью повторяет aria-label: диктору её не дублируем
                return (
                  <Tooltip key={day} text={label} describe={false}>
                    {(tip) => (
                      <button
                        {...tip}
                        type="button"
                        className={`cal-day${busy ? " cal-busy" : ""}${day === today ? " cal-today" : ""}`}
                        aria-pressed={Boolean(busy)}
                        aria-label={label}
                        disabled={!editable || past || pending !== null}
                        onClick={() => void toggle(day, busy, availability)}
                      >
                        {Number(day.slice(8))}
                      </button>
                    )}
                  </Tooltip>
                );
              })}
            </div>
          );
        }}
      </LoadedView>
      {failure && <ErrorText failure={failure} />}
    </section>
  );
}
