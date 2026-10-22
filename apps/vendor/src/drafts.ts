/* Несохранённое при конце сессии. Сессия кончилась посреди правки (12 часов, отключили доступ):
   экран входа заменяет кабинет, а вход вне Telegram и вовсе уводит со страницы — вписанное
   пропало бы. Поэтому в тот момент, когда API ответил 401, открытые формы с правками кладут
   вписанное во вкладку (sessionStorage, префикс черновиков; закрыли вкладку — пропало). После
   входа экран открывает ту же форму с черновиком и стирает его. Выход и смена кабинета стирают
   все черновики. Хранилища нет (старый вебвью, запрет) — без черновиков, как раньше. */

import { useEffect, useRef } from "react";

export const DRAFT_PREFIX = "bayramm.vendor.draft.";

const flushes = new Set<{ current: (() => void) | null }>();

/** Сессия кончилась: каждая открытая форма с правками сохраняет вписанное */
export function flushDrafts(): void {
  for (const flush of flushes) flush.current?.();
}

/**
 * Форма с правками сохраняет вписанное при конце сессии: flush — последний (с текущими значениями),
 * null — сохранять нечего
 */
export function useDraftOnExpiry(flush: (() => void) | null): void {
  const latest = useRef(flush);
  latest.current = flush;
  useEffect(() => {
    flushes.add(latest);
    return () => {
      flushes.delete(latest);
    };
  }, []);
}

export function saveDraft(key: string, value: unknown): void {
  try {
    window.sessionStorage.setItem(`${DRAFT_PREFIX}${key}`, JSON.stringify(value));
  } catch {
    // без хранилища — без черновика
  }
}

/** Черновик по ключу — и сразу стереть: восстанавливается один раз */
export function takeDraft<T>(key: string): T | null {
  try {
    const raw = window.sessionStorage.getItem(`${DRAFT_PREFIX}${key}`);
    window.sessionStorage.removeItem(`${DRAFT_PREFIX}${key}`);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

/** Ключи черновиков, начинающиеся с start (без префикса хранилища) */
export function draftKeys(start: string): string[] {
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const key = window.sessionStorage.key(i);
      if (key?.startsWith(`${DRAFT_PREFIX}${start}`)) keys.push(key.slice(DRAFT_PREFIX.length));
    }
    return keys;
  } catch {
    return [];
  }
}

/** Выход, смена кабинета: чужие черновики не переносятся */
export function clearDrafts(): void {
  for (const key of draftKeys("")) {
    try {
      window.sessionStorage.removeItem(`${DRAFT_PREFIX}${key}`);
    } catch {
      return;
    }
  }
}
