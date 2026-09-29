/* Поиск вместо системного вида <input type="search">: сам тип остаётся (роль searchbox,
   клавиша «Найти» на клавиатуре телефона), а системный крестик спрятан — у него зона
   нажатия меньше 44px и вид в каждом браузере свой. Свой крестик появляется, когда в поле
   есть текст, чистит его и возвращает фокус в поле. */

import { type ChangeEvent, useRef } from "react";
import { UiIcon } from "./icons";
import { focusQuietly } from "./overlay";
import { useUiTexts } from "./texts";

export interface SearchFieldProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Имя поля для диктора, если рядом нет видимой подписи */
  readonly "aria-label"?: string;
  readonly placeholder?: string;
  readonly id?: string;
  readonly maxLength?: number;
  readonly className?: string;
}

export function SearchField({
  value,
  onChange,
  placeholder,
  id,
  maxLength = 100,
  className,
  "aria-label": ariaLabel,
}: SearchFieldProps) {
  const texts = useUiTexts();
  const input = useRef<HTMLInputElement>(null);
  return (
    <span className={["ui-search", className ?? ""].filter(Boolean).join(" ")}>
      <UiIcon name="search" size={17} className="ui-search-icon" />
      <input
        ref={input}
        id={id}
        className="ui-search-input"
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        maxLength={maxLength}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
      />
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
