// Проверка данных виджета входа Telegram (Telegram Login Widget) на сервере.
// Алгоритм: https://core.telegram.org/widgets/login#checking-authorization
//
// Отличия от initData Mini App: ключ HMAC — SHA-256(токен бота), а не
// HMAC("WebAppData", токен), и поля приходят плоским набором (id, first_name, …),
// а не query-строкой с JSON в `user`. Верить можно только тому, что прошло здесь.

import { type Freshness, type FreshnessOptions, readAuthDate, resolveFreshness } from "./auth-date";
import { hexToBytes, hmacSha256, sha256, timingSafeEqual, utf8 } from "./bytes";

/** Пользователь из данных виджета. Поля переименованы в camelCase, лишние отброшены. */
export interface LoginWidgetUser {
  id: number;
  firstName: string;
  lastName?: string;
  username?: string;
  photoUrl?: string;
}

export interface LoginWidgetData {
  user: LoginWidgetUser;
  /** Когда Telegram подписал данные, unix-секунды. */
  authDate: number;
}

export type LoginWidgetFailure = "missing_hash" | "bad_hash" | "expired" | "malformed";

export type VerifyLoginWidgetResult =
  | { ok: true; data: LoginWidgetData }
  | { ok: false; reason: LoginWidgetFailure };

/** maxAgeSeconds (по умолчанию сутки) и now — см. FreshnessOptions. */
export type VerifyLoginWidgetOptions = FreshnessOptions;

/**
 * Поля виджета как их прислал браузер: объект из JSON (значения — строки или
 * целые числа, как в колбэке виджета) или query-строка редиректа data-auth-url.
 */
export type LoginWidgetParams = URLSearchParams | Readonly<Record<string, unknown>>;

// Настоящие данные виджета — семь полей и пара сотен символов. Ограничения
// отсекают мусор до HMAC
const MAX_FIELDS = 16;
const MAX_TOTAL_LENGTH = 4 * 1024;
// Имена полей Telegram — snake_case латиницей
const FIELD_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

type Fields = ReadonlyMap<string, string>;

/**
 * Проверяет данные виджета входа по токену бота (HMAC-SHA256) и возвращает
 * разобранного пользователя.
 *
 * Бросает исключение только при ошибке конфигурации (пустой токен, неверные опции).
 * Любая проблема самих данных — результат `{ ok: false, reason }`.
 */
export async function verifyLoginWidget(
  params: LoginWidgetParams,
  botToken: string,
  opts: VerifyLoginWidgetOptions = {},
): Promise<VerifyLoginWidgetResult> {
  if (typeof botToken !== "string" || botToken.length === 0) {
    // С пустым ключом подпись подделает кто угодно — это ошибка конфигурации, а не плохой запрос
    throw new Error("@bayramm/tg: не задан токен бота");
  }
  const freshness = resolveFreshness(opts);

  const fields = toFields(params);
  if (fields === null) return { ok: false, reason: "malformed" };

  const hash = fields.get("hash");
  if (hash === undefined) return { ok: false, reason: "missing_hash" };
  const received = hexToBytes(hash);
  if (received === null || received.length !== 32) return { ok: false, reason: "bad_hash" };

  // secret_key = SHA256(bot_token); hash = hex(HMAC_SHA256(secret_key, data_check_string))
  const secretKey = await sha256(utf8(botToken));
  const expected = await hmacSha256(secretKey, utf8(dataCheckString(fields)));
  if (!timingSafeEqual(expected, received)) return { ok: false, reason: "bad_hash" };

  return readVerified(fields, freshness);
}

// Поля в Map<строка, строка>. Всё, что не похоже на данные виджета, — null (malformed):
// вложенные объекты, null, дробные числа, повтор ключа в query-строке, странные имена
function toFields(params: unknown): Fields | null {
  let entries: [string, unknown][];
  if (params instanceof URLSearchParams) {
    entries = [...params];
  } else if (typeof params === "object" && params !== null && !Array.isArray(params)) {
    entries = Object.entries(params);
  } else {
    return null;
  }
  if (entries.length > MAX_FIELDS) return null;

  const fields = new Map<string, string>();
  let total = 0;
  for (const [key, raw] of entries) {
    if (!FIELD_NAME_RE.test(key) || fields.has(key)) return null;
    let value: string;
    if (typeof raw === "string") value = raw;
    else if (typeof raw === "number" && Number.isSafeInteger(raw)) value = String(raw);
    else return null;
    total += key.length + value.length;
    if (total > MAX_TOTAL_LENGTH) return null;
    fields.set(key, value);
  }
  return fields;
}

// data-check-string: все поля, кроме hash, `key=value`, отсортированные по ключу, через "\n"
function dataCheckString(fields: Fields): string {
  return [...fields]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

// Читаем поля только после проверки подписи: до неё им нельзя доверять
function readVerified(fields: Fields, freshness: Freshness): VerifyLoginWidgetResult {
  const date = readAuthDate(fields.get("auth_date"), freshness);
  if (!date.ok) return date;

  // Id пользователя в Telegram укладывается в 52 бита — в number без потери точности
  const idValue = fields.get("id");
  if (idValue === undefined || !/^[1-9]\d{0,15}$/.test(idValue)) return { ok: false, reason: "malformed" };
  const id = Number(idValue);
  if (!Number.isSafeInteger(id)) return { ok: false, reason: "malformed" };

  const firstName = fields.get("first_name");
  if (firstName === undefined) return { ok: false, reason: "malformed" };

  const user: LoginWidgetUser = { id, firstName };
  const lastName = fields.get("last_name");
  if (lastName !== undefined) user.lastName = lastName;
  const username = fields.get("username");
  if (username !== undefined) user.username = username;
  const photoUrl = fields.get("photo_url");
  if (photoUrl !== undefined) user.photoUrl = photoUrl;

  return { ok: true, data: { user, authDate: date.authDate } };
}
