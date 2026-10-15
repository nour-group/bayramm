/* Уведомления вместо alert(): короткий текст внизу экрана над безопасной зоной, не
   блокирует страницу. Живые области существуют заранее и пустые — так диктор замечает
   новое сообщение: обычное — role="status", ошибка — role="alert". Обычное исчезает само,
   ошибка висит, пока её не закроют.

   Тот же текст ещё раз (два сохранения подряд) — не второе уведомление стопкой, а прежнее
   заново: срок отсчитывается сначала. У уведомления может быть одно действие («Отменить»):
   пока на нём палец, мышь или фокус, оно не исчезает (WCAG 2.2.1 — время на ответ). */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { UiIcon } from "./icons";
import { useUiTexts } from "./texts";

export type ToastTone = "info" | "success" | "error";

export interface ToastAction {
  /** Подпись кнопки: «Отменить» */
  readonly label: string;
  /** Нажали — уведомление закрывается, затем выполняется действие */
  readonly onClick: () => void;
}

export interface ToastOptions {
  readonly tone?: ToastTone;
  /** Сколько висит, мс; у ошибки по умолчанию — пока не закроют */
  readonly duration?: number;
  /** Одно действие в уведомлении: «Отменить» */
  readonly action?: ToastAction;
}

/** Показать уведомление; возвращает «убрать его» (например, когда действие уже не нужно) */
type Show = (text: string, options?: ToastOptions) => () => void;

const ToastContext = createContext<Show | null>(null);

interface Item {
  readonly id: number;
  readonly text: string;
  readonly tone: ToastTone;
  readonly ms: number;
  readonly action?: ToastAction;
}

/** Сколько сообщений на экране одновременно: старые уходят */
const MAX_VISIBLE = 3;
const DEFAULT_MS = 5000;

export interface ToastProviderProps {
  readonly children: ReactNode;
  /**
   * Отступ снизу над безопасной зоной, px: над нижней панелью вкладок — её высота. "bars" — над
   * прилипшими панелями низа, какие есть сейчас (--sticky-b, их отмечает useStickyBar)
   */
  readonly offset?: number | "bars";
}

export function ToastProvider({ children, offset = 16 }: ToastProviderProps) {
  const texts = useUiTexts();
  const [items, setItems] = useState<readonly Item[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const stop = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const dismiss = useCallback(
    (id: number) => {
      stop(id);
      setItems((prev) => prev.filter((item) => item.id !== id));
    },
    [stop],
  );

  const start = useCallback(
    (id: number, ms: number) => {
      stop(id);
      if (ms > 0)
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), ms),
        );
    },
    [stop, dismiss],
  );

  const show = useCallback<Show>(
    (text, { tone = "info", duration, action } = {}) => {
      const id = ++seq.current;
      const ms = duration ?? (tone === "error" ? 0 : DEFAULT_MS);
      setItems((prev) => {
        // Тот же текст уже на экране — он уходит, новое встаёт последним: одно, а не стопка
        for (const item of prev) if (item.text === text && item.tone === tone) stop(item.id);
        const rest = prev.filter((item) => item.text !== text || item.tone !== tone);
        return [...rest, { id, text, tone, ms, ...(action ? { action } : {}) }].slice(-MAX_VISIBLE);
      });
      start(id, ms);
      return () => dismiss(id);
    },
    [start, stop, dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const bottom = useMemo(
    () => ({
      bottom:
        offset === "bars"
          ? "max(calc(var(--sticky-b) + 12px), calc(16px + var(--pad-b)))"
          : `calc(${offset}px + var(--pad-b))`,
    }),
    [offset],
  );
  const render = (list: readonly Item[]) =>
    list.map((item) => (
      // biome-ignore lint/a11y/noStaticElementInteractions: наведение и фокус только держат уведомление на экране
      <div
        key={item.id}
        className={`ui-toast ui-toast-${item.tone}`}
        onMouseEnter={() => stop(item.id)}
        onMouseLeave={() => start(item.id, item.ms)}
        onFocus={() => stop(item.id)}
        onBlur={() => start(item.id, item.ms)}
      >
        <p className="ui-toast-text">{item.text}</p>
        {item.action ? (
          <button
            type="button"
            className="ui-toast-action"
            onClick={() => {
              dismiss(item.id);
              item.action?.onClick();
            }}
          >
            {item.action.label}
          </button>
        ) : null}
        <button
          type="button"
          className="ui-icon-btn"
          aria-label={texts.close}
          onClick={() => dismiss(item.id)}
        >
          <UiIcon name="close" size={12} />
        </button>
      </div>
    ));

  return (
    <ToastContext.Provider value={show}>
      {children}
      {createPortal(
        <div className="ui-live ui-toasts" style={bottom}>
          <div role="status" className="ui-toast-region">
            {render(items.filter((item) => item.tone !== "error"))}
          </div>
          <div role="alert" className="ui-toast-region">
            {render(items.filter((item) => item.tone === "error"))}
          </div>
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

/** Показать уведомление: toast("Сохранено"), toast("Не удалось", { tone: "error" }) */
export function useToast(): Show {
  const show = useContext(ToastContext);
  if (!show) throw new Error("@bayramm/ui/react: нет ToastProvider над компонентом");
  return show;
}
