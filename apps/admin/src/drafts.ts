/* Вписанное, но не сохранённое, переживает конец сессии. Сессия кончилась посреди работы (401) в
   браузере — панель уводит на вход в хаб и обратно, страница загружается заново. Перед этим
   (saveDrafts) несохранённое каждой формы, что отметила себя useDraft, кладётся во вкладку
   (sessionStorage — не дольше вкладки, как и токен) вместе с тем, чьё оно и когда; форма с тем же
   ключом после входа того же сотрудника его забирает (restore) и говорит об этом. Чужое (вошёл
   другой сотрудник) и старое (дольше DRAFT_TTL_MS) не возвращается и стирается при входе; выход
   из панели стирает всё. Телефонов и других ПДн в черновике нет — их форма вычищает сама. В
   Telegram сессия продлевается без ухода со страницы — там это не нужно. */

import { useEffect, useRef, useState } from "react";

const PREFIX = "bayramm.admin.draft:";

/** Сколько черновик ждёт входа: дольше — вписанное уже не про то, что на экране */
export const DRAFT_TTL_MS = 30 * 60_000;

interface Stored {
  readonly staffId: string;
  readonly at: number;
  readonly value: unknown;
}

/** Формы с несохранённым сейчас: ключ → что положить во вкладку */
const live = new Map<string, () => unknown>();

function keys(): string[] {
  const found: string[] = [];
  for (let i = 0; i < window.sessionStorage.length; i++) {
    const key = window.sessionStorage.key(i);
    if (key?.startsWith(PREFIX)) found.push(key);
  }
  return found;
}

function read(storageKey: string): Stored | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    const stored = raw === null ? null : (JSON.parse(raw) as Partial<Stored> | null);
    return stored && typeof stored.staffId === "string" && typeof stored.at === "number"
      ? (stored as Stored)
      : null;
  } catch {
    return null;
  }
}

const fresh = (stored: Stored | null, staffId: string, now = Date.now()): stored is Stored =>
  stored !== null && stored.staffId === staffId && now - stored.at <= DRAFT_TTL_MS;

/** Сессия кончилась: несохранённое всех открытых форм — во вкладку. Сколько положили */
export function saveDrafts(staffId: string): number {
  let saved = 0;
  for (const [key, value] of live) {
    try {
      const stored: Stored = { staffId, at: Date.now(), value: value() };
      window.sessionStorage.setItem(PREFIX + key, JSON.stringify(stored));
      saved += 1;
    } catch {
      // Хранилище недоступно или полно — черновик не сохранится, как и раньше
    }
  }
  return saved;
}

/** Вход: черновики другого сотрудника и старые — стереть; без staffId (выход) — стереть все */
export function clearDrafts(staffId?: string): void {
  try {
    for (const key of keys())
      if (staffId === undefined || !fresh(read(key), staffId)) window.sessionStorage.removeItem(key);
  } catch {
    // Нечего стирать
  }
}

function take(key: string, staffId: string): unknown {
  try {
    const stored = read(PREFIX + key);
    window.sessionStorage.removeItem(PREFIX + key);
    return fresh(stored, staffId) ? stored.value : undefined;
  } catch {
    return undefined;
  }
}

export interface DraftOptions {
  /** Чьё вписанное: вернуть его можно только ему */
  readonly staffId: string;
  /** false — форма только для чтения: ни сохранять, ни возвращать нечего */
  readonly enabled?: boolean;
}

/**
 * Форма отмечает своё несохранённое (dirty) и что сохранить (value — без ПДн). Черновик с этим
 * ключом, оставшийся от кончившейся сессии того же сотрудника, отдаётся restore один раз после
 * первой отрисовки; true — черновик вернули (форме — сказать об этом)
 */
export function useDraft<T>(
  key: string,
  value: T,
  dirty: boolean,
  restore: (draft: unknown) => boolean,
  { staffId, enabled = true }: DraftOptions,
): boolean {
  const current = useRef(value);
  current.current = value;
  const [restored, setRestored] = useState(false);
  const restoreRef = useRef(restore);
  restoreRef.current = restore;
  useEffect(() => {
    if (!enabled) return;
    const draft = take(key, staffId);
    if (draft !== undefined && restoreRef.current(draft)) setRestored(true);
  }, [key, staffId, enabled]);
  useEffect(() => {
    if (!dirty || !enabled) {
      live.delete(key);
      return;
    }
    live.set(key, () => current.current);
    return () => {
      live.delete(key);
    };
  }, [key, dirty, enabled]);
  return restored;
}
