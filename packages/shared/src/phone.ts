// Телефоны Узбекистана: один вид хранения — +998 и 9 цифр (как в CHECK базы:
// ^\+998[0-9]{9}$). Ввод бывает любым: с пробелами, скобками, дефисами, без «+»
// или без кода страны — приводим к одному виду или отказываем.

const E164_UZ = /^\+998\d{9}$/;

/** Нормальный вид номера: «+998901234567». Не номер Узбекистана — null. */
export function normalizeUzPhone(input: string): string | null {
  const compact = input.trim().replace(/[\s().-]/g, "");
  if (!/^\+?\d+$/.test(compact)) return null;
  const digits = compact.replace(/^\+/, "");
  if (digits.length === 12 && digits.startsWith("998")) return `+${digits}`;
  // Местная запись без кода страны: 90 123 45 67
  if (digits.length === 9 && !compact.startsWith("+")) return `+998${digits}`;
  return null;
}

export function isUzPhone(value: string): boolean {
  return E164_UZ.test(value);
}

/** Для показа: «+998 90 123 45 67». Не нормальный вид — как есть. */
export function formatUzPhone(value: string): string {
  if (!E164_UZ.test(value)) return value;
  return `+998 ${value.slice(4, 6)} ${value.slice(6, 9)} ${value.slice(9, 11)} ${value.slice(11, 13)}`;
}
