// Подпись initData так, как это делает Telegram, — для тестов.
// Алгоритм: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app

const encoder = new TextEncoder();

async function hmac(key: Uint8Array, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message)));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface TestTelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  allows_write_to_pm?: boolean;
}

export interface SignOptions {
  botToken: string;
  /** unix-секунды; по умолчанию — сейчас. */
  authDate?: number;
}

/** Поля initData в порядке, как их шлёт клиент, плюс верный hash. */
export async function signInitData(fields: Record<string, string>, botToken: string): Promise<string> {
  const checkString = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = await hmac(encoder.encode("WebAppData"), botToken);
  const hash = hex(await hmac(secretKey, checkString));
  return new URLSearchParams({ ...fields, hash }).toString();
}

export function initDataFields(user: TestTelegramUser, authDate = Math.floor(Date.now() / 1000)) {
  return {
    query_id: "AAE-test-query",
    user: JSON.stringify(user),
    auth_date: String(authDate),
    chat_type: "private",
  };
}

export function initDataFor(user: TestTelegramUser, { botToken, authDate }: SignOptions): Promise<string> {
  return signInitData(initDataFields(user, authDate), botToken);
}
