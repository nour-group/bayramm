// Проверка initData Telegram Mini App на сервере.
// Алгоритм: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// initDataUnsafe на клиенте ничего не доказывает — верить можно только тому, что прошло здесь.

import { type Freshness, type FreshnessOptions, readAuthDate, resolveFreshness } from "./auth-date";
import { base64UrlToBytes, hexToBytes, hmacSha256, timingSafeEqual, utf8 } from "./bytes";

/** Пользователь из поля `user`. Поля переименованы в camelCase, лишние отброшены. */
export interface TelegramUser {
  id: number;
  firstName: string;
  lastName?: string;
  username?: string;
  languageCode?: string;
  isBot?: boolean;
  isPremium?: boolean;
  addedToAttachmentMenu?: boolean;
  /** Разрешил ли пользователь боту писать ему в личку. */
  allowsWriteToPm?: boolean;
  photoUrl?: string;
}

export interface InitData {
  user: TelegramUser;
  /** Когда Telegram подписал данные, unix-секунды. */
  authDate: number;
  /** Значение `startapp` из ссылки. Только для маршрутизации (см. parseStartParam), не для прав доступа. */
  startParam?: string;
  queryId?: string;
  chatType?: string;
  chatInstance?: string;
}

export type InitDataFailure = "missing_hash" | "bad_hash" | "expired" | "malformed" | "missing_user";

export type InitDataSignatureFailure =
  | "missing_signature"
  | "bad_signature"
  | "expired"
  | "malformed"
  | "missing_user";

export type VerifyInitDataResult = { ok: true; data: InitData } | { ok: false; reason: InitDataFailure };

export type VerifyInitDataSignatureResult =
  | { ok: true; data: InitData }
  | { ok: false; reason: InitDataSignatureFailure };

/** maxAgeSeconds (по умолчанию сутки) и now — см. FreshnessOptions. */
export type VerifyInitDataOptions = FreshnessOptions;

export interface VerifyInitDataSignatureOptions extends VerifyInitDataOptions {
  /** Открытый ключ Telegram: боевой (по умолчанию), тестовой среды или свои 32 байта — для тестов. */
  publicKey?: "production" | "test" | BufferSource;
}

// Настоящая initData — около килобайта. Ограничение отсекает мусор до разбора и HMAC
const MAX_INIT_DATA_LENGTH = 16 * 1024;

// Открытые ключи Ed25519, которыми Telegram подписывает поле `signature` (из документации Mini Apps)
const TELEGRAM_ED25519_HEX = {
  production: "e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d",
  test: "40055058a4ee38156a06562e52eece92a771bcd8346a8c4615cb7376eddf72ec",
} as const;

// hash считается по всем полям, кроме самого hash. Поле signature в эту строку входит:
// так её собирает Telegram (и так проверяют aiogram и @tma.js/init-data-node). Если выкинуть
// signature, настоящая initData от современных клиентов перестанет проходить проверку.
const EXCLUDED_FOR_HASH: ReadonlySet<string> = new Set(["hash"]);
// Для подписи Ed25519 исключаются оба поля — так сказано в документации
const EXCLUDED_FOR_SIGNATURE: ReadonlySet<string> = new Set(["hash", "signature"]);

type Fields = ReadonlyMap<string, string>;

type VerifiedFields =
  | { ok: true; data: InitData }
  | { ok: false; reason: "expired" | "malformed" | "missing_user" };

/**
 * Проверяет initData по токену бота (HMAC-SHA256) и возвращает разобранные данные.
 *
 * Бросает исключение только при ошибке конфигурации (пустой токен, неверные опции).
 * Любая проблема самих данных — результат `{ ok: false, reason }`.
 */
export async function verifyInitData(
  initData: string,
  botToken: string,
  opts: VerifyInitDataOptions = {},
): Promise<VerifyInitDataResult> {
  if (typeof botToken !== "string" || botToken.length === 0) {
    // С пустым ключом подпись подделает кто угодно — это ошибка конфигурации, а не плохой запрос
    throw new Error("@bayramm/tg: не задан токен бота");
  }
  const options = resolveFreshness(opts);

  const fields = parseFields(initData);
  if (fields === null) return { ok: false, reason: "malformed" };

  const hash = fields.get("hash");
  if (hash === undefined) return { ok: false, reason: "missing_hash" };
  const received = hexToBytes(hash);
  if (received === null || received.length !== 32) return { ok: false, reason: "bad_hash" };

  // secret_key = HMAC_SHA256(key = "WebAppData", msg = bot_token)
  const secretKey = await hmacSha256(utf8("WebAppData"), utf8(botToken));
  const expected = await hmacSha256(secretKey, utf8(dataCheckString(fields, EXCLUDED_FOR_HASH)));
  if (!timingSafeEqual(expected, received)) return { ok: false, reason: "bad_hash" };

  return readVerified(fields, options);
}

/**
 * Проверяет initData без токена бота — по подписи Ed25519 в поле `signature`
 * («third-party validation»). Нужен только id бота, который открыл Mini App.
 *
 * Требует поддержки Ed25519 в Web Crypto (есть в Cloudflare Workers и Node 22+).
 */
export async function verifyInitDataSignature(
  initData: string,
  botId: number,
  opts: VerifyInitDataSignatureOptions = {},
): Promise<VerifyInitDataSignatureResult> {
  if (!Number.isSafeInteger(botId) || botId <= 0) {
    throw new RangeError("@bayramm/tg: botId должен быть положительным целым числом");
  }
  const options = resolveFreshness(opts);
  const publicKey = resolvePublicKey(opts.publicKey);

  const fields = parseFields(initData);
  if (fields === null) return { ok: false, reason: "malformed" };

  const signatureValue = fields.get("signature");
  if (signatureValue === undefined) return { ok: false, reason: "missing_signature" };
  const signature = base64UrlToBytes(signatureValue);
  if (signature === null || signature.length !== 64) return { ok: false, reason: "bad_signature" };

  const key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
  const message = utf8(`${botId}:WebAppData\n${dataCheckString(fields, EXCLUDED_FOR_SIGNATURE)}`);
  if (!(await crypto.subtle.verify({ name: "Ed25519" }, key, signature, message))) {
    return { ok: false, reason: "bad_signature" };
  }

  return readVerified(fields, options);
}

function resolvePublicKey(key: VerifyInitDataSignatureOptions["publicKey"] = "production"): BufferSource {
  if (typeof key !== "string") return key;
  const bytes = Object.hasOwn(TELEGRAM_ED25519_HEX, key) ? hexToBytes(TELEGRAM_ED25519_HEX[key]) : null;
  if (bytes === null) throw new RangeError(`@bayramm/tg: неизвестный ключ Telegram «${key}»`);
  return bytes;
}

// Разбор query-строки. Повторяющиеся и пустые ключи Telegram не присылает — такой ввод отвергаем,
// чтобы проверенное значение и прочитанное потом гарантированно были одним и тем же полем.
function parseFields(initData: unknown): Fields | null {
  if (typeof initData !== "string" || initData.length > MAX_INIT_DATA_LENGTH) return null;
  const fields = new Map<string, string>();
  let broken = false;
  new URLSearchParams(initData).forEach((value, key) => {
    if (key === "" || fields.has(key)) broken = true;
    fields.set(key, value);
  });
  return broken ? null : fields;
}

// data-check-string: пары `key=value`, отсортированные по ключу, через "\n".
// Значения уже раскодированы из percent-encoding — так требует Telegram.
function dataCheckString(fields: Fields, excluded: ReadonlySet<string>): string {
  return [...fields]
    .filter(([key]) => !excluded.has(key))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

// Читаем поля только после проверки подписи: до неё им нельзя доверять
function readVerified(fields: Fields, freshness: Freshness): VerifiedFields {
  const date = readAuthDate(fields.get("auth_date"), freshness);
  if (!date.ok) return date;
  const { authDate } = date;

  const userValue = fields.get("user");
  if (userValue === undefined) return { ok: false, reason: "missing_user" };
  const user = parseUser(userValue);
  if (user === null) return { ok: false, reason: "malformed" };

  const data: InitData = { user, authDate };
  const startParam = fields.get("start_param");
  if (startParam !== undefined) data.startParam = startParam;
  const queryId = fields.get("query_id");
  if (queryId !== undefined) data.queryId = queryId;
  const chatType = fields.get("chat_type");
  if (chatType !== undefined) data.chatType = chatType;
  const chatInstance = fields.get("chat_instance");
  if (chatInstance !== undefined) data.chatInstance = chatInstance;

  return { ok: true, data };
}

// JSON.parse в try/catch; берём только известные поля нужного типа — ничего не копируем целиком
function parseUser(value: string): TelegramUser | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;

  // Id пользователя в Telegram укладывается в 52 бита — в number без потери точности
  const id = raw.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return null;
  const firstName = raw.first_name;
  if (typeof firstName !== "string") return null;

  const user: TelegramUser = { id, firstName };
  if (typeof raw.last_name === "string") user.lastName = raw.last_name;
  if (typeof raw.username === "string") user.username = raw.username;
  if (typeof raw.language_code === "string") user.languageCode = raw.language_code;
  if (typeof raw.photo_url === "string") user.photoUrl = raw.photo_url;
  if (typeof raw.is_bot === "boolean") user.isBot = raw.is_bot;
  if (typeof raw.is_premium === "boolean") user.isPremium = raw.is_premium;
  if (typeof raw.added_to_attachment_menu === "boolean") {
    user.addedToAttachmentMenu = raw.added_to_attachment_menu;
  }
  if (typeof raw.allows_write_to_pm === "boolean") user.allowsWriteToPm = raw.allows_write_to_pm;
  return user;
}
