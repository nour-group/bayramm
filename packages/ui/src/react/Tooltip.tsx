/* Подсказка вместо атрибута title: системная всплывает только под мышью, с задержкой,
   в чужом оформлении, а пальцу и клавиатуре недоступна. Здесь — пузырь в цветах темы:
   под мышью (только у настоящей мыши, не после касания) и при фокусе с клавиатуры,
   Esc прячет, на сам пузырь можно навести мышь (WCAG 1.4.13). Текст подсказки
   дополнительно связан с элементом через aria-describedby — диктор прочтёт его всегда.
   Подсказка — только дополнение: без неё элемент обязан быть понятен. */

import {
  type FocusEvent,
  type PointerEvent,
  type ReactNode,
  type RefCallback,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { surroundings } from "./overlay";

export interface TooltipTriggerProps {
  readonly ref: RefCallback<HTMLElement>;
  readonly "aria-describedby": string;
  readonly onPointerEnter: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerLeave: () => void;
  readonly onFocus: (event: FocusEvent<HTMLElement>) => void;
  readonly onBlur: () => void;
}

export interface TooltipProps {
  readonly text: string;
  /** Элемент, к которому подсказка: получает ref, обработчики и aria-describedby */
  readonly children: (trigger: TooltipTriggerProps) => ReactNode;
}

const SHOW_MS = 400;
const HIDE_MS = 120;

/** Фокус с клавиатуры, а не от нажатия мышью; где :focus-visible нет — не показываем */
function focusVisible(element: Element): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return false;
  }
}

export function Tooltip({ text, children }: TooltipProps) {
  const id = useId();
  const anchor = useRef<HTMLElement | null>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const later = useCallback((next: boolean, ms: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setVisible(next), ms);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);

  // Esc прячет подсказку, где бы ни был фокус
  useEffect(() => {
    if (!visible) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Esc") setVisible(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [visible]);

  // Над элементом по центру; сверху тесно — снизу; в пределах экрана с полями 8px
  useLayoutEffect(() => {
    const target = anchor.current;
    const tip = bubble.current;
    if (!visible || !target || !tip) return;
    const rect = target.getBoundingClientRect();
    const width = document.documentElement.clientWidth || window.innerWidth;
    const above = rect.top - tip.offsetHeight - 8 >= 8;
    const left = Math.min(
      Math.max(8, rect.left + rect.width / 2 - tip.offsetWidth / 2),
      Math.max(8, width - tip.offsetWidth - 8),
    );
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(above ? rect.top - tip.offsetHeight - 8 : rect.bottom + 8)}px`;
  }, [visible]);

  const trigger: TooltipTriggerProps = {
    ref: (element) => {
      anchor.current = element;
    },
    "aria-describedby": id,
    onPointerEnter: (event) => {
      if (event.pointerType === "mouse") later(true, SHOW_MS);
    },
    onPointerLeave: () => later(false, HIDE_MS),
    onFocus: (event) => {
      if (focusVisible(event.currentTarget)) later(true, 0);
    },
    onBlur: () => later(false, 0),
  };

  const around = visible ? surroundings(anchor.current) : {};

  return (
    <>
      {children(trigger)}
      <span id={id} hidden>
        {text}
      </span>
      {visible
        ? createPortal(
            // Текст уже связан через aria-describedby — пузырь для глаз, диктору не дублируем
            <span
              ref={bubble}
              className="ui-tooltip"
              aria-hidden="true"
              data-theme={around.theme}
              lang={around.lang}
              onPointerEnter={() => clearTimeout(timer.current)}
              onPointerLeave={() => later(false, HIDE_MS)}
            >
              {text}
            </span>,
            document.body,
          )
        : null}
    </>
  );
}
