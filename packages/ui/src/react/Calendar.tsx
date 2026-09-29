/* Календарь месяца с понедельника. Даты — строки YYYY-MM-DD без часовых поясов: «сегодня»
   по Ташкенту считает приложение и передаёт как min.

   Дни — кнопки с одним местом в порядке Tab (roving tabindex): стрелки ходят по дням и
   неделям, Home/End — к началу и концу недели, PageUp/PageDown — по месяцам. Недоступные
   (вне min…max, занятые) остаются в фокусе и читаются диктором, но aria-disabled и не
   выбираются. Занятый день выцветает, а не краснеет: красный значит «нажми».
   Классы с префиксом ui-, обработчики — у каждой кнопки: пересечений нет (ловушка №1). */

import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { UiIcon } from "./icons";
import { focusQuietly } from "./overlay";

const DAY_MS = 86_400_000;

const utc = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`);
const iso = (date: Date) => date.toISOString().slice(0, 10);

export function addDays(date: string, days: number): string {
  return iso(new Date(utc(date).getTime() + days * DAY_MS));
}

/** Первое число месяца даты */
export function monthOf(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export function addMonths(month: string, months: number): string {
  const date = utc(month);
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  return iso(date);
}

export function daysInMonth(month: string): number {
  const date = utc(month);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
}

/** 0 — понедельник … 6 — воскресенье */
export function weekdayMon(date: string): number {
  return (utc(date).getUTCDay() + 6) % 7;
}

const lastOfMonth = (month: string) => addDays(addMonths(month, 1), -1);
const clamp = (date: string, from: string, to: string) => (date < from ? from : date > to ? to : date);

export interface CalendarTexts {
  readonly prev: string;
  readonly next: string;
  /** Дни недели с понедельника: 7 коротких названий */
  readonly weekdays: readonly string[];
  /** Название месяца с годом для первого числа месяца: «Октябрь 2026» */
  readonly monthTitle: (month: string) => string;
  /** Начало имени дня для диктора: «15 окт» */
  readonly dayLabel: (date: string) => string;
  readonly free: string;
  readonly busy: string;
  /** Подпись выбранного дня в легенде: «ваша дата» */
  readonly selected: string;
  /** Итог месяца под названием: «занято 3 дня», «весь месяц свободен» */
  readonly summary?: (busyDays: number) => string;
}

export interface CalendarProps {
  /** Первый и последний день, который можно выбрать */
  readonly min: string;
  readonly max: string;
  /** Занятые дни: выбрать нельзя */
  readonly busy?: ReadonlySet<string>;
  readonly selected: string | null;
  /** Нет — календарь только показывает занятость */
  readonly onSelect?: (date: string) => void;
  /** Что это за календарь — для диктора */
  readonly label: string;
  readonly texts: CalendarTexts;
  /** Легенда «свободно · занято · ваша дата» под сеткой */
  readonly legend?: boolean;
  /** Сразу поставить фокус на выбранный или первый доступный день (календарь в шторке) */
  readonly autoFocus?: boolean;
}

const NO_BUSY: ReadonlySet<string> = new Set();

export function Calendar({
  min,
  max,
  busy = NO_BUSY,
  selected,
  onSelect,
  label,
  texts,
  legend = true,
  autoFocus = false,
}: CalendarProps) {
  const base = useId();
  const [month, setMonth] = useState(() => monthOf(selected && selected >= min ? selected : min));
  const [focusDay, setFocusDay] = useState<string | null>(null);
  const moved = useRef(autoFocus);
  const prevButton = useRef<HTMLButtonElement>(null);
  const nextButton = useRef<HTMLButtonElement>(null);
  /** Кнопка месяца стала недоступной под фокусом — фокус переходит на соседнюю */
  const edge = useRef<HTMLButtonElement | null>(null);
  const first = monthOf(min);
  const last = monthOf(max);
  const count = daysInMonth(month);
  const lead = weekdayMon(month);
  const days = Array.from(
    { length: count },
    (_, i) => `${month.slice(0, 8)}${String(i + 1).padStart(2, "0")}`,
  );
  const pickable = (day: string) => day >= min && day <= max && !busy.has(day);
  const busyInMonth = days.filter((day) => busy.has(day) && day >= min && day <= max).length;

  // Место в порядке Tab: день с фокусом, выбранный, первый доступный — в этом месяце
  const stop =
    (focusDay && monthOf(focusDay) === month && focusDay) ||
    (selected && monthOf(selected) === month && selected) ||
    days.find(pickable) ||
    days[0];

  const dayId = (day: string) => `${base}-d${day}`;

  // Фокус на новый день — только после хода с клавиатуры (или при открытии в шторке)
  useEffect(() => {
    const active = document.activeElement;
    if (edge.current && (active === document.body || active?.hasAttribute("disabled")))
      focusQuietly(edge.current);
    edge.current = null;
    if (!moved.current || !stop) return;
    moved.current = false;
    focusQuietly(document.getElementById(dayId(stop)));
  });

  const go = (day: string) => {
    const next = clamp(day, first, lastOfMonth(last));
    moved.current = true;
    setFocusDay(next);
    if (monthOf(next) !== month) setMonth(monthOf(next));
  };

  const onDayKey = (event: KeyboardEvent<HTMLButtonElement>, day: string) => {
    const shift: Record<string, () => string> = {
      ArrowLeft: () => addDays(day, -1),
      ArrowRight: () => addDays(day, 1),
      ArrowUp: () => addDays(day, -7),
      ArrowDown: () => addDays(day, 7),
      Home: () => addDays(day, -weekdayMon(day)),
      End: () => addDays(day, 6 - weekdayMon(day)),
      PageUp: () => sameDayIn(addMonths(monthOf(day), -1), day),
      PageDown: () => sameDayIn(addMonths(monthOf(day), 1), day),
    };
    const target = shift[event.key];
    if (!target) return;
    event.preventDefault();
    go(target());
  };

  const switchMonth = (delta: number) => {
    const next = addMonths(month, delta);
    setMonth(next);
    setFocusDay(null);
    if (delta < 0 && next <= first) edge.current = nextButton.current;
    if (delta > 0 && next >= last) edge.current = prevButton.current;
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: группа кнопок-дней с подписью, fieldset здесь не форма
    <div className="ui-cal" role="group" aria-label={label}>
      <div className="ui-cal-head">
        <button
          ref={prevButton}
          type="button"
          className="ui-icon-btn"
          aria-label={texts.prev}
          disabled={month <= first}
          onClick={() => switchMonth(-1)}
        >
          <UiIcon name="prev" size={14} />
        </button>
        <p className="ui-cal-title" aria-live="polite">
          <span>{texts.monthTitle(month)}</span>
          {texts.summary ? <span className="ui-cal-sum">{texts.summary(busyInMonth)}</span> : null}
        </p>
        <button
          ref={nextButton}
          type="button"
          className="ui-icon-btn"
          aria-label={texts.next}
          disabled={month >= last}
          onClick={() => switchMonth(1)}
        >
          <UiIcon name="next" size={14} />
        </button>
      </div>
      <div className="ui-cal-grid">
        {texts.weekdays.map((name, i) => (
          <span key={name} className={i >= 5 ? "ui-cal-wd is-weekend" : "ui-cal-wd"} aria-hidden="true">
            {name}
          </span>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: пустые клетки до первого числа, порядок не меняется
          <span key={`pad-${i}`} className="ui-cal-pad" aria-hidden="true" />
        ))}
        {days.map((day, i) => {
          const outside = day < min || day > max;
          const isBusy = busy.has(day) && !outside;
          // Занятый день выбранным не рисуется: «занято» важнее «ваша дата»
          const isSelected = day === selected && !isBusy && !outside;
          const classes = [
            "ui-cal-day",
            weekdayMon(day) >= 5 ? "is-weekend" : "",
            outside ? "is-out" : "",
            isBusy ? "is-busy" : "",
            isSelected ? "is-selected" : "",
          ]
            .filter(Boolean)
            .join(" ");
          const name = `${texts.dayLabel(day)}${outside ? "" : `, ${isBusy ? texts.busy : texts.free}`}`;
          if (!onSelect)
            return (
              <span key={day} className={classes}>
                <span aria-hidden="true">{i + 1}</span>
                <span className="ui-sr-only">{name}</span>
              </span>
            );
          return (
            <button
              key={day}
              id={dayId(day)}
              type="button"
              className={classes}
              tabIndex={day === stop ? 0 : -1}
              aria-disabled={!pickable(day) || undefined}
              aria-pressed={isSelected}
              aria-label={name}
              onFocus={() => setFocusDay(day)}
              onKeyDown={(event) => onDayKey(event, day)}
              onClick={() => {
                if (pickable(day)) onSelect(day);
              }}
            >
              {i + 1}
            </button>
          );
        })}
      </div>
      {legend ? (
        <p className="ui-cal-legend" aria-hidden="true">
          <span className="ui-leg ui-leg-free">{texts.free}</span>
          <span className="ui-leg ui-leg-busy">{texts.busy}</span>
          {selected ? <span className="ui-leg ui-leg-sel">{texts.selected}</span> : null}
        </p>
      ) : null}
    </div>
  );
}

/** Тот же номер дня в другом месяце; 31-го нет — последнее число */
function sameDayIn(month: string, day: string): string {
  const n = Math.min(Number(day.slice(8, 10)), daysInMonth(month));
  return `${month.slice(0, 8)}${String(n).padStart(2, "0")}`;
}
