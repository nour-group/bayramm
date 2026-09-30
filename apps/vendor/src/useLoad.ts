import { useOnReconnect } from "@bayramm/ui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiFailure } from "./api";

export type Load<T> =
  | { readonly state: "loading" }
  | { readonly state: "error"; readonly error: unknown }
  | { readonly state: "ready"; readonly data: T };

/**
 * Данные экрана по ключу: новый ключ — новая загрузка, ответ на старый ключ
 * отбрасывается. reload — ещё раз с тем же ключом, set — поправить загруженное
 * на месте (после действия, без повторного запроса). Загрузка упала без сети или на 5xx,
 * а связь потом вернулась (событие online) — повтор сам.
 */
export function useLoad<T>(key: string | null, load: (key: string) => Promise<T>) {
  const [result, setResult] = useState<Load<T>>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const loader = useRef(load);
  loader.current = load;

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt — повтор загрузки по «Повторить»
  useEffect(() => {
    if (key === null) return;
    let active = true;
    setResult({ state: "loading" });
    loader.current(key).then(
      (data) => active && setResult({ state: "ready", data }),
      (error: unknown) => active && setResult({ state: "error", error }),
    );
    return () => {
      active = false;
    };
  }, [key, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const retryable = result.state === "error" && isRetryable(result.error);
  useOnReconnect(() => {
    if (retryable) reload();
  });
  const set = useCallback(
    (update: (data: T) => T) =>
      setResult((current) =>
        current.state === "ready" ? { state: "ready", data: update(current.data) } : current,
      ),
    [],
  );
  return [result, reload, set] as const;
}

/** Повторить, когда вернётся связь: запрос не дошёл или сервер не ответил (5xx) */
export function isRetryable(error: unknown): boolean {
  return error instanceof ApiFailure ? error.status === 0 || error.status >= 500 : true;
}
