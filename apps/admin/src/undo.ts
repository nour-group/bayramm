/* Решение с «Отменить»: строка уведомления с кнопкой висит UNDO_MS, запрос уходит, когда срок
   вышел; «Отменить» — запроса не было вовсе, на сервере ничего не менялось. Ушли с экрана раньше
   срока, закрыли или спрятали вкладку (pagehide, visibilitychange) — решение уходит сразу, запросом
   с keepalive: он доживёт и до закрытой страницы. */

import { useToast } from "@bayramm/ui/react";
import { useCallback, useEffect, useRef } from "react";
import { t } from "./texts";

/** Сколько можно отменить решение, мс */
export const UNDO_MS = 5000;

export interface Undoable {
  /** Ключ решения: то же фото второй раз не откладывается, прежнее уходит сразу */
  readonly key: string;
  /** Строка уведомления: «Фото 2 одобрено» */
  readonly text: string;
  /** Срок вышел (или ушли с экрана) — отправить решение; urgent — страницу закрывают: keepalive */
  readonly commit: (urgent: boolean) => void;
  /** «Отменить» — вернуть как было; запроса не было */
  readonly undo: () => void;
}

export function useUndoable(): (decision: Undoable) => void {
  const toast = useToast();
  const pending = useRef(new Map<string, (urgent: boolean) => void>());
  useEffect(() => {
    const all = pending.current;
    const now = (urgent: boolean) => {
      for (const flush of [...all.values()]) flush(urgent);
    };
    const onHide = () => now(true);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") now(true);
    };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
      now(false);
      all.clear();
    };
  }, []);
  return useCallback(
    ({ key, text, commit, undo }: Undoable) => {
      pending.current.get(key)?.(false);
      let open = true;
      const close = (): boolean => {
        if (!open) return false;
        open = false;
        clearTimeout(timer);
        pending.current.delete(key);
        return true;
      };
      const hide = toast(text, {
        tone: "success",
        // Уведомление уходит вместе с решением, а не по своему сроку: наведение его не держит
        duration: 0,
        action: { label: t.undo, onClick: () => close() && undo() },
      });
      const flush = (urgent: boolean) => {
        if (!close()) return;
        hide();
        commit(urgent);
      };
      const timer = setTimeout(() => flush(false), UNDO_MS);
      pending.current.set(key, flush);
    },
    [toast],
  );
}
