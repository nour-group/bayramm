// IP клиента и его псевдоним.
//
// Адрес берём только из CF-Connecting-IP: его ставит Cloudflare на входе и
// перезаписывает присланный клиентом; сайт (apps/web) пересылает запрос в API
// по сервисной привязке вместе с заголовками. Сам IP нигде не храним —
// только HMAC(ID_HASH_KEY, "ip:" + адрес): ключ ограничения частоты и
// app.consents.ip_hash. Префикс отделяет эти хэши от псевдонимов Telegram ID
// на том же ключе.

import { MIN_ID_HASH_KEY_LENGTH, toBase64Url } from "./crypto";

const encoder = new TextEncoder();

/** IP из заголовка Cloudflare; нет заголовка (локальный запуск, тесты) — null. */
export function clientIp(headers: Headers): string | null {
  const ip = headers.get("CF-Connecting-IP")?.trim();
  return ip ? ip : null;
}

/** HMAC-SHA256(ID_HASH_KEY, "ip:" + адрес) — 32 байта, как app.consents.ip_hash. */
export async function ipHash(key: string, ip: string): Promise<Uint8Array> {
  if (typeof key !== "string" || key.length < MIN_ID_HASH_KEY_LENGTH) {
    throw new Error(`ID_HASH_KEY не задан или короче ${MIN_ID_HASH_KEY_LENGTH} символов`);
  }
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(`ip:${ip}`)));
}

/** Псевдоним IP текущего запроса или null, если адреса нет. */
export async function requestIpHash(headers: Headers, key: string): Promise<Uint8Array | null> {
  const ip = clientIp(headers);
  return ip === null ? null : ipHash(key, ip);
}

/** Тот же псевдоним строкой — для ключей ограничения частоты. */
export async function ipKey(key: string, ip: string): Promise<string> {
  return toBase64Url(await ipHash(key, ip));
}
