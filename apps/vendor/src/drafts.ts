/* Несохранённое при конце сессии. Сессия кончилась посреди правки (12 часов, отключили доступ):
   экран входа заменяет кабинет, а вход вне Telegram и вовсе уводит со страницы — вписанное
   пропало бы. Поэтому в тот момент, когда API ответил 401, открытые формы с правками кладут
   вписанное во вкладку (sessionStorage, префикс черновиков; закрыли вкладку — пропало). После
   входа экран открывает ту же форму с черновиком и стирает его — только тому же пользователю
   кабинета и только черновик понятного вида (старый или обрезанный не открывается). Выход и смена
   кабинета стирают все черновики. Хранилища нет (старый вебвью, запрет) — без черновиков. */

import { useEffect, useRef } from "react";

export const DRAFT_PREFIX = "bayramm.vendor.draft.";

const flushes = new Set<{ current: (() => void) | null }>();

/** Чей кабинет открыт (id пользователя кабинета); null — вход ещё не состоялся */
let owner: string | null = null;

/** Оболочка говорит, кто вошёл: черновик пишется и отдаётся только ему */
export function setDraftOwner(userId: string | null): void {
  owner = userId;
}

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
  if (owner === null) return;
  try {
    window.sessionStorage.setItem(`${DRAFT_PREFIX}${key}`, JSON.stringify({ owner, value }));
  } catch {
    // без хранилища — без черновика
  }
}

/**
 * Черновик по ключу — и сразу стереть: восстанавливается один раз. Чужой (другой пользователь
 * кабинета) или непонятного вида (valid — проверка формы) — null
 */
export function takeDraft<T>(key: string, valid: (value: unknown) => value is T): T | null {
  try {
    const raw = window.sessionStorage.getItem(`${DRAFT_PREFIX}${key}`);
    window.sessionStorage.removeItem(`${DRAFT_PREFIX}${key}`);
    if (raw === null || owner === null) return null;
    const saved = JSON.parse(raw) as { owner?: unknown; value?: unknown } | null;
    if (saved?.owner !== owner) return null;
    return valid(saved.value) ? saved.value : null;
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
