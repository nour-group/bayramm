/* Занятые дни карточки: месяц сеткой, неделя с понедельника. Нажатие на день отмечает
   его занятым или снимает отметку. Прошедшие дни не меняются. «Сегодня» — по Ташкенту.
   Календарь ведут и вендор, и команда: правка уходит с версией календаря из последнего
   ответа. Его успели изменить (вендор, другой сотрудник, отказ «занято») — сервер отвечает
   calendar_conflict: месяц перечитывается, сотрудник отмечает день ещё раз. Правки идут
   по одной — дни неактивны, пока не пришёл ответ.
   «Несколько дней»: первое нажатие — начало, второе — конец (пальцем, без перетаскивания,
   можно и через месяц), затем «Занять» или «Освободить» — одной правкой. Прошедшие дни в
   выбор не входят. Клетка дня — вся дорожка сетки, не меньше 44px: на 320px месяц выходит
   на 10px за поля страницы и семь дорожек по 44px помещаются без прокрутки вбок. */

import type { Availability, AvailabilityInput, BusyDay } from "@bayramm/shared/api/staff";
import { Tooltip } from "@bayramm/ui/react";
import { useRef, useState } from "react";
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

/** Не больше, чем сервер примет одной правкой */
const MAX_RANGE = 400;

/**
 * Дни выбора «несколько дней» по порядку, от раннего к позднему (концы можно выбрать в любом
 * порядке); прошедшие до today — не входят
 */
export function rangeDays(a: string, b: string, today: string): string[] {
  const [from, to] = a <= b ? [a, b] : [b, a];
  const days: string[] = [];
  for (let d = Date.parse(`${from}T00:00:00Z`); days.length < MAX_RANGE; d += DAY_MS) {
    const day = new Date(d).toISOString().slice(0, 10);
    if (day > to) break;
    if (day >= today) days.push(day);
  }
  return days;
}

/** Вливает ответ правки (занятые дни на его отрезке) в показанный месяц */
export function mergeBusy(current: Availability, result: Availability): Availability {
  // Вне отрезка ответа — как было; на отрезке — как ответил сервер (дни за краем месяца
  // сетка просто не показывает)
  const others = current.busy.filter((b) => b.day < result.from || b.day > result.to);
  const busy = [...others, ...result.busy].sort((a, b) => a.day.localeCompare(b.day));
  return { ...current, busy, version: result.version };
}

type Range = { readonly start: string; readonly end: string | null };

export function Calendar({ listingId }: { listingId: string }) {
  const { api } = useSession();
  const can = useCan();
  const today = tashkentToday();
  const [month, setMonth] = useState(today.slice(0, 7));
  const { days, offset } = monthGrid(month);
  const from = days[0] ?? today;
  const to = days.at(-1) ?? today;
  const path = `/staff/listings/${listingId}/availability?from=${from}&to=${to}`;
  const { loaded, reload, set } = useLoad<Availability>(path);
  // Ответ, пришедший после перехода на другой месяц, в новый месяц не вливаем
  const shown = useRef(path);
  shown.current = path;
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  // Выбор нескольких дней: null — обычный режим (нажатие отмечает день сразу)
  const [ranging, setRanging] = useState(false);
  const [range, setRange] = useState<Range | null>(null);
  const editable = can("listings.write");
  const selected = range ? rangeDays(range.start, range.end ?? range.start, today) : [];

  // Сообщение об ошибке — про месяц, где отмечали: в другом месяце оно только путает
  const goMonth = (delta: number) => {
    setFailure(null);
    setMonth(shiftMonth(month, delta));
  };

  const send = async (key: string, input: AvailabilityInput, current: Availability) => {
    const at = path;
    setPending(key);
    setFailure(null);
    const result = await api.put<Availability>(`/staff/listings/${listingId}/availability`, input);
    if (result.ok && shown.current === at) {
      // Ответ — только про изменённые дни и новая версия: вливаем в месяц
      set(mergeBusy(current, result.data));
    } else if (!result.ok && shown.current === at) {
      setFailure(result);
      // Календарь изменили: показываем актуальный месяц, дни неактивны, пока он не пришёл
      if (result.code === "calendar_conflict") {
        const fresh = await api.get<Availability>(at);
        if (!fresh.ok) reload();
        else if (shown.current === at) set(fresh.data);
      }
    }
    setPending(null);
    return result.ok;
  };

  const toggle = (day: string, busy: BusyDay | undefined, current: Availability) =>
    void send(
      day,
      busy ? { version: current.version, free: [day] } : { version: current.version, busy: [day] },
      current,
    );

  const pick = (day: string) => {
    // Первое нажатие — начало; второе — конец; третье — новый выбор
    if (!range || range.end !== null) setRange({ start: day, end: null });
    else setRange({ start: range.start, end: day });
  };

  const applyRange = async (mark: "busy" | "free", current: Availability) => {
    if (selected.length === 0) return;
    const ok = await send("range", { version: current.version, [mark]: selected }, current);
    if (ok) {
      setRange(null);
      setRanging(false);
    }
  };

  const toggleRanging = () => {
    setRanging(!ranging);
    setRange(null);
    setFailure(null);
  };

  return (
    <section className="panel cal-panel" aria-labelledby="calendar-title">
      <h2 id="calendar-title">{t.availability}</h2>
      {/* Без права правки дни неактивны — и подсказка не зовёт на них нажимать */}
      <p className="muted small">{editable ? t.availabilityHint : t.availabilityReadOnly}</p>
      <div className="cal-head">
        <button type="button" className="btn btn-sm" onClick={() => goMonth(-1)} aria-label={t.prevMonth}>
          ←
        </button>
        <p className="cal-title" aria-live="polite">
          {monthTitle(month)}
        </p>
        <button type="button" className="btn btn-sm" onClick={() => goMonth(1)} aria-label={t.nextMonth}>
          →
        </button>
      </div>
      {editable && (
        <div className="cal-tools">
          <button type="button" className="chip" aria-pressed={ranging} onClick={toggleRanging}>
            {t.rangeMode}
          </button>
          {ranging && (
            <p className="muted small" aria-live="polite">
              {range === null
                ? t.rangePickStart
                : range.end === null
                  ? t.rangePickEnd
                  : t.rangeChosen(selected.length)}
            </p>
          )}
        </div>
      )}
      <LoadedView loaded={loaded} onRetry={reload} skeleton="block">
        {(availability) => {
          const busyByDay = new Map(availability.busy.map((b) => [b.day, b]));
          const inRange = new Set(selected);
          return (
            <>
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
                  const chosen = inRange.has(day);
                  const label = `${dayTitle.format(new Date(`${day}T00:00:00Z`))}${busy ? ` — ${t.busy}, ${t.busySources[busy.source] ?? ""}` : ""}${chosen ? `, ${t.rangeInside}` : ""}`;
                  // Подсказка под мышью повторяет aria-label: диктору её не дублируем
                  return (
                    <Tooltip key={day} text={label} describe={false}>
                      {(tip) => (
                        <button
                          {...tip}
                          type="button"
                          className={`cal-day${busy ? " cal-busy" : ""}${day === today ? " cal-today" : ""}${chosen ? " cal-chosen" : ""}`}
                          aria-pressed={Boolean(busy)}
                          aria-label={label}
                          disabled={!editable || past || pending !== null}
                          onClick={() => (ranging ? pick(day) : toggle(day, busy, availability))}
                        >
                          {Number(day.slice(8))}
                        </button>
                      )}
                    </Tooltip>
                  );
                })}
              </div>
              <ul className="cal-legend" aria-label={t.legend}>
                <li>
                  <span className="cal-key cal-key-free" aria-hidden="true" />
                  {t.legendFree}
                </li>
                <li>
                  <span className="cal-key cal-key-busy" aria-hidden="true" />
                  {t.legendBusy}
                </li>
                <li>
                  <span className="cal-key cal-key-today" aria-hidden="true" />
                  {t.legendToday}
                </li>
                {ranging && (
                  <li>
                    <span className="cal-key cal-key-chosen" aria-hidden="true" />
                    {t.legendChosen}
                  </li>
                )}
              </ul>
              {ranging && selected.length > 0 && range?.end !== null && (
                <div className="acts cal-range-acts">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={pending !== null}
                    onClick={() => void applyRange("busy", availability)}
                  >
                    {t.rangeBusy(selected.length)}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={pending !== null}
                    onClick={() => void applyRange("free", availability)}
                  >
                    {t.rangeFree}
                  </button>
                  <button type="button" className="btn" onClick={() => setRange(null)}>
                    {t.cancel}
                  </button>
                </div>
              )}
            </>
          );
        }}
      </LoadedView>
      {failure && <ErrorText failure={failure} />}
    </section>
  );
}
