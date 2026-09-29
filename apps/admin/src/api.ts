/* Запросы панели к API: /api/staff/* за токеном сотрудника. Контракт ответов —
   @bayramm/shared/api/staff. Ошибка — стабильный код (по нему выбирается текст) и
   details: имена неверных полей или недостающие пункты публикации. 401 — сессия
   кончилась: панель возвращает на вход. */

import type { StaffMe, StaffPermission } from "@bayramm/shared/api/staff";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

const API = "/api";

export type Failure = {
  readonly ok: false;
  readonly status: number;
  readonly code: string;
  readonly details: string[];
};
export type Result<T> = { readonly ok: true; readonly data: T } | Failure;

export interface Api {
  get<T>(path: string): Promise<Result<T>>;
  post<T>(path: string, body?: unknown): Promise<Result<T>>;
  patch<T>(path: string, body: unknown): Promise<Result<T>>;
  put<T>(path: string, body: unknown): Promise<Result<T>>;
  del<T>(path: string): Promise<Result<T>>;
  /** Файл как есть в теле запроса (фото) */
  upload<T>(path: string, file: Blob, headers: Record<string, string>): Promise<Result<T>>;
}

const networkFailure: Failure = { ok: false, status: 0, code: "network", details: [] };

async function parse<T>(res: Response): Promise<Result<T>> {
  const body = (await res.json().catch(() => null)) as unknown;
  if (res.ok) return { ok: true, data: body as T };
  const error = (body as { error?: { code?: unknown; details?: unknown } } | null)?.error;
  return {
    ok: false,
    status: res.status,
    code: typeof error?.code === "string" ? error.code : "unknown",
    details: Array.isArray(error?.details)
      ? error.details.filter((d): d is string => typeof d === "string")
      : [],
  };
}

/** Клиент API сотрудника. onUnauthorized — сессия больше не действует (401) */
export function createApi(token: string, onUnauthorized: () => void, doFetch: typeof fetch = fetch): Api {
  async function send<T>(method: string, path: string, init: RequestInit = {}): Promise<Result<T>> {
    let res: Response;
    try {
      res = await doFetch(`${API}${path}`, {
        ...init,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.headers as Record<string, string> | undefined),
        },
        credentials: "omit",
        cache: "no-store",
      });
    } catch {
      return networkFailure;
    }
    if (res.status === 401) onUnauthorized();
    return parse<T>(res);
  }
  const json = (body: unknown): RequestInit => ({
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return {
    get: (path) => send("GET", path),
    post: (path, body) => send("POST", path, json(body)),
    patch: (path, body) => send("PATCH", path, json(body)),
    put: (path, body) => send("PUT", path, json(body)),
    del: (path) => send("DELETE", path),
    upload: (path, file, headers) =>
      send("POST", path, {
        headers: { "content-type": file.type || "application/octet-stream", ...headers },
        body: file,
      }),
  };
}

// ── контекст: API и вошедший сотрудник ─────────────────────────────────────

export interface Session {
  readonly api: Api;
  readonly staff: StaffMe;
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession: нет SessionContext");
  return session;
}

/** Есть ли у сотрудника право — только чтобы не показывать лишние кнопки; решает сервер */
export function useCan(): (permission: StaffPermission) => boolean {
  const { staff } = useSession();
  return useCallback((permission) => staff.permissions.includes(permission), [staff]);
}

export type Loaded<T> =
  | { readonly state: "loading" }
  | { readonly state: "error"; readonly failure: Failure }
  | { readonly state: "ready"; readonly data: T };

/**
 * Данные экрана по GET-пути. reload — перечитать; set — заменить ответом правки
 * (API возвращает объект целиком). Ответ на устаревший путь отбрасывается.
 */
export function useLoad<T>(path: string | null) {
  const { api } = useSession();
  const [loaded, setLoaded] = useState<Loaded<T>>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const current = useRef(path);
  current.current = path;

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt — повод перечитать (reload)
  useEffect(() => {
    if (path === null) return;
    let active = true;
    // Уже показанные данные остаются на экране, пока идёт новый запрос (поиск, фильтр,
    // «перечитать»): таблица не мигает. Экран другого объекта монтируется заново
    setLoaded((prev) => (prev.state === "ready" ? prev : { state: "loading" }));
    void api.get<T>(path).then((result) => {
      if (!active || current.current !== path) return;
      setLoaded(result.ok ? { state: "ready", data: result.data } : { state: "error", failure: result });
    });
    return () => {
      active = false;
    };
  }, [api, path, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const set = useCallback((data: T) => setLoaded({ state: "ready", data }), []);
  return { loaded, reload, set } as const;
}
