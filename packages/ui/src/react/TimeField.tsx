/* Время вместо <input type="time">: системный выбор времени в каждом браузере свой (где-то
   колёса, где-то поле с AM/PM), а в старых вебвью его нет совсем. Здесь — выпадающий
   список набора с шагом (по умолчанию 30 минут), 24-часовой формат «ЧЧ:ММ». Время не
   на сетке (записано раньше с другим шагом) остаётся в списке на своём месте. */

import { useMemo } from "react";
import { Select, type SelectProps } from "./Select";

export interface TimeFieldProps extends Omit<SelectProps<string>, "options" | "value"> {
  /** «ЧЧ:ММ» или null */
  readonly value: string | null;
  /** Шаг списка в минутах: 15, 30, 60 */
  readonly step?: number;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Времена суток с шагом step минут и value, если его нет на сетке */
export function timeOptions(step: number, value: string | null): string[] {
  const minutes = Math.max(1, Math.min(720, Math.round(step)));
  const times: string[] = [];
  for (let m = 0; m < 24 * 60; m += minutes)
    times.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
  if (value && TIME.test(value) && !times.includes(value)) times.push(value);
  return times.sort();
}

export function TimeField({ value, step = 30, ...props }: TimeFieldProps) {
  const options = useMemo(
    () => timeOptions(step, value).map((time) => ({ value: time, label: time })),
    [step, value],
  );
  return <Select {...props} value={value && TIME.test(value) ? value : null} options={options} />;
}
