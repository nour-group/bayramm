/* Число вместо <input type="number">: у системного — свои стрелки, колёсико мыши меняет
   значение при прокрутке страницы, а «e» и «-» проходят в поле. Здесь — текстовое поле
   с цифровой клавиатурой (role="spinbutton"): стрелки вверх и вниз — шаг, PageUp/PageDown —
   десять шагов; по бокам кнопки «−» и «+» с зоной нажатия 44px. В поле только цифры. */

import type { ChangeEvent, KeyboardEvent } from "react";
import { UiIcon } from "./icons";

export interface NumberStepperProps {
  /** Строка, чтобы человек мог стереть поле и набрать заново */
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  /** Подписи кнопок «−» и «+»: «Гостей −20». Без них — только поле */
  readonly decrementLabel?: string;
  readonly incrementLabel?: string;
  readonly id?: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly maxLength?: number;
  readonly "aria-invalid"?: boolean;
  readonly "aria-describedby"?: string;
  readonly "aria-label"?: string;
  readonly onBlur?: () => void;
  readonly className?: string;
}

const parse = (value: string): number | null => (/^\d+$/.test(value) ? Number(value) : null);

export function NumberStepper({
  value,
  onChange,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  step = 1,
  decrementLabel,
  incrementLabel,
  id,
  placeholder,
  disabled = false,
  maxLength = 6,
  className,
  onBlur,
  "aria-invalid": invalid,
  "aria-describedby": describedBy,
  "aria-label": ariaLabel,
}: NumberStepperProps) {
  const current = parse(value);
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  const shift = (delta: number) => onChange(String(clamp((current ?? 0) + delta)));

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const deltas: Record<string, number> = {
      ArrowUp: step,
      ArrowDown: -step,
      PageUp: step * 10,
      PageDown: -step * 10,
    };
    const delta = deltas[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    shift(delta);
  };

  const field = (
    <input
      id={id}
      className="ui-number-input"
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      autoComplete="off"
      role="spinbutton"
      aria-valuenow={current ?? undefined}
      aria-valuemin={min}
      aria-valuemax={max === Number.MAX_SAFE_INTEGER ? undefined : max}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      aria-label={ariaLabel}
      placeholder={placeholder}
      maxLength={maxLength}
      disabled={disabled}
      value={value}
      onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value.replace(/\D+/g, ""))}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    />
  );

  if (!decrementLabel || !incrementLabel)
    return <span className={["ui-number", className ?? ""].filter(Boolean).join(" ")}>{field}</span>;

  // Кнопки вне порядка Tab: с клавиатуры шаг — стрелками в поле; палец и диктор их находят.
  // Фокус в поле по нажатию не ставим: на телефоне выехала бы клавиатура
  const button = (label: string, delta: number, icon: "minus" | "plus", off: boolean) => (
    <button
      type="button"
      className="ui-icon-btn"
      tabIndex={-1}
      aria-label={label}
      aria-controls={id}
      disabled={disabled || off}
      onClick={() => shift(delta)}
    >
      <UiIcon name={icon} size={14} />
    </button>
  );

  return (
    <span className={["ui-number", "ui-stepper", className ?? ""].filter(Boolean).join(" ")}>
      {button(decrementLabel, -step, "minus", current !== null && current <= min)}
      {field}
      {button(incrementLabel, step, "plus", current !== null && current >= max)}
    </span>
  );
}
