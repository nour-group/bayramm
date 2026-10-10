// Имя пользователя или канала Telegram — как его вписывают люди: «name», «@name», «t.me/name»,
// «https://t.me/name/». Правила Telegram: 5–32 знака, латиница, цифры и «_», с буквы, не на «_».
// Один разбор для панели и API: форма проверяет до отправки так же, как сервер.

export const TELEGRAM_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{3,30}[A-Za-z0-9]$/;

/** Без обёртки: пробелы, https://, t.me/ или telegram.me/, «@», «/» в конце. Само имя не проверяет */
export function stripTelegram(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^(www\.)?(t\.me|telegram\.me)\//i, "")
    .replace(/^@/, "")
    .replace(/\/$/, "");
}

/** Имя Telegram из того, как его вписали: @name, t.me/name, https://t.me/name; иначе null */
export function normalizeTelegram(raw: string): string | null {
  const name = stripTelegram(raw);
  return TELEGRAM_NAME_RE.test(name) ? name : null;
}
