// Криптография входа на Web Crypto (есть и в Workers, и в Node 22+):
// токены сессий и псевдонимы Telegram ID.

const encoder = new TextEncoder();

// ── токен сессии ────────────────────────────────────────────────────────────
// 32 случайных байта → base64url без паддинга: ровно 43 символа.
// В базе только sha256 от строки токена (app.sessions.token_hash)

export const TOKEN_BYTES = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function generateToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}

export function isWellFormedToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

export async function hashToken(token: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(token)));
}

export type Bearer = { kind: "none" } | { kind: "invalid" } | { kind: "token"; token: string };

/**
 * Разбор заголовка Authorization. Нет заголовка — гость; есть, но не
 * `Bearer <токен нашего формата>` — невалидный (401 без запроса к базе).
 */
export function parseAuthorization(header: string | undefined): Bearer {
  if (header === undefined) return { kind: "none" };
  const match = /^Bearer ([^\s]+)$/i.exec(header.trim());
  const token = match?.[1];
  if (token === undefined || !isWellFormedToken(token)) return { kind: "invalid" };
  return { kind: "token", token };
}

// ── сравнение секретов ──────────────────────────────────────────────────────

/**
 * Совпадают ли строки — за время, не зависящее от содержимого. Сравниваются
 * SHA-256 обеих: дайджесты одной длины, так что время не выдаёт ни совпавший
 * префикс, ни длину секрета.
 */
export async function secretsEqual(received: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(received)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// ── псевдоним Telegram ID ───────────────────────────────────────────────────
// app.clients.tg_id_hash = HMAC-SHA256(ключ = UTF-8(ID_HASH_KEY), сообщение =
// десятичная запись Telegram ID). Ключ только на сервере: без него по хэшу
// нельзя перебором восстановить Telegram ID

export const MIN_ID_HASH_KEY_LENGTH = 32;

export async function telegramIdHash(key: string, telegramId: number): Promise<Uint8Array> {
  if (typeof key !== "string" || key.length < MIN_ID_HASH_KEY_LENGTH) {
    // Ошибка конфигурации, а не запроса: с пустым или коротким ключом псевдоним ничего не прячет
    throw new Error(`ID_HASH_KEY не задан или короче ${MIN_ID_HASH_KEY_LENGTH} символов`);
  }
  if (!Number.isSafeInteger(telegramId) || telegramId <= 0) {
    throw new RangeError("telegramIdHash: Telegram ID должен быть положительным целым");
  }
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(String(telegramId))));
}

// ── base64url ───────────────────────────────────────────────────────────────

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
