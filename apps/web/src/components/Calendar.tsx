import type { Dict } from "@bayramm/shared";
import { type CalendarProps, type CalendarTexts, Calendar as KitCalendar } from "@bayramm/ui/react";
import { useMemo } from "react";
import { useLang } from "../context";
import { formatDayMonth, formatMonthYear } from "../format";

/** Тексты календаря набора из словаря клиента: месяцы, дни недели, легенда, итог месяца */
export function calendarTexts(t: Dict): CalendarTexts {
  return {
    prev: t.calPrev,
    next: t.calNext,
    weekdays: t.weekdaysMon,
    monthTitle: (month) => formatMonthYear(month, t),
    dayLabel: (date) => formatDayMonth(date, t),
    free: t.legFree,
    busy: t.legBusy,
    selected: t.legSel,
    summary: (busyDays) => (busyDays ? t.calBusyN(busyDays) : t.calAllFree),
  };
}

export function useCalendarTexts(): CalendarTexts {
  const { t } = useLang();
  return useMemo(() => calendarTexts(t), [t]);
}

/**
 * Календарь месяца — из @bayramm/ui/react (клавиатура, занятые дни, диапазон), тексты —
 * на языке клиента. Без onSelect только показывает занятость (карточка площадки)
 */
export function Calendar(props: Omit<CalendarProps, "texts">) {
  return <KitCalendar {...props} texts={useCalendarTexts()} />;
}
