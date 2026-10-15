/* Прилипшие панели и фокус (WCAG 2.4.11 — фокус не закрыт). Оболочка приложения отмечает свои
   панели у верхнего и нижнего края — шапку, нижнюю панель разделов, панель действий экрана, —
   набор мерит их высоту (с безопасными зонами, как они нарисованы) и кладёт сумму у края в
   --sticky-t и --sticky-b на <html>. По ним kit.css ставит scroll-padding: Tab и прокрутка к
   полю останавливаются над нижней панелью и под шапкой, а не под ними.

   Панели у одного края складываются (панель действий стоит над нижней панелью разделов).
   Скрытая панель (display: none — клавиатура открыта, раскладка без неё) весит ноль.
   ResizeObserver есть не везде (ловушка №5): без него — пересчёт при смене размера окна.
   Стили — через CSSOM: CSP не пускает style-атрибуты. */

import { type RefObject, useEffect } from "react";

export type StickyEdge = "top" | "bottom";

const VARS: Readonly<Record<StickyEdge, string>> = { top: "--sticky-t", bottom: "--sticky-b" };

const bars = new Map<HTMLElement, StickyEdge>();
const written: Record<StickyEdge, string> = { top: "", bottom: "" };
let observer: ResizeObserver | null = null;
let listening = false;

/** Сумма высот панелей у каждого края → переменные у <html> (пишем только изменившееся) */
function measure(): void {
  const sums: Record<StickyEdge, number> = { top: 0, bottom: 0 };
  for (const [bar, edge] of bars) {
    if (bar.isConnected) sums[edge] += bar.getBoundingClientRect().height;
  }
  const root = document.documentElement;
  for (const edge of ["top", "bottom"] as const) {
    const value = `${Math.ceil(sums[edge])}px`;
    if (written[edge] === value) continue;
    written[edge] = value;
    root.style.setProperty(VARS[edge], value);
  }
}

/**
 * Отметить панель у края: её высота войдёт в --sticky-t или --sticky-b, пока панель не снята.
 * Возвращает «снять». Для React — useStickyBar
 */
export function stickyBar(bar: HTMLElement, edge: StickyEdge): () => void {
  bars.set(bar, edge);
  if (typeof ResizeObserver === "function") {
    observer ??= new ResizeObserver(measure);
    observer.observe(bar);
  } else if (!listening) {
    listening = true;
    window.addEventListener("resize", measure);
  }
  measure();
  return () => {
    bars.delete(bar);
    observer?.unobserve(bar);
    measure();
  };
}

/**
 * Панель оболочки у края экрана: шапка — "top", нижняя панель и панель действий — "bottom".
 * active: false — панель сейчас не прилипает (другая раскладка), её высота не в счёт
 */
export function useStickyBar(
  ref: RefObject<HTMLElement | null>,
  edge: StickyEdge,
  active: boolean = true,
): void {
  useEffect(() => {
    const bar = ref.current;
    if (!active || !bar) return;
    return stickyBar(bar, edge);
  }, [ref, edge, active]);
}
