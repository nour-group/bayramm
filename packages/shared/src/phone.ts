// Телефоны Узбекистана: один вид хранения — +998 и 9 цифр (как в CHECK базы:
// ^\+998[0-9]{9}$). Ввод бывает любым: с пробелами, скобками, дефисами, без «+»
// или без кода страны — приводим к одному виду или отказываем.

const E164_UZ = /^\+998\d{9}$/;

/** Нормальный вид номера: «+998001234567». Не номер Узбекистана — null. */
export function normalizeUzPhone(input: string): string | null {
  const compact = input.trim().replace(/[\s().-]/g, "");
  if (!/^\+?\d+$/.test(compact)) return null;
  const digits = compact.replace(/^\+/, "");
  if (digits.length === 12 && digits.startsWith("998")) return `+${digits}`;
  // Местная запись без кода страны: 00 123 45 67
  if (digits.length === 9 && !compact.startsWith("+")) return `+998${digits}`;
  return null;
}

export function isUzPhone(value: string): boolean {
  return E164_UZ.test(value);
}

/** Для показа: «+998 00 123 45 67». Не нормальный вид — как есть. */
export function formatUzPhone(value: string): string {
  if (!E164_UZ.test(value)) return value;
  return `+998 ${value.slice(4, 6)} ${value.slice(6, 9)} ${value.slice(9, 11)} ${value.slice(11, 13)}`;
}

// ── поле ввода: девять цифр после +998 с маской ────────────────────────────
// «+998» стоит у поля, в поле — «XX XXX XX XX». Те же правила, что у PhoneField панели.

const UZ_CODE = "+998";
export const UZ_PHONE_DIGITS = 9;
const PHONE_GROUPS = [2, 3, 2, 2] as const;

/**
 * Цифры после +998 из любой записи: «+998 90 111-22-33», «998901112233», «90 111». Начатый
 * по привычке код («+», «+99») — пусто: код уже написан у поля. Чужой код (+7…) или больше
 * девяти цифр — null: не обрезаем в похожий номер, а говорим «только Узбекистан»
 */
export function readUzPhoneDigits(raw: string): string | null {
  const normal = normalizeUzPhone(raw);
  if (normal) return normal.slice(UZ_CODE.length);
  const text = raw.trim();
  const compact = text.replace(/\s+/g, "");
  if (compact !== "" && UZ_CODE.startsWith(compact)) return "";
  let digits = text.replace(/\D+/g, "");
  if (text.startsWith("+")) {
    if (!digits.startsWith("998")) return null;
    digits = digits.slice(3);
  } else if (digits.length > UZ_PHONE_DIGITS && digits.startsWith("998")) {
    // Набирают с кодом страны без «+»: на десятой цифре код уходит, номер остаётся
    digits = digits.slice(3);
  }
  return digits.length > UZ_PHONE_DIGITS ? null : digits;
}

/** «901112233» → «90 111 22 33»; неполный — сколько набрано: «90 1» */
export function maskUzPhoneDigits(digits: string): string {
  const parts: string[] = [];
  let at = 0;
  for (const size of PHONE_GROUPS) {
    if (at >= digits.length) break;
    parts.push(digits.slice(at, at + size));
    at += size;
  }
  return parts.join(" ");
}
