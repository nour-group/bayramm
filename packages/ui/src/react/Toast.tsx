/* Уведомления вместо alert(): короткий текст внизу экрана над безопасной зоной, не
   блокирует страницу. Живые области существуют заранее и пустые — так диктор замечает
   новое сообщение: обычное — role="status", ошибка — role="alert". Обычное исчезает само,
   ошибка висит, пока её не закроют. */

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

export interface ToastOptions {
  readonly tone?: ToastTone;
  /** Сколько висит, мс; у ошибки по умолчанию — пока не закроют */
  readonly duration?: number;
}

type Show = (text: string, options?: ToastOptions) => void;

const ToastContext = createContext<Show | null>(null);

interface Item {
  readonly id: number;
  readonly text: string;
  readonly tone: ToastTone;
}

/** Сколько сообщений на экране одновременно: старые уходят */
const MAX_VISIBLE = 3;
const DEFAULT_MS = 5000;

export interface ToastProviderProps {
  readonly children: ReactNode;
  /** Отступ снизу над безопасной зоной, px: над нижней панелью вкладок — её высота */
  readonly offset?: number;
}

export function ToastProvider({ children, offset = 16 }: ToastProviderProps) {
  const texts = useUiTexts();
  const [items, setItems] = useState<readonly Item[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const show = useCallback<Show>(
    (text, { tone = "info", duration } = {}) => {
      const id = ++seq.current;
      setItems((prev) => [...prev, { id, text, tone }].slice(-MAX_VISIBLE));
      const ms = duration ?? (tone === "error" ? 0 : DEFAULT_MS);
      if (ms > 0)
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), ms),
        );
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const bottom = useMemo(() => ({ bottom: `calc(${offset}px + var(--pad-b))` }), [offset]);
  const render = (list: readonly Item[]) =>
    list.map((item) => (
      <div key={item.id} className={`ui-toast ui-toast-${item.tone}`}>
        <p className="ui-toast-text">{item.text}</p>
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
