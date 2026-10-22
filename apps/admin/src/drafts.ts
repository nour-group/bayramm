/* Вписанное, но не сохранённое, переживает конец сессии. Сессия кончилась посреди работы (401) в
   браузере — панель уводит на вход в хаб и обратно, страница загружается заново. Перед этим
   (saveDrafts) несохранённое каждой формы, что отметила себя useDraft, кладётся во вкладку
   (sessionStorage — не дольше вкладки, как и токен); форма с тем же ключом после входа его
   забирает (restore) и говорит об этом. Выход из панели черновики стирает. В Telegram сессия
   продлевается без ухода со страницы — там это не нужно. */

import { useEffect, useRef, useState } from "react";

const PREFIX = "bayramm.admin.draft:";

/** Формы с несохранённым сейчас: ключ → что положить во вкладку */
const live = new Map<string, () => unknown>();

/** Сессия кончилась: несохранённое всех открытых форм — во вкладку. Сколько положили */
export function saveDrafts(): number {
  let saved = 0;
  for (const [key, read] of live) {
    try {
      window.sessionStorage.setItem(PREFIX + key, JSON.stringify(read()));
      saved += 1;
    } catch {
      // Хранилище недоступно или полно — черновик не сохранится, как и раньше
    }
  }
  return saved;
}

/** Выход из панели: черновики прежней сессии не нужны */
export function clearDrafts(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const key = window.sessionStorage.key(i);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) window.sessionStorage.removeItem(key);
  } catch {
    // Нечего стирать
  }
}

function take(key: string): unknown {
  try {
    const raw = window.sessionStorage.getItem(PREFIX + key);
    if (raw === null) return undefined;
    window.sessionStorage.removeItem(PREFIX + key);
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Форма отмечает своё несохранённое (dirty) и что сохранить (value). Черновик с этим ключом,
 * оставшийся от кончившейся сессии, отдаётся restore один раз после первой отрисовки; true —
 * черновик вернули (форме — сказать об этом)
 */
export function useDraft<T>(
  key: string,
  value: T,
  dirty: boolean,
  restore: (draft: unknown) => boolean,
): boolean {
  const current = useRef(value);
  current.current = value;
  const [restored, setRestored] = useState(false);
  const restoreRef = useRef(restore);
  restoreRef.current = restore;
  useEffect(() => {
    const draft = take(key);
    if (draft !== undefined && restoreRef.current(draft)) setRestored(true);
  }, [key]);
  useEffect(() => {
    if (!dirty) {
      live.delete(key);
      return;
    }
    live.set(key, () => current.current);
    return () => {
      live.delete(key);
    };
  }, [key, dirty]);
  return restored;
}
