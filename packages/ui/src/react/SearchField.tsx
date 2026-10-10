/* Поиск вместо системного вида <input type="search">: сам тип остаётся (роль searchbox,
   клавиша «Найти» на клавиатуре телефона), а системный крестик спрятан — у него зона
   нажатия меньше 44px и вид в каждом браузере свой. Свой крестик появляется, когда в поле
   есть текст, чистит его и возвращает фокус в поле.

   Внутри списка с поиском (Combobox) поле — combobox: роль, связь со списком вариантов и
   активный вариант (aria-activedescendant), стрелки и Enter обрабатывает список. */

import { type ChangeEvent, type KeyboardEvent, type Ref, useCallback, useRef } from "react";
import { UiIcon } from "./icons";
import { focusQuietly } from "./overlay";
import { useUiTexts } from "./texts";

export interface SearchFieldProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Имя поля для диктора, если рядом нет видимой подписи */
  readonly "aria-label"?: string;
  readonly "aria-describedby"?: string;
  readonly placeholder?: string;
  readonly id?: string;
  readonly maxLength?: number;
  readonly className?: string;
  /** Поле внутри списка с поиском: id списка вариантов и активного варианта */
  readonly combobox?: { readonly listId: string; readonly activeId?: string | undefined };
  readonly onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  /** Само поле ввода: на него ставят фокус снаружи */
  readonly inputRef?: Ref<HTMLInputElement>;
}

export function SearchField({
  value,
  onChange,
  placeholder,
  id,
  maxLength = 100,
  className,
  combobox,
  onKeyDown,
  inputRef,
  "aria-label": ariaLabel,
  "aria-describedby": describedBy,
}: SearchFieldProps) {
  const texts = useUiTexts();
  const input = useRef<HTMLInputElement | null>(null);
  // Своя ссылка (вернуть фокус после крестика) и ссылка снаружи — на одно поле
  const setInput = useCallback(
    (node: HTMLInputElement | null) => {
      input.current = node;
      if (typeof inputRef === "function") inputRef(node);
      else if (inputRef) inputRef.current = node;
    },
    [inputRef],
  );
  const common = {
    ref: setInput,
    id,
    className: "ui-search-input",
    type: "search",
    enterKeyHint: "search",
    autoComplete: "off",
    value,
    placeholder,
    maxLength,
    onKeyDown,
    onChange: (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
    "aria-label": ariaLabel,
    "aria-describedby": describedBy,
  } as const;
  return (
    <span className={["ui-search", className ?? ""].filter(Boolean).join(" ")}>
      <UiIcon name="search" size={17} className="ui-search-icon" />
      {combobox ? (
        <input
          {...common}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={combobox.listId}
          aria-activedescendant={combobox.activeId}
        />
      ) : (
        <input {...common} />
      )}
      {value ? (
        <button
          type="button"
          className="ui-icon-btn ui-search-clear"
          aria-label={texts.clear}
          onClick={() => {
            onChange("");
            focusQuietly(input.current);
          }}
        >
          <UiIcon name="close" size={12} />
        </button>
      ) : null}
    </span>
  );
}
