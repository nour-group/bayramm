/* Слой поверх страницы для выпадающих списков и календаря: на компьютере — панель у поля,
   на телефоне — шторка снизу. Общие кирпичи и для диалога: портал с темой и языком поля,
   inert для страницы под модальным слоем, ловушка Tab, фокус без прокрутки.

   Ловушки из CLAUDE.md, которые здесь закрыты:
   №3 — фокус только focus({ preventScroll: true }), возврат фокуса — после того, как
        страница перестала быть inert, а не посреди закрытия;
   №5 — requestAnimationFrame, inert и closest проверяются, pointer-событий не ждём:
        mousedown и touchstart есть и в старых вебвью Android. */

import {
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { UiIcon } from "./icons";
import { useUiTexts } from "./texts";

/** Уже этого — телефон: список и календарь открываются шторкой снизу */
export const SHEET_BELOW = 560;

export type OverlayMode = "popover" | "sheet";
export type CloseReason = "escape" | "outside" | "close" | "tab" | "pick";

export function overlayMode(): OverlayMode {
  const width = window.innerWidth || document.documentElement.clientWidth || 0;
  return width > 0 && width < SHEET_BELOW ? "sheet" : "popover";
}

/** Фокус без прокрутки страницы и контейнера (ловушка №3) */
export function focusQuietly(element: HTMLElement | null | undefined): void {
  element?.focus({ preventScroll: true });
}

const FOCUSABLE =
  'button, [href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';

export function focusables(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => element.tabIndex >= 0 && !element.hasAttribute("disabled") && !element.closest("[inert]"),
  );
}

/** Tab и Shift+Tab ходят по кругу внутри контейнера */
export function trapTab(event: KeyboardEvent, container: HTMLElement | null): void {
  if (!container) return;
  event.stopPropagation();
  const items = focusables(container);
  const first = items[0];
  const last = items[items.length - 1];
  if (!first || !last) {
    event.preventDefault();
    return;
  }
  const index = items.indexOf(document.activeElement as HTMLElement);
  if (index === -1 || (event.shiftKey && index === 0) || (!event.shiftKey && index === items.length - 1)) {
    event.preventDefault();
    focusQuietly(event.shiftKey ? last : first);
  }
}

/** Тема и язык берутся у поля: портал в body иначе потерял бы премиум-тему и lang */
export function surroundings(anchor: HTMLElement | null): { theme?: string; lang?: string } {
  if (!anchor || typeof anchor.closest !== "function") return {};
  return {
    theme: anchor.closest("[data-theme]")?.getAttribute("data-theme") ?? undefined,
    lang: anchor.closest("[lang]")?.getAttribute("lang") || undefined,
  };
}

function restoreAttribute(element: Element, name: string, value: string | null): void {
  if (value === null) element.removeAttribute(name);
  else element.setAttribute(name, value);
}

/**
 * Модальный слой: остальное содержимое body — inert и скрыто от диктора; lock — страница
 * ещё и не прокручивается (шторка, диалог). Где inert не поддержан, остаётся aria-hidden
 * и ловушка Tab. Живые области уведомлений (.ui-live) не трогаем — их должно быть слышно.
 * Возвращает release: снять всё сразу, не дожидаясь закрытия (Tab из списка)
 */
export function useModal(layer: RefObject<HTMLElement | null>, active: boolean, lock = true): () => void {
  const release = useRef<(() => void) | null>(null);
  useEffect(() => {
    const node = layer.current;
    if (!active || !node) return;
    const undo: (() => void)[] = [];
    for (const element of [...document.body.children]) {
      if (element === node || !(element instanceof HTMLElement) || element.classList.contains("ui-live"))
        continue;
      const inert = element.getAttribute("inert");
      const hidden = element.getAttribute("aria-hidden");
      element.setAttribute("inert", "");
      element.setAttribute("aria-hidden", "true");
      undo.push(() => {
        restoreAttribute(element, "inert", inert);
        restoreAttribute(element, "aria-hidden", hidden);
      });
    }
    const root = document.documentElement;
    const locked = !lock || root.classList.contains("ui-lock");
    if (lock) root.classList.add("ui-lock");
    let done = false;
    const restore = () => {
      if (done) return;
      done = true;
      for (const step of undo.reverse()) step();
      if (!locked) root.classList.remove("ui-lock");
    };
    release.current = restore;
    return restore;
  }, [active, layer, lock]);
  return useCallback(() => release.current?.(), []);
}

/** Точка нажатия внутри элемента: у inert-страницы событие приходит не ему, а body */
function pressedOn(element: HTMLElement | null, event: Event): boolean {
  if (!element) return false;
  const point = "touches" in event ? (event as TouchEvent).touches[0] : (event as MouseEvent);
  const rect = element.getBoundingClientRect();
  if (!point || rect.width === 0 || rect.height === 0) return false;
  return (
    point.clientX >= rect.left &&
    point.clientX <= rect.right &&
    point.clientY >= rect.top &&
    point.clientY <= rect.bottom
  );
}

/**
 * Место панели у поля: снизу, а если там тесно — сверху; по ширине не уже поля и не
 * шире экрана без полей по 8px. Стили — через CSSOM: CSP не пускает style-атрибуты.
 */
export function placePopover(anchor: HTMLElement, panel: HTMLElement): void {
  const GAP = 6;
  const GUTTER = 8;
  const rect = anchor.getBoundingClientRect();
  const width = document.documentElement.clientWidth || window.innerWidth;
  const height = window.innerHeight || document.documentElement.clientHeight;
  const below = height - rect.bottom - GAP - GUTTER;
  const above = rect.top - GAP - GUTTER;
  panel.style.minWidth = `${Math.round(Math.min(rect.width, width - 2 * GUTTER))}px`;
  panel.style.maxWidth = `${Math.round(width - 2 * GUTTER)}px`;
  const natural = panel.scrollHeight;
  const down = below >= Math.min(natural, 240) || below >= above;
  panel.style.maxHeight = `${Math.max(160, Math.floor(down ? below : above))}px`;
  panel.style.top = down ? `${Math.round(rect.bottom + GAP)}px` : "auto";
  panel.style.bottom = down ? "auto" : `${Math.round(height - rect.top + GAP)}px`;
  const left = Math.min(Math.max(GUTTER, rect.left), Math.max(GUTTER, width - panel.offsetWidth - GUTTER));
  panel.style.left = `${Math.round(left)}px`;
}

interface OverlayProps {
  readonly mode: OverlayMode;
  /** Поле, у которого открыт слой: от него позиция, тема и язык */
  readonly anchor: RefObject<HTMLElement | null>;
  /** Заголовок шторки; у панели-диалога — её имя для диктора */
  readonly title: string;
  readonly onClose: (reason: CloseReason) => void;
  /** Куда поставить фокус при открытии */
  readonly initialFocus: () => HTMLElement | null;
  /** После закрытия, когда страница уже не inert: вернуть фокус полю */
  readonly onAfterClose: () => void;
  /** Панель у поля — диалог (календарь); у списка роль задаёт сам список */
  readonly popoverRole?: "dialog";
  /** Tab в панели у поля закрывает её и идёт дальше по форме (выпадающий список) */
  readonly tabCloses?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}

export function Overlay({
  mode,
  anchor,
  title,
  onClose,
  initialFocus,
  onAfterClose,
  popoverRole,
  tabCloses = false,
  className = "",
  children,
}: OverlayProps) {
  const texts = useUiTexts();
  const layer = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [around] = useState(() => surroundings(anchor.current));
  const close = useRef(onClose);
  close.current = onClose;
  const after = useRef(onAfterClose);
  after.current = onAfterClose;
  const first = useRef(initialFocus);

  // Открытый список или календарь — как системный: страница под ним inert (нажатие мимо
  // только закрывает, диктор не уходит на страницу); шторка ещё и не даёт её прокручивать
  const release = useModal(layer, true, mode === "sheet");
  // После снятия inert (эффект выше снимается раньше): теперь фокус можно вернуть
  useEffect(() => () => after.current(), []);

  useLayoutEffect(() => {
    focusQuietly(first.current() ?? panel.current);
  }, []);

  // Панель у поля: держится у него при прокрутке и смене размера окна
  useLayoutEffect(() => {
    if (mode !== "popover") return;
    const place = () => {
      if (anchor.current && panel.current) placePopover(anchor.current, panel.current);
    };
    place();
    let frame = 0;
    const schedule = (event: Event) => {
      if (event.type === "scroll" && panel.current?.contains(event.target as Node)) return;
      if (frame || typeof requestAnimationFrame !== "function") return place();
      frame = requestAnimationFrame(() => {
        frame = 0;
        place();
      });
    };
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [mode, anchor]);

  // Нажатие мимо панели и поля закрывает панель; у шторки для этого подложка
  useEffect(() => {
    if (mode !== "popover") return;
    const onPress = (event: Event) => {
      const target = event.target as Node | null;
      if (!target || layer.current?.contains(target) || anchor.current?.contains(target)) return;
      // Нажали на само поле (оно inert, событие у body) — закрыть и вернуть фокус полю
      close.current(pressedOn(anchor.current, event) ? "close" : "outside");
    };
    document.addEventListener("mousedown", onPress, true);
    document.addEventListener("touchstart", onPress, { capture: true, passive: true });
    return () => {
      document.removeEventListener("mousedown", onPress, true);
      document.removeEventListener("touchstart", onPress, { capture: true });
    };
  }, [mode, anchor]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" || event.key === "Esc") {
      event.preventDefault();
      event.stopPropagation();
      close.current("escape");
      return;
    }
    if (event.key !== "Tab") return;
    if (mode === "popover" && tabCloses) {
      // Фокус — на поле сразу, до действия Tab по умолчанию: оно уведёт на следующее поле.
      // Для этого страница перестаёт быть inert тоже сразу
      event.stopPropagation();
      release();
      focusQuietly(anchor.current);
      close.current("tab");
      return;
    }
    trapTab(event, panel.current);
  };

  // Фокус ушёл из панели в другое место страницы (диктор, мышь) — панель не висит
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    if (mode !== "popover" || !next) return;
    if (layer.current?.contains(next) || anchor.current?.contains(next)) return;
    close.current("outside");
  };

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: слой только ловит всплывающие Esc и Tab своих контролов
    <div
      ref={layer}
      className="ui-layer"
      data-theme={around.theme}
      lang={around.lang}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    >
      {mode === "sheet" ? (
        <>
          {/* Подложка — для пальца и мыши; с клавиатуры закрывают Esc и крестик */}
          <div className="ui-scrim" aria-hidden="true" onClick={() => close.current("close")} />
          <div
            ref={panel}
            className={`ui-sheet ${className}`.trim()}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
          >
            <span className="ui-sheet-grab" aria-hidden="true" />
            <div className="ui-sheet-head">
              <p className="ui-sheet-title" id={titleId}>
                {title}
              </p>
              <button
                type="button"
                className="ui-icon-btn"
                aria-label={texts.close}
                onClick={() => close.current("close")}
              >
                <UiIcon name="close" size={14} />
              </button>
            </div>
            <div className="ui-sheet-body">{children}</div>
          </div>
        </>
      ) : (
        // biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-label только вместе с role="dialog"
        <div
          ref={panel}
          className={`ui-pop ${className}`.trim()}
          role={popoverRole}
          aria-label={popoverRole ? title : undefined}
        >
          {children}
        </div>
      )}
    </div>,
    document.body,
  );
}
