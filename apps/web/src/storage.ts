/* Хранилище вкладки: sessionStorage, а если он недоступен (приватный режим, запрет,
   старый вебвью) — память до перезагрузки. localStorage не используем: токен сессии
   и черновик заявки с телефоном не должны переживать закрытие приложения. */

const memory = new Map<string, string>();

export function sessionGet(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

export function sessionSet(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
    memory.delete(key);
  } catch {
    memory.set(key, value);
  }
}

export function sessionRemove(key: string): void {
  memory.delete(key);
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // нечего чистить
  }
}

/** Убрать все ключи с этим началом (черновики заявок после удаления аккаунта) */
export function sessionRemovePrefix(prefix: string): void {
  for (const key of [...memory.keys()]) if (key.startsWith(prefix)) memory.delete(key);
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const key = window.sessionStorage.key(i);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) window.sessionStorage.removeItem(key);
  } catch {
    // нечего чистить
  }
}

/** JSON из хранилища; битое или чужое значение — null */
export function sessionGetJson<T>(key: string, isValid: (value: unknown) => value is T): T | null {
  const raw = sessionGet(key);
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return isValid(value) ? value : null;
  } catch {
    return null;
  }
}

export function sessionSetJson(key: string, value: unknown): void {
  sessionSet(key, JSON.stringify(value));
}
