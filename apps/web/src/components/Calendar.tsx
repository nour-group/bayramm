import { useState } from "react";
import { useLang } from "../context";
import {
  addMonths,
  daysInMonth,
  formatDayMonth,
  formatMonthYear,
  isWeekend,
  monthOf,
  weekdayMon,
} from "../format";
import { Icon } from "../icons";

interface CalendarProps {
  /** Первый и последний день, который можно выбрать (YYYY-MM-DD) */
  readonly min: string;
  readonly max: string;
  /** Занятые дни: выбрать нельзя, число выцветает (а не краснеет) */
  readonly busy?: ReadonlySet<string>;
  readonly selected: string | null;
  /** Нет — календарь только показывает занятость */
  readonly onSelect?: (date: string) => void;
  /** Подпись для диктора: что это за календарь */
  readonly label: string;
}

const NO_BUSY: ReadonlySet<string> = new Set();

/**
 * Месяц с понедельника. Прошедшие дни и дни вне [min, max] неактивны, занятые — тоже.
 * Навигация по месяцам не уходит за min и max. Классы, а не data-атрибуты: у дней
 * свои обработчики, пересечений нет (ловушка №1)
 */
export function Calendar({ min, max, busy = NO_BUSY, selected, onSelect, label }: CalendarProps) {
  const { t } = useLang();
  const [month, setMonth] = useState(() => monthOf(selected && selected >= min ? selected : min));
  const first = monthOf(min);
  const last = monthOf(max);
  const count = daysInMonth(month);
  const lead = weekdayMon(month);
  const days = Array.from(
    { length: count },
    (_, i) => `${month.slice(0, 8)}${String(i + 1).padStart(2, "0")}`,
  );
  const busyInMonth = days.filter((day) => busy.has(day) && day >= min).length;

  return (
    // biome-ignore lint/a11y/useSemanticElements: группа кнопок-дней с подписью, fieldset здесь не форма
    <div className="cal" role="group" aria-label={label}>
      <div className="cal-head">
        <button
          type="button"
          className="icon-btn"
          aria-label={t.calPrev}
          disabled={month <= first}
          onClick={() => setMonth(addMonths(month, -1))}
        >
          <Icon name="prev" size={14} />
        </button>
        <p className="cal-title" aria-live="polite">
          <span>{formatMonthYear(month, t)}</span>
          <span className="cal-sum">{busyInMonth ? t.calBusyN(busyInMonth) : t.calAllFree}</span>
        </p>
        <button
          type="button"
          className="icon-btn"
          aria-label={t.calNext}
          disabled={month >= last}
          onClick={() => setMonth(addMonths(month, 1))}
        >
          <Icon name="next" size={14} />
        </button>
      </div>
      <div className="cal-grid">
        {t.weekdaysMon.map((day, i) => (
          <span key={day} className={i >= 5 ? "cal-wd we" : "cal-wd"} aria-hidden="true">
            {day}
          </span>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: пустые клетки до первого числа, порядок не меняется
          <span key={`pad-${i}`} className="cal-pad" aria-hidden="true" />
        ))}
        {days.map((day, i) => {
          const outside = day < min || day > max;
          const isBusy = busy.has(day);
          // Занятый день выбранным не рисуется: «занято» важнее «ваша дата»
          const isSelected = day === selected && !isBusy;
          const classes = [
            "cal-day",
            isWeekend(day) ? "we" : "",
            outside ? "out" : "",
            isBusy && !outside ? "busy" : "",
            isSelected ? "sel" : "",
          ]
            .filter(Boolean)
            .join(" ");
          const status = isBusy ? t.legBusy : t.legFree;
          const name = `${formatDayMonth(day, t)}${outside ? "" : `, ${status}`}`;
          if (!onSelect)
            return (
              <span key={day} className={classes}>
                <span aria-hidden="true">{i + 1}</span>
                <span className="sr-only">{name}</span>
              </span>
            );
          return (
            <button
              key={day}
              type="button"
              className={classes}
              disabled={outside || isBusy}
              aria-pressed={isSelected}
              aria-label={name}
              onClick={() => onSelect(day)}
            >
              {i + 1}
            </button>
          );
        })}
      </div>
      <p className="cal-legend" aria-hidden="true">
        <span className="leg leg-free">{t.legFree}</span>
        <span className="leg leg-busy">{t.legBusy}</span>
        {selected ? <span className="leg leg-sel">{t.legSel}</span> : null}
      </p>
    </div>
  );
}
