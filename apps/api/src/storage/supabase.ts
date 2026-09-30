// Клиент Supabase Storage (REST): положить и удалить объект. Ходит ключом
// service_role — он обходит RLS хранилища, поэтому живёт только на сервере
// (секрет SUPABASE_SERVICE_ROLE_KEY) и только здесь.
//
//   POST   /storage/v1/object/<бакет>/<ключ>   x-upsert: false — не перезаписывать
//   DELETE /storage/v1/object/<бакет>/<ключ>
//   POST   /storage/v1/object/list-v2/<бакет>  { prefix, limit, cursor, with_delimiter: false }
//          — все объекты под префиксом по ключу, страницами (сверка с базой, photos/sweep.ts)
//   DELETE /storage/v1/object/<бакет>          { prefixes: [ключи] } — до 1000 одним запросом
//
// Storage отвечает на ошибки JSON вида { statusCode: "409", error, message };
// HTTP-статус при этом у разных версий бывает 400 — смотрим на statusCode.

import { LISTING_PHOTOS_BUCKET } from "@bayramm/media";
import { trimTrailingSlashes } from "@bayramm/shared";

export interface ObjectStorage {
  /** Кладёт новый объект. Уже существующий не перезаписывает — StorageError("exists"). */
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Удаляет объект. Отсутствующий — не ошибка. */
  remove(key: string): Promise<void>;
}

export interface StoredObject {
  readonly key: string;
  /** Когда объект положили; null — хранилище не сказало */
  readonly createdAt: Date | null;
}

export interface ObjectPage {
  readonly objects: readonly StoredObject[];
  /** Со следующей страницы; null — страниц больше нет */
  readonly cursor: string | null;
}

/** Сверка хранилища с базой: список и удаление пачкой (ежедневное обслуживание) */
export interface ObjectSweeper {
  /** Объекты под префиксом (с вложенными «папками»), по ключу, страница не больше limit */
  list(prefix: string, cursor: string | null, limit: number): Promise<ObjectPage>;
  /** Удаляет объекты одним запросом (не больше MAX_REMOVE_BATCH); отсутствующие — не ошибка. Сколько удалено */
  removeMany(keys: readonly string[]): Promise<number>;
}

/** Сколько ключей Storage принимает в одном удалении */
export const MAX_REMOVE_BATCH = 1000;

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

export function supabaseStorage(options: SupabaseStorageOptions): ObjectStorage & ObjectSweeper {
  const base = trimTrailingSlashes(options.url);
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!/^https?:\/\//.test(base))
    throw new TypeError("supabaseStorage: SUPABASE_URL должен быть http(s)-адресом");
  if (!options.serviceKey) throw new TypeError("supabaseStorage: не задан SUPABASE_SERVICE_ROLE_KEY");

  // Новые секретные ключи (sb_secret_…) — не JWT: шлюз ждёт их в apikey и
  // принимает тот же ключ в Authorization, как делает supabase-js
  const auth = { apikey: options.serviceKey, authorization: `Bearer ${options.serviceKey}` };

  const bucketPath = encodeURIComponent(options.bucket);

  async function request(method: string, key: string, init: RequestInit = {}): Promise<Response> {
    return call(method, `${bucketPath}/${objectPath(key)}`, init);
  }

  async function call(method: string, path: string, init: RequestInit = {}): Promise<Response> {
    const url = `${base}/storage/v1/object/${path}`;
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

    async list(prefix, cursor, limit) {
      const res = await call("POST", `list-v2/${bucketPath}`, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prefix,
          limit,
          with_delimiter: false,
          ...(cursor === null ? {} : { cursor }),
        }),
      });
      if (!res.ok) {
        const status = await effectiveStatus(res);
        throw new StorageError(failure(status), status, `storage list: ${status}`);
      }
      const body = (await res.json().catch(() => null)) as {
        hasNext?: unknown;
        nextCursor?: unknown;
        objects?: unknown;
      } | null;
      if (body === null || !Array.isArray(body.objects)) {
        throw new StorageError("unavailable", res.status, "storage list: unexpected body");
      }
      const objects = body.objects.flatMap((item: unknown): StoredObject[] => {
        const { name, created_at } = (item ?? {}) as { name?: unknown; created_at?: unknown };
        if (typeof name !== "string") return [];
        const created = typeof created_at === "string" ? new Date(created_at) : null;
        return [{ key: name, createdAt: created && !Number.isNaN(created.getTime()) ? created : null }];
      });
      const next = body.hasNext === true && typeof body.nextCursor === "string" ? body.nextCursor : null;
      return { objects, cursor: next };
    },

    async removeMany(keys) {
      if (keys.length === 0) return 0;
      if (keys.length > MAX_REMOVE_BATCH) throw new RangeError("storage removeMany: не больше 1000 ключей");
      const res = await call("DELETE", bucketPath, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prefixes: keys }),
      });
      if (!res.ok) {
        const status = await effectiveStatus(res);
        throw new StorageError(failure(status), status, `storage remove many: ${status}`);
      }
      const removed = (await res.json().catch(() => null)) as unknown;
      return Array.isArray(removed) ? removed.length : 0;
    },
  };
}

/** Хранилище фото листингов из окружения воркера API. */
export function listingPhotoStorage(
  env: Pick<Env, "SUPABASE_URL" | "SUPABASE_SERVICE_ROLE_KEY">,
): ObjectStorage & ObjectSweeper {
  return supabaseStorage({
    url: env.SUPABASE_URL,
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
    bucket: LISTING_PHOTOS_BUCKET,
  });
}
