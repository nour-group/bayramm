import { useOnReconnect } from "@bayramm/ui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { isAbort, isRetryable } from "./api/errors";

export type AsyncState<T> =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly error: unknown }
  | { readonly status: "ready"; readonly data: T };

export type AsyncResult<T> = AsyncState<T> & {
  /** Загрузить заново (кнопка «Повторить») */
  readonly reload: () => void;
  /** Заменить данные без запроса (после действия, вернувшего новую версию) */
  readonly replace: (data: T) => void;
};

/**
 * Данные экрана: загрузка, ошибка, готово. key — всё, от чего зависит запрос: при его смене
 * старый запрос отменяется, а его поздний ответ не перетрёт новый. Упала загрузка, а связь
 * потом вернулась (событие online) — повтор сам, без «Повторить»
 */
export function useAsync<T>(key: string, load: (signal: AbortSignal) => Promise<T>): AsyncResult<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const loader = useRef(load);
  loader.current = load;

  // biome-ignore lint/correctness/useExhaustiveDependencies: key и attempt — и есть зависимости запроса
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    loader.current(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ status: "ready", data });
      },
      (error: unknown) => {
        if (!controller.signal.aborted && !isAbort(error)) setState({ status: "error", error });
      },
    );
    return () => controller.abort();
  }, [key, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const replace = useCallback((data: T) => setState({ status: "ready", data }), []);
  const failed = state.status === "error" && isRetryable(state.error);
  useOnReconnect(() => {
    if (failed) reload();
  });
  return { ...state, reload, replace };
}

/** Текущее время, обновляется раз в intervalMs: для «осталось N ч» */
export function useNow(now: () => number, intervalMs = 60_000): number {
  const [value, setValue] = useState(now);
  useEffect(() => {
    const timer = setInterval(() => setValue(now()), intervalMs);
    return () => clearInterval(timer);
  }, [now, intervalMs]);
  return value;
}

/**
 * Заголовок вкладки «<экран> · Bayramm» (full — заголовок как есть, у лендинга) и описание
 * страницы, если оно задано. Первую загрузку размечает воркер (worker/meta.ts) — тут
 * переходы внутри приложения: вкладка и браузер видят тот же текст
 */
export function useDocumentTitle(title: string, description?: string, full = false): void {
  useEffect(() => {
    document.title = full ? title : title ? `${title} · Bayramm` : "Bayramm";
  }, [title, full]);
  useEffect(() => {
    if (description) document.querySelector('meta[name="description"]')?.setAttribute("content", description);
  }, [description]);
}
