// Клиент Supabase Storage (REST): положить и удалить объект. Ходит ключом
// service_role — он обходит RLS хранилища, поэтому живёт только на сервере
// (секрет SUPABASE_SERVICE_ROLE_KEY) и только здесь.
//
//   POST   /storage/v1/object/<бакет>/<ключ>   x-upsert: false — не перезаписывать
//   DELETE /storage/v1/object/<бакет>/<ключ>
//
// Storage отвечает на ошибки JSON вида { statusCode: "409", error, message };
// HTTP-статус при этом у разных версий бывает 400 — смотрим на statusCode.

import { LISTING_PHOTOS_BUCKET } from "@bayramm/media";

export interface ObjectStorage {
  /** Кладёт новый объект. Уже существующий не перезаписывает — StorageError("exists"). */
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Удаляет объект. Отсутствующий — не ошибка. */
  remove(key: string): Promise<void>;
}

export type StorageFailure =
  /** Объект с таким ключом уже есть */
  | "exists"
  /** Бакет не принял файл: тип, размер, ключ */
  | "rejected"
  /** Неверный ключ доступа или нет бакета — ошибка настройки, не запроса */
  | "misconfigured"
  /** Сеть, таймаут, 5xx */
  | "unavailable";

export class StorageError extends Error {
  readonly reason: StorageFailure;
  /** Статус из ответа Storage (statusCode из JSON или HTTP); 0 — ответа не было */
  readonly status: number;

  constructor(reason: StorageFailure, status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageError";
    this.reason = reason;
    this.status = status;
  }
}

export interface SupabaseStorageOptions {
  /** Адрес проекта: https://<ref>.supabase.co (локально http://127.0.0.1:54321) */
  readonly url: string;
  /** Ключ service_role (или секретный ключ sb_secret_…) */
  readonly serviceKey: string;
  readonly bucket: string;
  readonly fetch?: typeof fetch;
  /** Предел на запрос, мс */
  readonly timeoutMs?: number;
}

/** Ключи неизменяемы (новое фото — новый UUID): объект можно кэшировать сколько угодно */
export const OBJECT_CACHE_CONTROL = "public, max-age=31536000, immutable";
const DEFAULT_TIMEOUT_MS = 30_000;

function objectPath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

async function effectiveStatus(res: Response): Promise<number> {
  try {
    const body = (await res.json()) as { statusCode?: unknown };
    const code = Number(body.statusCode);
    return Number.isInteger(code) && code >= 400 ? code : res.status;
  } catch {
    return res.status;
  }
}

function failure(status: number): StorageFailure {
  if (status === 409) return "exists";
  if (status === 401 || status === 403 || status === 404) return "misconfigured";
  if (status >= 500) return "unavailable";
  return "rejected";
}

export function supabaseStorage(options: SupabaseStorageOptions): ObjectStorage {
  const base = options.url.replace(/\/+$/, "");
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!/^https?:\/\//.test(base))
    throw new TypeError("supabaseStorage: SUPABASE_URL должен быть http(s)-адресом");
  if (!options.serviceKey) throw new TypeError("supabaseStorage: не задан SUPABASE_SERVICE_ROLE_KEY");

  // Новые секретные ключи (sb_secret_…) — не JWT: шлюз ждёт их в apikey и
  // принимает тот же ключ в Authorization, как делает supabase-js
  const auth = { apikey: options.serviceKey, authorization: `Bearer ${options.serviceKey}` };

  async function request(method: string, key: string, init: RequestInit = {}): Promise<Response> {
    const url = `${base}/storage/v1/object/${encodeURIComponent(options.bucket)}/${objectPath(key)}`;
    try {
      return await doFetch(url, {
        ...init,
        method,
        headers: { ...auth, ...(init.headers as Record<string, string> | undefined) },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new StorageError("unavailable", 0, `storage ${method}: нет ответа`, { cause: err });
    }
  }

  return {
    async put(key, body, contentType) {
      const res = await request("POST", key, {
        headers: { "content-type": contentType, "cache-control": OBJECT_CACHE_CONTROL, "x-upsert": "false" },
        body: body as Uint8Array<ArrayBuffer>,
      });
      if (res.ok) {
        await res.body?.cancel();
        return;
      }
      const status = await effectiveStatus(res);
      throw new StorageError(failure(status), status, `storage put: ${status}`);
    },

    async remove(key) {
      const res = await request("DELETE", key);
      if (res.ok) {
        await res.body?.cancel();
        return;
      }
      const status = await effectiveStatus(res);
      // Объекта нет — цель достигнута (повторное удаление, откат неудачной загрузки)
      if (status === 404) return;
      throw new StorageError(failure(status), status, `storage remove: ${status}`);
    },
  };
}

/** Хранилище фото листингов из окружения воркера API. */
export function listingPhotoStorage(
  env: Pick<Env, "SUPABASE_URL" | "SUPABASE_SERVICE_ROLE_KEY">,
): ObjectStorage {
  return supabaseStorage({
    url: env.SUPABASE_URL,
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
    bucket: LISTING_PHOTOS_BUCKET,
  });
}
