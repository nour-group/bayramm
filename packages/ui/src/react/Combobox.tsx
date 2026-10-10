/* Список с поиском: кнопка поля — как у Select (подпись и выбранное), в слое — поле поиска и
   варианты, которые подбирает приложение по введённому (запрос к API, с задержкой — у
   приложения). На компьютере — панель у поля, на телефоне — шторка снизу (overlay.tsx).

   Шаблон ARIA: в слое поле поиска — combobox, варианты — listbox; фокус остаётся в поле,
   активный вариант — aria-activedescendant. Стрелки ходят по вариантам, Enter выбирает, Esc
   закрывает и возвращает фокус кнопке, Tab закрывает и идёт дальше по форме. Выбранное
   может не попасть в найденное — его подпись приходит отдельно (valueLabel). «Любой»
   сверху (anyLabel) снимает выбор. */

import { type KeyboardEvent, useId, useLayoutEffect, useRef, useState } from "react";
import { UiIcon } from "./icons";
import { type CloseReason, focusQuietly, Overlay, type OverlayMode, overlayMode } from "./overlay";
import { SearchField } from "./SearchField";
import type { SelectOption } from "./Select";

export interface ComboboxProps<V extends string> {
  readonly value: V | null;
  /** Подпись выбранного: среди найденного его может не быть */
  readonly valueLabel?: string | null;
  /** Варианты по последнему поиску */
  readonly options: readonly SelectOption<V>[];
  /** Введённое в поиск (и "" при открытии): приложение подбирает варианты */
  readonly onSearch: (query: string) => void;
  /** Выбор; null — «Любой» (anyLabel) */
  readonly onChange: (value: V | null) => void;
  /** Название поля: вместе со значением — имя кнопки для диктора; заголовок шторки */
  readonly label: string;
  /** Текст кнопки, пока ничего не выбрано */
  readonly placeholder?: string;
  /** Подсказка в поле поиска: что вводить */
  readonly searchPlaceholder?: string;
  /** Варианты подбираются */
  readonly loading?: boolean;
  readonly loadingText: string;
  /** Ничего не нашлось */
  readonly emptyText: string;
  /** Вариант сверху, снимающий выбор; нет — снять выбор нельзя */
  readonly anyLabel?: string;
  readonly id?: string;
  readonly disabled?: boolean;
  readonly "aria-invalid"?: boolean;
  readonly "aria-describedby"?: string;
  readonly size?: "field" | "compact";
  readonly className?: string;
}

/** Строка списка: вариант или «Любой» (value — null) */
interface Row<V extends string> {
  readonly value: V | null;
  readonly label: string;
  readonly hint?: string | undefined;
  readonly disabled?: boolean | undefined;
}

/** Держит вариант в видимой части списка, не трогая прокрутку страницы */
function keepVisible(list: HTMLElement, item: HTMLElement): void {
  const top = item.offsetTop;
  const bottom = top + item.offsetHeight;
  if (top < list.scrollTop) list.scrollTop = top;
  else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
}

export function Combobox<V extends string>({
  value,
  valueLabel,
  options,
  onSearch,
  onChange,
  label,
  placeholder = "",
  searchPlaceholder,
  loading = false,
  loadingText,
  emptyText,
  anyLabel,
  id,
  disabled = false,
  size = "field",
  className,
  "aria-invalid": invalid,
  "aria-describedby": describedBy,
}: ComboboxProps<V>) {
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const base = useId();
  const labelId = `${base}-label`;
  const valueId = `${base}-value`;
  const listId = `${base}-list`;
  const noteId = `${base}-note`;
  const [mode, setMode] = useState<OverlayMode | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const refocus = useRef(false);
  const open = mode !== null;

  const rows: readonly Row<V>[] = [
    ...(anyLabel === undefined ? [] : [{ value: null, label: anyLabel }]),
    ...options.map((option) => ({ ...option, value: option.value as V | null })),
  ];
  const enabled = (index: number) => rows[index] !== undefined && !rows[index]?.disabled;
  const shown =
    value === null
      ? anyLabel !== undefined
        ? anyLabel
        : null
      : (valueLabel ?? rows.find((r) => r.value === value)?.label ?? value);

  const show = () => {
    if (disabled || open) return;
    setQuery("");
    setActive(-1);
    refocus.current = false;
    onSearch("");
    setMode(overlayMode());
  };

  const hide = (reason: CloseReason) => {
    // Нажали мимо — фокус остаётся там, куда нажали; Tab уже перевёл его сам
    refocus.current = reason !== "outside" && reason !== "tab";
    setMode(null);
  };

  const choose = (index: number) => {
    const row = rows[index];
    if (!row || row.disabled) return;
    hide("pick");
    if (row.value !== value) onChange(row.value);
  };

  const search = (text: string) => {
    setQuery(text);
    setActive(-1);
    onSearch(text);
  };

  /** Следующий доступный вариант в направлении dir; нет — остаёмся */
  const step = (from: number, dir: 1 | -1) => {
    for (let i = from + dir; i >= 0 && i < rows.length; i += dir) if (enabled(i)) return i;
    return from;
  };

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(step(active, 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(active < 0 ? step(rows.length, -1) : step(active, -1));
    } else if (event.key === "Enter") {
      // Enter в поле — выбор, а не отправка формы фильтров
      event.preventDefault();
      if (active >= 0) choose(active);
    }
  };

  useLayoutEffect(() => {
    if (!mode || !list.current || active < 0) return;
    const item = list.current.children[active];
    if (item instanceof HTMLElement) keepVisible(list.current, item);
  }, [active, mode]);

  const classes = ["ui-select", `ui-select-${size}`, "ui-combobox", open ? "is-open" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  const note = loading ? loadingText : options.length === 0 ? emptyText : "";

  return (
    <>
      <button
        ref={trigger}
        type="button"
        id={id}
        className={classes}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${labelId} ${valueId}`}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        disabled={disabled}
        onClick={() => (open ? hide("close") : show())}
        onKeyDown={(event) => {
          if (open || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
          event.preventDefault();
          show();
        }}
      >
        <span className={shown === null ? "ui-select-value is-placeholder" : "ui-select-value"} id={valueId}>
          {shown ?? placeholder}
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
          className="ui-pop-list ui-pop-combo"
          tabCloses
          initialFocus={() => input.current}
          onClose={hide}
          onAfterClose={() => {
            if (refocus.current) focusQuietly(trigger.current);
          }}
        >
          <div className="ui-combo-search">
            <SearchField
              inputRef={input}
              value={query}
              onChange={search}
              placeholder={searchPlaceholder}
              aria-label={label}
              aria-describedby={note ? noteId : undefined}
              combobox={{ listId, activeId: active >= 0 ? `${listId}-${active}` : undefined }}
              onKeyDown={onKey}
            />
          </div>
          <p id={noteId} className="ui-combo-note" aria-live="polite">
            {note}
          </p>
          <div ref={list} id={listId} className="ui-listbox" role="listbox" aria-labelledby={labelId}>
            {rows.map((row, index) => (
              // Клавиатура — у поля поиска (aria-activedescendant): у варианта мышь и палец
              // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/useFocusableInteractive: фокус и клавиатура — у поля поиска
              <div
                key={row.value ?? ""}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={row.value === value}
                aria-disabled={row.disabled || undefined}
                className={["ui-option", index === active ? "is-active" : ""].filter(Boolean).join(" ")}
                onClick={() => choose(index)}
                onMouseMove={() => {
                  if (index !== active && enabled(index)) setActive(index);
                }}
              >
                <span className="ui-option-text">
                  {row.label}
                  {row.hint ? <small className="ui-option-hint">{row.hint}</small> : null}
                </span>
                {row.value === value ? <UiIcon name="check" size={14} className="ui-option-check" /> : null}
              </div>
            ))}
          </div>
        </Overlay>
      ) : null}
    </>
  );
}
