/* Поле даты вместо <input type="date">: кнопка поля и свой календарь. На компьютере —
   панель под полем, на телефоне — шторка снизу. Выбор дня закрывает панель и возвращает
   фокус полю (без прокрутки страницы). Системного календаря нет нигде: он не умеет
   показывать занятые дни и выглядит по-разному в каждом браузере. */

import { type ReactNode, useId, useRef, useState } from "react";
import { Calendar, type CalendarTexts } from "./Calendar";
import { UiIcon } from "./icons";
import { type CloseReason, focusQuietly, Overlay, type OverlayMode, overlayMode } from "./overlay";

export interface DateFieldProps {
  readonly value: string | null;
  readonly onChange: (date: string | null) => void;
  readonly min: string;
  readonly max: string;
  readonly busy?: ReadonlySet<string>;
  /** Название поля: имя кнопки для диктора (вместе со значением), заголовок шторки */
  readonly label: string;
  /** Текст, пока дата не выбрана */
  readonly placeholder: string;
  /** Как показать выбранную дату в поле: «15 окт, чт» */
  readonly format: (date: string) => string;
  readonly texts: CalendarTexts;
  /** Кнопка «любая дата» под календарём: сбрасывает выбор */
  readonly clearLabel?: string;
  /** Какой месяц открыть без выбранной даты; по умолчанию — месяц min */
  readonly defaultMonth?: string;
  /** Легенда «свободно · занято» под календарём (в фильтре дат не нужна) */
  readonly legend?: boolean;
  readonly id?: string;
  readonly disabled?: boolean;
  readonly "aria-invalid"?: boolean;
  readonly "aria-describedby"?: string;
  /** Иконка слева; по умолчанию — календарь */
  readonly icon?: ReactNode;
  readonly className?: string;
}

export function DateField({
  value,
  onChange,
  min,
  max,
  busy,
  label,
  placeholder,
  format,
  texts,
  clearLabel,
  defaultMonth,
  legend = true,
  id,
  disabled = false,
  icon,
  className,
  "aria-invalid": invalid,
  "aria-describedby": describedBy,
}: DateFieldProps) {
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const base = useId();
  const labelId = `${base}-label`;
  const valueId = `${base}-value`;
  const [mode, setMode] = useState<OverlayMode | null>(null);
  const refocus = useRef(false);
  const open = mode !== null;

  const hide = (reason: CloseReason) => {
    refocus.current = reason !== "outside" && reason !== "tab";
    setMode(null);
  };
  const pick = (date: string | null) => {
    hide("pick");
    if (date !== value) onChange(date);
  };

  const classes = ["ui-select", "ui-select-field", "ui-date", value ? "has-value" : "", open ? "is-open" : ""]
    .concat(className ?? "")
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <button
        ref={trigger}
        type="button"
        id={id}
        className={classes}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-labelledby={`${labelId} ${valueId}`}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        disabled={disabled}
        onClick={() => {
          if (open) return hide("close");
          refocus.current = false;
          setMode(overlayMode());
        }}
      >
        <span className="ui-select-icon">{icon ?? <UiIcon name="calendar" size={17} />}</span>
        <span className={value ? "ui-select-value" : "ui-select-value is-placeholder"} id={valueId}>
          {value ? format(value) : placeholder}
        </span>
        <UiIcon name="caret" size={14} className="ui-select-caret" />
      </button>
      <span id={labelId} hidden>
        {label}
      </span>
      {mode ? (
        <Overlay
          mode={mode}
          anchor={trigger}
          title={label}
          popoverRole="dialog"
          className="ui-pop-date"
          initialFocus={() =>
            panel.current?.querySelector<HTMLElement>('.ui-cal-day[tabindex="0"]') ?? panel.current
          }
          onClose={hide}
          onAfterClose={() => {
            if (refocus.current) focusQuietly(trigger.current);
          }}
        >
          <div ref={panel} className="ui-date-panel">
            <Calendar
              min={min}
              max={max}
              busy={busy}
              selected={value}
              onSelect={pick}
              label={label}
              texts={texts}
              legend={legend}
              defaultMonth={defaultMonth}
            />
            {clearLabel ? (
              <div className="ui-date-actions">
                <button type="button" className="ui-btn ui-btn-secondary" onClick={() => pick(null)}>
                  {clearLabel}
                </button>
              </div>
            ) : null}
          </div>
        </Overlay>
      ) : null}
    </>
  );
}
