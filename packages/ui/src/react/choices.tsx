/* Галочка, переключатель и группа вариантов. Под рисунком — настоящий <input>, скрытый
   визуально, но не для диктора и клавиатуры: пробел, стрелки в группе, связь с подписью,
   автозаполнение и отправка формы работают как у системных. Своё — только рисунок.
   Зона нажатия — вся строка с подписью, не меньше 44px. */

import { type ChangeEvent, type ReactNode, useId } from "react";
import { UiIcon } from "./icons";

interface CheckProps {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  /** Подпись справа: текст или разметка (ссылка на текст согласия — рядом, не внутри) */
  readonly children: ReactNode;
  readonly id?: string;
  readonly disabled?: boolean;
  readonly "aria-invalid"?: boolean;
  readonly "aria-describedby"?: string;
  readonly className?: string;
}

function Check({
  kind,
  checked,
  onChange,
  children,
  id,
  disabled = false,
  className,
  "aria-invalid": invalid,
  "aria-describedby": describedBy,
}: CheckProps & { kind: "check" | "switch" }) {
  const change = (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.checked);
  return (
    <label
      className={[`ui-${kind}`, disabled ? "is-disabled" : "", className ?? ""].filter(Boolean).join(" ")}
    >
      <input
        id={id}
        className="ui-native"
        type="checkbox"
        role={kind === "switch" ? "switch" : undefined}
        checked={checked}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={change}
      />
      {kind === "check" ? (
        <span className="ui-check-box" aria-hidden="true">
          <UiIcon name="check" size={14} />
        </span>
      ) : (
        <span className="ui-switch-track" aria-hidden="true">
          <span className="ui-switch-thumb" />
        </span>
      )}
      <span className={`ui-${kind}-label`}>{children}</span>
    </label>
  );
}

/** Галочка. Согласия — только ею и только не отмеченной по умолчанию (правило продукта) */
export function Checkbox(props: CheckProps) {
  return <Check kind="check" {...props} />;
}

/** Переключатель «вкл/выкл» для настроек, действующих сразу (role="switch") */
export function Switch(props: CheckProps) {
  return <Check kind="switch" {...props} />;
}

export interface RadioOption<V extends string> {
  readonly value: V;
  readonly label: string;
  readonly hint?: string;
  readonly disabled?: boolean;
}

export interface RadioGroupProps<V extends string> {
  readonly value: V | null;
  readonly options: readonly RadioOption<V>[];
  readonly onChange: (value: V) => void;
  /**
   * pill — пилюли в строку (повод, бюджет); row — строки списком (причина отказа);
   * segmented — сегменты одной дорожки (два–четыре коротких варианта)
   */
  readonly variant?: "pill" | "row" | "segmented";
  /** Имя группы для диктора, если она не внутри <fieldset> с <legend> */
  readonly label?: string;
  readonly "aria-labelledby"?: string;
  /** id первого варианта: на него ставят фокус, когда в группе ошибка */
  readonly id?: string;
  readonly name?: string;
  readonly disabled?: boolean;
  readonly "aria-invalid"?: boolean;
  readonly "aria-describedby"?: string;
  readonly className?: string;
}

/**
 * Группа вариантов «один из». Настоящие радиокнопки с общим name: стрелки переводят выбор,
 * Tab попадает в группу один раз. Группа без <fieldset> вокруг получает role="radiogroup"
 */
export function RadioGroup<V extends string>({
  value,
  options,
  onChange,
  variant = "pill",
  label,
  "aria-labelledby": labelledBy,
  id,
  name,
  disabled = false,
  className,
  "aria-invalid": invalid,
  "aria-describedby": describedBy,
}: RadioGroupProps<V>) {
  const auto = useId();
  const group = name ?? auto;
  const named = Boolean(label || labelledBy);
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-* ставятся только вместе с role="radiogroup"
    <div
      className={["ui-radios", `ui-radios-${variant}`, className ?? ""].filter(Boolean).join(" ")}
      role={named ? "radiogroup" : undefined}
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      aria-invalid={named && invalid ? true : undefined}
      aria-describedby={named ? describedBy : undefined}
    >
      {options.map((option, index) => {
        const on = option.value === value;
        const off = disabled || option.disabled === true;
        return (
          <label
            key={option.value}
            className={["ui-radio", on ? "is-on" : "", off ? "is-disabled" : ""].filter(Boolean).join(" ")}
          >
            <input
              id={index === 0 ? id : undefined}
              className="ui-native"
              type="radio"
              name={group}
              value={option.value}
              checked={on}
              disabled={off}
              aria-invalid={!named && invalid ? true : undefined}
              aria-describedby={!named ? describedBy : undefined}
              onChange={() => onChange(option.value)}
            />
            {variant === "row" ? <span className="ui-radio-dot" aria-hidden="true" /> : null}
            <span className="ui-radio-label">
              {option.label}
              {option.hint ? <small className="ui-radio-hint">{option.hint}</small> : null}
            </span>
          </label>
        );
      })}
    </div>
  );
}
