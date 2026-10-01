/* Части дня для модели занятости parts: окна по умолчанию и перевод времени
   начала из заявки в часть дня. Сервер хранит часть в заявке (app.requests.day_part), по
   ней считает занятость; клиент — подсказывает, в какую часть попадёт выбранное время. */

import { type CategoryConfig, DAY_PARTS, type DayPart, type DayPartWindows } from "./types";

/**
 * Окна частей дня по умолчанию, по Ташкенту: утро — нахорги ош, день — ЗАГС и фотосессия,
 * вечер — свадьба. Время до начала утра (ночь) считается утром
 */
export const DEFAULT_DAY_PARTS: DayPartWindows = {
  morning: { from: "05:00", to: "11:00" },
  day: { from: "11:00", to: "17:00" },
  evening: { from: "17:00", to: "24:00" },
};

const minutes = (time: string): number => {
  const [h = "0", m = "0"] = time.split(":");
  return Number(h) * 60 + Number(m);
};

/** Окна частей дня категории */
export function dayPartWindows(category: CategoryConfig): DayPartWindows {
  return category.dayParts ?? DEFAULT_DAY_PARTS;
}

/** Часть дня для времени «ЧЧ:ММ»: окно, в которое оно попадает; раньше первого окна — утро */
export function dayPartOf(category: CategoryConfig, time: string): DayPart {
  const windows = dayPartWindows(category);
  const at = minutes(time);
  for (const part of DAY_PARTS) {
    const { from, to } = windows[part];
    if (at >= minutes(from) && at < minutes(to)) return part;
  }
  return at < minutes(windows.morning.from) ? "morning" : "evening";
}

/** Есть ли у категории части дня (модель parts) */
export function hasDayParts(category: CategoryConfig): boolean {
  return category.availability === "parts";
}
