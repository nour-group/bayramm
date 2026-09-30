import { useCallback, useEffect, useRef, useState } from "react";

export type Load<T> =
  | { readonly state: "loading" }
  | { readonly state: "error"; readonly error: unknown }
  | { readonly state: "ready"; readonly data: T };

/**
 * Данные экрана по ключу: новый ключ — новая загрузка, ответ на старый ключ
 * отбрасывается. reload — ещё раз с тем же ключом, set — поправить загруженное
 * на месте (после действия, без повторного запроса), refresh — перечитать тихо: экран
 * остаётся на месте (без «Загрузка…», фокус не теряется), ответ заменяет данные.
 * refresh отвечает, удалось ли: не удалось — данные прежние.
 */
export function useLoad<T>(key: string | null, load: (key: string) => Promise<T>) {
  const [result, setResult] = useState<Load<T>>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const loader = useRef(load);
  loader.current = load;
  const currentKey = useRef(key);
  currentKey.current = key;

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
  const set = useCallback(
    (update: (data: T) => T) =>
      setResult((current) =>
        current.state === "ready" ? { state: "ready", data: update(current.data) } : current,
      ),
    [],
  );
  const refresh = useCallback(async (): Promise<boolean> => {
    const asked = currentKey.current;
    if (asked === null) return false;
    try {
      const data = await loader.current(asked);
      // Пока читали, экран ушёл на другой ключ — ответ не его
      if (currentKey.current !== asked) return false;
      setResult({ state: "ready", data });
      return true;
    } catch {
      return false;
    }
  }, []);
  return [result, reload, set, refresh] as const;
}
