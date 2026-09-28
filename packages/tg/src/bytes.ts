// Байтовые утилиты поверх стандартных API (Web Crypto, TextEncoder, atob).
// Node crypto не используем: пакет работает в Cloudflare Workers.

const encoder = new TextEncoder();

export function utf8(text: string) {
  return encoder.encode(text);
}

export async function hmacSha256(key: BufferSource, data: BufferSource) {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, data));
}

export async function sha256(data: BufferSource) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

// Сравнение за время, не зависящее от содержимого: без раннего выхода на первом
// несовпавшем байте. Длина не секрет — это длина дайджеста, она фиксирована.
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

// Только строчный hex чётной длины — ровно так Telegram присылает `hash`.
// Всё остальное — null, без попыток «починить» ввод.
export function hexToBytes(hex: string) {
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// base64url (RFC 4648 §5); паддинг `=` необязателен — Telegram его не ставит.
export function base64UrlToBytes(value: string) {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value)) return null;
  const body = value.replace(/=+$/, "");
  if (body.length % 4 === 1) return null;
  const base64 = body
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(body.length / 4) * 4, "=");
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
