/* Причина или комментарий — поле с готовыми вариантами: частые причины чипами под полем
   (t.reasons — по местам: приостановка, отказ по фото, блокировка…). Нажатие вписывает
   причину в поле — её можно поправить или дописать своё; вписанное своё не стирается:
   причина дописывается через «; ». Чип вписанной причины залит, повторное нажатие её убирает.
   Отдельный модуль, а не fields.tsx: его берёт ConfirmForm из ui.tsx — в основную часть
   сборки попадает только он, без телефона, денег и прочих полей форм. */

import { useId } from "react";
import { t } from "./texts";

const SEPARATOR = "; ";

/** Причины в поле: вписанный текст, разобранный по «; » */
function partsOf(text: string): string[] {
  return text
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Вписать готовую причину или убрать её, если она уже в поле */
export function togglePreset(text: string, preset: string): string {
  const parts = partsOf(text);
  if (parts.includes(preset)) return parts.filter((part) => part !== preset).join(SEPARATOR);
  return [...parts, preset].join(SEPARATOR);
}

export interface ReasonFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (text: string) => void;
  /** Готовые причины этого места; нет — только поле */
  readonly presets?: readonly string[] | undefined;
  readonly required?: boolean;
  readonly maxLength?: number;
  /** Строка вместо многострочного поля (причина показать телефон) */
  readonly multiline?: boolean;
  readonly invalid?: boolean;
  readonly describedBy?: string | undefined;
}

export function ReasonField({
  label,
  value,
  onChange,
  presets = [],
  required = false,
  maxLength = 1000,
  multiline = true,
  invalid = false,
  describedBy,
}: ReasonFieldProps) {
  const id = useId();
  const chosen = partsOf(value);
  const common = {
    id,
    className: "input",
    value,
    maxLength,
    required,
    "aria-invalid": invalid || undefined,
    "aria-describedby": describedBy,
  };
  // Поле — сразу под подписью, готовые причины — под полем: на телефоне шторка открывается без
  // клавиатуры, и чипы видны над кнопками
  return (
    <>
      <label htmlFor={id}>{label}</label>
      {multiline ? (
        <textarea {...common} rows={2} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <input
          {...common}
          autoComplete="off"
          enterKeyHint="go"
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {presets.length > 0 ? (
        // biome-ignore lint/a11y/useSemanticElements: группа кнопок-вариантов, а не полей формы
        <div className="reason-chips" role="group" aria-label={t.input.reasonPresets}>
          {presets.map((preset) => (
            <button
              key={preset}
              type="button"
              className="chip reason-chip"
              aria-pressed={chosen.includes(preset)}
              // Вариант не длиннее поля: дописанный к своему тексту не выйдет за предел
              disabled={!chosen.includes(preset) && togglePreset(value, preset).length > maxLength}
              onClick={() => onChange(togglePreset(value, preset))}
            >
              {preset}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}
