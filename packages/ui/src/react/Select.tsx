/* Выпадающий список вместо системного <select>: кнопка поля и свой список. На компьютере —
   панель под полем, на телефоне — шторка снизу (узкий экран, см. overlay.tsx).

   Шаблон ARIA — кнопка с aria-haspopup="listbox" и список role="listbox": фокус уходит
   в список, активный вариант — aria-activedescendant. Клавиатура как у системного:
   стрелки, Home/End, PageUp/PageDown, Enter и пробел выбирают, Esc закрывает, Tab
   закрывает и идёт дальше, буквы — поиск по началу подписи. Имя кнопки для диктора —
   подпись поля и текущее значение (aria-labelledby на обе части). */

import { type KeyboardEvent, type ReactNode, useId, useLayoutEffect, useRef, useState } from "react";
import { UiIcon } from "./icons";
import { type CloseReason, focusQuietly, Overlay, type OverlayMode, overlayMode } from "./overlay";

export interface SelectOption<V extends string = string> {
  readonly value: V;
  readonly label: string;
  /** Вторая строка мелким: пояснение к варианту */
  readonly hint?: string;
  readonly disabled?: boolean;
}

export interface SelectProps<V extends string> {
  readonly value: V | null;
  readonly options: readonly SelectOption<V>[];
  readonly onChange: (value: V) => void;
  /** Название поля: вместе со значением — имя кнопки для диктора; заголовок шторки */
  readonly label: string;
  /** Текст, пока ничего не выбрано */
  readonly placeholder?: string;
  /** id кнопки: для <label htmlFor> и фокуса на поле с ошибкой */
  readonly id?: string;
  readonly disabled?: boolean;
  readonly "aria-invalid"?: boolean;
  readonly "aria-describedby"?: string;
  /** field — поле формы во всю ширину; compact — пилюля в строке (сортировка) */
  readonly size?: "field" | "compact";
  /** Иконка слева от значения */
  readonly icon?: ReactNode;
  readonly className?: string;
}

/** Пауза, после которой набранные буквы начинают поиск заново */
const TYPEAHEAD_MS = 700;
const PAGE = 10;

/** Держит вариант в видимой части списка, не трогая прокрутку страницы */
function keepVisible(list: HTMLElement, item: HTMLElement): void {
  const top = item.offsetTop;
  const bottom = top + item.offsetHeight;
  if (top < list.scrollTop) list.scrollTop = top;
  else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
}

export function Select<V extends string>({
  value,
  options,
  onChange,
  label,
  placeholder = "",
  id,
  disabled = false,
  size = "field",
  icon,
  className,
  "aria-invalid": invalid,
  "aria-describedby": describedBy,
}: SelectProps<V>) {
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const base = useId();
  const labelId = `${base}-label`;
  const valueId = `${base}-value`;
  const listId = `${base}-list`;
  const [mode, setMode] = useState<OverlayMode | null>(null);
  const [active, setActive] = useState(-1);
  const refocus = useRef(false);
  const typed = useRef({ text: "", at: 0 });

  const selected = options.findIndex((option) => option.value === value);
  const current = options[selected];
  const open = mode !== null;

  const enabled = (index: number) => options[index] !== undefined && !options[index]?.disabled;
  const firstEnabled = () => options.findIndex((option) => !option.disabled);
  const lastEnabled = () => {
    for (let i = options.length - 1; i >= 0; i--) if (enabled(i)) return i;
    return -1;
  };
  /** Ближайший доступный вариант в направлении dir; нет — остаёмся на месте */
  const step = (from: number, dir: 1 | -1, distance = 1) => {
    let found = from;
    for (let i = from + dir, left = distance; i >= 0 && i < options.length; i += dir) {
      if (!enabled(i)) continue;
      found = i;
      if (--left === 0) break;
    }
    return found < 0 ? firstEnabled() : found;
  };

  /** Поиск по началу подписи; одна и та же буква подряд — по кругу между вариантами на неё */
  const typeahead = (char: string, from: number) => {
    const now = Date.now();
    const text = now - typed.current.at > TYPEAHEAD_MS ? char : typed.current.text + char;
    typed.current = { text, at: now };
    const needle = text.toLocaleLowerCase();
    const repeated = [...needle].every((c) => c === needle[0]);
    const query = repeated ? needle.slice(0, 1) : needle;
    const start = repeated ? from + 1 : Math.max(from, 0);
    for (let k = 0; k < options.length; k++) {
      const i = (((start + k) % options.length) + options.length) % options.length;
      if (enabled(i) && options[i]?.label.toLocaleLowerCase().startsWith(query)) return i;
    }
    return -1;
  };
  const typing = () => Date.now() - typed.current.at <= TYPEAHEAD_MS && typed.current.text !== "";

  const show = (at?: number) => {
    if (disabled || open || firstEnabled() < 0) return;
    setActive(at ?? (enabled(selected) ? selected : firstEnabled()));
    refocus.current = false;
    setMode(overlayMode());
  };

  const hide = (reason: CloseReason) => {
    // Нажали мимо — фокус остаётся там, куда нажали; Tab уже перевёл его сам
    refocus.current = reason !== "outside" && reason !== "tab";
    setMode(null);
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    hide("pick");
    if (option.value !== value) onChange(option.value);
  };

  useLayoutEffect(() => {
    if (!mode || !list.current) return;
    const item = list.current.children[active];
    if (item instanceof HTMLElement) keepVisible(list.current, item);
  }, [active, mode]);

  const onTriggerKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (open || event.ctrlKey || event.metaKey) return;
    const { key } = event;
    let at: number | undefined;
    if (key === "ArrowDown" || key === "ArrowUp") at = undefined;
    else if (key === "Home") at = firstEnabled();
    else if (key === "End") at = lastEnabled();
    else if (key.length === 1 && key !== " " && !event.altKey) {
      const found = typeahead(key, selected);
      at = found >= 0 ? found : undefined;
    } else return;
    event.preventDefault();
    show(at);
  };

  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const { key } = event;
    let next: number;
    if (key === "ArrowDown") next = active < 0 ? firstEnabled() : step(active, 1);
    else if (key === "ArrowUp") next = active < 0 ? lastEnabled() : step(active, -1);
    else if (key === "Home") next = firstEnabled();
    else if (key === "End") next = lastEnabled();
    else if (key === "PageDown") next = step(active, 1, PAGE);
    else if (key === "PageUp") next = step(Math.max(active, 0), -1, PAGE);
    else if (key === "Enter" || (key === " " && !typing())) {
      event.preventDefault();
      choose(active);
      return;
    } else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      next = typeahead(key, active);
      if (next < 0) next = active;
    } else return;
    event.preventDefault();
    setActive(next);
  };

  const classes = ["ui-select", `ui-select-${size}`, open ? "is-open" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <button
        ref={trigger}
        type="button"
        id={id}
        className={classes}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-labelledby={`${labelId} ${valueId}`}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        disabled={disabled}
        onClick={() => (open ? hide("close") : show())}
        onKeyDown={onTriggerKey}
      >
        {icon ? <span className="ui-select-icon">{icon}</span> : null}
        <span className={current ? "ui-select-value" : "ui-select-value is-placeholder"} id={valueId}>
          {current?.label ?? placeholder}
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
          className="ui-pop-list"
          tabCloses
          initialFocus={() => list.current}
          onClose={hide}
          onAfterClose={() => {
            if (refocus.current) focusQuietly(trigger.current);
          }}
        >
          <div
            ref={list}
            id={listId}
            className="ui-listbox"
            role="listbox"
            tabIndex={0}
            aria-labelledby={labelId}
            aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
            onKeyDown={onListKey}
          >
            {options.map((option, index) => (
              // Клавиатура — на списке (aria-activedescendant): вариант не в фокусе, у него мышь и палец
              // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/useFocusableInteractive: фокус и клавиатура — у списка
              <div
                key={option.value}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === selected}
                aria-disabled={option.disabled || undefined}
                className={index === active ? "ui-option is-active" : "ui-option"}
                onClick={() => choose(index)}
                onMouseMove={() => {
                  if (index !== active && enabled(index)) setActive(index);
                }}
              >
                <span className="ui-option-text">
                  {option.label}
                  {option.hint ? <small className="ui-option-hint">{option.hint}</small> : null}
                </span>
                {index === selected ? <UiIcon name="check" size={14} className="ui-option-check" /> : null}
              </div>
            ))}
          </div>
        </Overlay>
      ) : null}
    </>
  );
}
