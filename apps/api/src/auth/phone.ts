// Телефон в нормальной форме: +998 и 9 цифр — как в базе (CHECK ^\+998[0-9]{9}$)
// и в сообщении HMAC телефона (phoneHash). Telegram отдаёт номер контакта без
// «+» («998001234567»), люди пишут с пробелами, скобками и дефисами.

const SEPARATORS_RE = /[\s()-]/g;
const UZ_PHONE_RE = /^\+?998([0-9]{9})$/;

/** Узбекский номер → «+998XXXXXXXXX»; другой страны или не номер — null */
export function normalizeUzPhone(raw: string): string | null {
  if (typeof raw !== "string" || raw.length > 32) return null;
  const match = UZ_PHONE_RE.exec(raw.trim().replace(SEPARATORS_RE, ""));
  return match ? `+998${match[1]}` : null;
}
