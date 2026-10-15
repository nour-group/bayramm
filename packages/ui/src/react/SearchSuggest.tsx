/* Поиск с подсказками: поле поиска (SearchField) — combobox, под ним — список подсказок
   группами (listbox с group). Подсказки подбирает приложение по введённому (запрос к API, с
   задержкой и отменой — у приложения); Enter без выбранной подсказки — поиск по тексту.

   Шаблон ARIA (APG, combobox со списком): фокус всегда в поле, активная подсказка —
   aria-activedescendant; стрелки ходят по подсказкам всех групп, Enter выбирает активную или
   ищет текст, Esc закрывает список (второй Esc — очищает поле), Tab уходит дальше и закрывает.
   Сколько подсказок — status приложения, вслух вежливо (aria-live polite).

   Список — не модальный слой, а панель прямо под полем: страница под ним живая, как у
   автодополнения. На телефоне панель не уходит под клавиатуру: её высота — до видимой части
   экрана (visualViewport, а в Telegram ещё и --tg-viewport-stable-height), дальше список
   прокручивается внутри. Стили — через CSSOM: CSP не пускает style-атрибуты. */

import {
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { SearchField } from "./SearchField";

export interface SuggestOption {
  /** Уникален во всём списке */
  readonly id: string;
  readonly label: string;
  /** Вторая строка: раздел, район */
  readonly hint?: string;
  /** Рисунок слева (обложка, значок) — для глаз; имя для диктора — label и hint */
  readonly media?: ReactNode;
}

export interface SuggestGroup {
  readonly id: string;
  /** Заголовок группы — видимый и имя группы для диктора */
  readonly label: string;
  readonly options: readonly SuggestOption[];
}

export interface SearchSuggestProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Подсказки по последнему ответу; пусто — списка нет (или только status) */
  readonly groups: readonly SuggestGroup[];
  /** Выбрали подсказку (Enter на активной, нажатие) */
  readonly onPick: (option: SuggestOption, group: SuggestGroup) => void;
  /** Enter без активной подсказки: искать по тексту */
  readonly onSubmit: (value: string) => void;
  /**
   * Что сказать о подсказках: «Нашлось 5», «Ничего не нашлось», «Ищем…». Читается диктором
   * вежливо; в открытом списке без подсказок — видна строкой
   */
  readonly status?: string;
  /** Список открывается с этой длины текста */
  readonly minLength?: number;
  /** Имя поля и списка для диктора */
  readonly label: string;
  readonly placeholder?: string;
  readonly id?: string;
  readonly maxLength?: number;
  readonly inputRef?: Ref<HTMLInputElement>;
  readonly className?: string;
}

/** Отступ панели от поля и от края видимой части экрана, px */
const GAP = 6;
const GUTTER = 8;
/** Ниже этого панель не сжимается: лучше прокрутить страницу, чем список из полстроки */
const MIN_HEIGHT = 132;

/** Нижняя граница видимой части экрана: окно, клавиатура (visualViewport), Telegram */
function visibleBottom(): number {
  let bottom = window.innerHeight || document.documentElement.clientHeight || 0;
  const vv = window.visualViewport;
  if (vv && vv.height > 0) bottom = Math.min(bottom, vv.offsetTop + vv.height);
  if (typeof getComputedStyle === "function") {
    const stable = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--tg-viewport-stable-height"),
    );
    if (stable > 0) bottom = Math.min(bottom, stable);
  }
  return bottom;
}

/** Высота панели — до видимой части экрана под полем */
export function fitSuggest(field: HTMLElement, panel: HTMLElement): void {
  const rect = field.getBoundingClientRect();
  const space = visibleBottom() - rect.bottom - GAP - GUTTER;
  panel.style.maxHeight = `${Math.max(MIN_HEIGHT, Math.floor(space))}px`;
}

/** Держит подсказку в видимой части списка, не трогая прокрутку страницы */
function keepVisible(list: HTMLElement, item: HTMLElement): void {
  const top = item.offsetTop;
  const bottom = top + item.offsetHeight;
  if (top < list.scrollTop) list.scrollTop = top;
  else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
}

export function SearchSuggest({
  value,
  onChange,
  groups,
  onPick,
  onSubmit,
  status = "",
  minLength = 2,
  label,
  placeholder,
  id,
  maxLength,
  inputRef,
  className,
}: SearchSuggestProps) {
  const base = useId();
  const listId = `${base}-list`;
  const statusId = `${base}-status`;
  const wrap = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const items = useRef<(HTMLDivElement | null)[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  const flat = groups.flatMap((group) => group.options.map((option) => ({ option, group })));
  const optionId = (index: number) => `${listId}-${index}`;
  const long = value.trim().length >= minLength;
  const shown = open && long && (flat.length > 0 || status !== "");
  const expanded = shown && flat.length > 0;

  // Подсказки сменились — активной нет (Enter ищет текст, а не прежнюю подсказку)
  const signature = flat.map(({ option }) => option.id).join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: сбрасываем по составу подсказок
  useEffect(() => setActive(-1), [signature]);

  // Панель — до видимой части экрана; клавиатура и смена размера — пересчитать
  useLayoutEffect(() => {
    if (!shown) return;
    const place = () => {
      if (field.current && panel.current) fitSuggest(field.current, panel.current);
    };
    place();
    const vv = window.visualViewport;
    window.addEventListener("resize", place);
    vv?.addEventListener("resize", place);
    vv?.addEventListener("scroll", place);
    return () => {
      window.removeEventListener("resize", place);
      vv?.removeEventListener("resize", place);
      vv?.removeEventListener("scroll", place);
    };
  }, [shown]);

  useLayoutEffect(() => {
    const item = items.current[active];
    if (expanded && panel.current && item) keepVisible(panel.current, item);
  });

  const pick = (index: number) => {
    const entry = flat[index];
    if (!entry) return;
    setOpen(false);
    setActive(-1);
    onPick(entry.option, entry.group);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!long) return;
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (flat.length === 0) return;
      const down = event.key === "ArrowDown";
      setActive((current) => {
        if (current < 0) return down ? 0 : flat.length - 1;
        return (current + (down ? 1 : -1) + flat.length) % flat.length;
      });
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (expanded && active >= 0) pick(active);
      else {
        setOpen(false);
        onSubmit(value);
      }
    } else if (event.key === "Escape" || event.key === "Esc") {
      if (shown) {
        event.preventDefault();
        setOpen(false);
        setActive(-1);
      } else if (value !== "") {
        event.preventDefault();
        onChange("");
      }
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  // Фокус ушёл из поля и списка — список закрывается
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next && wrap.current?.contains(next)) return;
    setOpen(false);
    setActive(-1);
  };

  let index = -1;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: обёртка только ловит уход фокуса из поля и списка
    <div
      ref={wrap}
      className={["ui-suggest", shown ? "is-open" : "", className ?? ""].filter(Boolean).join(" ")}
      onBlur={onBlur}
    >
      <span ref={field} className="ui-suggest-field">
        <SearchField
          id={id}
          inputRef={inputRef}
          value={value}
          maxLength={maxLength}
          placeholder={placeholder}
          aria-label={label}
          aria-describedby={statusId}
          combobox={{
            listId,
            activeId: expanded && active >= 0 ? optionId(active) : undefined,
            expanded,
          }}
          onChange={(next) => {
            onChange(next);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
      </span>
      {/* Сколько подсказок — вслух, пока человек печатает; видимый текст — в панели */}
      <span id={statusId} className="ui-sr-only" aria-live="polite">
        {long && open ? status : ""}
      </span>
      {shown ? (
        <div ref={panel} className="ui-suggest-pop">
          {flat.length === 0 ? (
            <p className="ui-suggest-note" aria-hidden="true">
              {status}
            </p>
          ) : (
            <div id={listId} className="ui-suggest-list" role="listbox" aria-label={label}>
              {groups.map((group) =>
                group.options.length === 0 ? null : (
                  // biome-ignore lint/a11y/useSemanticElements: группа вариантов внутри listbox (ARIA), не группа полей формы
                  <div
                    key={group.id}
                    className="ui-suggest-group"
                    role="group"
                    aria-labelledby={`${listId}-${group.id}`}
                  >
                    <p className="ui-suggest-head" id={`${listId}-${group.id}`} role="presentation">
                      {group.label}
                    </p>
                    {group.options.map((option) => {
                      index += 1;
                      const at = index;
                      return (
                        // Клавиатура — у поля (aria-activedescendant): у подсказки мышь и палец.
                        // mousedown не уводит фокус из поля — список не закрывается до выбора
                        // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/useFocusableInteractive: фокус и клавиатура — у поля
                        <div
                          key={option.id}
                          ref={(node) => {
                            items.current[at] = node;
                          }}
                          id={optionId(at)}
                          role="option"
                          aria-selected={at === active}
                          className={["ui-option", "ui-suggest-option", at === active ? "is-active" : ""]
                            .filter(Boolean)
                            .join(" ")}
                          onMouseDown={(event) => event.preventDefault()}
                          onMouseMove={() => {
                            if (at !== active) setActive(at);
                          }}
                          onClick={() => pick(at)}
                        >
                          {option.media ? (
                            <span className="ui-suggest-media" aria-hidden="true">
                              {option.media}
                            </span>
                          ) : null}
                          <span className="ui-option-text">
                            {option.label}
                            {option.hint ? <small className="ui-option-hint">{option.hint}</small> : null}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ),
              )}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
