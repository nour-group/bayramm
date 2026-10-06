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

const HEX_GROUP_RE = /^[0-9a-f]{1,4}$/;

/**
 * Адрес для лимитов частоты: IPv6 — его сеть /64 (столько провайдер выдаёт одному абоненту;
 * иначе каждый адрес из неё — новый ключ, и лимит по IP не работает), IPv4 и IPv4 в IPv6
 * (::ffff:a.b.c.d) — сам адрес. Непонятная строка — как есть
 */
export function limitAddress(ip: string): string {
  const addr = ip.trim().toLowerCase().split("%")[0] ?? "";
  if (!addr.includes(":")) return addr;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr)?.[1];
  if (mapped) return mapped;
  const parts = addr.split("::");
  if (parts.length > 2) return addr;
  const left = parts[0] ? parts[0].split(":") : [];
  const right = parts[1] ? parts[1].split(":") : [];
  let groups: string[];
  if (parts.length === 1) groups = left;
  else {
    const missing = 8 - left.length - right.length;
    if (missing < 1) return addr;
    groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  }
  if (groups.length !== 8 || !groups.every((g) => HEX_GROUP_RE.test(g))) return addr;
  const net = groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, ""));
  return `${net.join(":")}::/64`;
}

/** Псевдоним IP текущего запроса или null, если адреса нет. */
export async function requestIpHash(headers: Headers, key: string): Promise<Uint8Array | null> {
  const ip = clientIp(headers);
  return ip === null ? null : ipHash(key, ip);
}

/** Псевдоним адреса для лимитов (limitAddress: IPv6 — сеть /64) или null, если адреса нет. */
export async function requestLimitIpHash(headers: Headers, key: string): Promise<Uint8Array | null> {
  const ip = clientIp(headers);
  return ip === null ? null : ipHash(key, limitAddress(ip));
}

/** Псевдоним адреса для лимитов строкой — ключ ограничения частоты (IPv6 — сеть /64). */
export async function ipKey(key: string, ip: string): Promise<string> {
  return toBase64Url(await ipHash(key, limitAddress(ip)));
}
