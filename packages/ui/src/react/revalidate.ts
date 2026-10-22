/* Свежие списки без «обновите страницу»: заявки, очереди, значки разделов и сроки ответа.

   useRevalidate тихо перечитывает данные экрана, когда к нему вернулись: вкладка снова видна
   (visibilitychange), Mini App снова на экране (событие activated Telegram — через проверку
   наличия onEvent), вернулась связь (online), и раз в interval, пока вкладка видна. Скрытая
   вкладка не ходит в API. Подряд — не чаще minGap: возврат и таймер не дублируют запрос.
   useNow — «сейчас» для «Ответ до 09:00», «Просрочена 3 ч»: тикает, пока вкладка видна, и сразу
   при возврате. */

import { useEffect, useRef, useState } from "react";

export interface RevalidateOptions {
  /** Перечитывать раз в столько мс, пока вкладка видна; 0 — только при возврате */
  readonly interval?: number;
  /** Не чаще, мс */
  readonly minGap?: number;
  /** false — не перечитывать (экран ещё грузится, идёт правка) */
  readonly enabled?: boolean;
}

interface TelegramEvents {
  onEvent?(name: string, handler: () => void): unknown;
  offEvent?(name: string, handler: () => void): unknown;
}

function telegramEvents(): TelegramEvents | null {
  const webApp = (globalThis as { Telegram?: { WebApp?: TelegramEvents } }).Telegram?.WebApp;
  return webApp && typeof webApp.onEvent === "function" ? webApp : null;
}

const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

/** Тихо перечитать данные экрана при возврате к нему и раз в interval, пока он виден */
export function useRevalidate(
  refresh: () => unknown,
  { interval = 90_000, minGap = 10_000, enabled = true }: RevalidateOptions = {},
): void {
  const latest = useRef(refresh);
  latest.current = refresh;
  const last = useRef(Date.now());

  useEffect(() => {
    if (!enabled) return;
    const run = () => {
      if (!visible() || Date.now() - last.current < minGap) return;
      last.current = Date.now();
      latest.current();
    };
    const onVisibility = () => {
      if (visible()) run();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", run);
    const tg = telegramEvents();
    tg?.onEvent?.("activated", run);
    const timer = interval > 0 ? setInterval(run, interval) : null;
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", run);
      if (typeof tg?.offEvent === "function") tg.offEvent("activated", run);
      if (timer !== null) clearInterval(timer);
    };
  }, [enabled, interval, minGap]);
}

/** Текущее время: раз в step, пока вкладка видна, и сразу, когда к ней вернулись */
export function useNow(step = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => {
      if (visible()) setNow(Date.now());
    };
    const timer = setInterval(tick, step);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [step]);
  return now;
}
