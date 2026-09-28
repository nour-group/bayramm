// Проверка, что запрос на вебхук пришёл от Telegram. Секрет задаётся параметром secret_token
// в setWebhook, Telegram возвращает его в заголовке каждого запроса.

import { sha256, timingSafeEqual, utf8 } from "./bytes";

export const WEBHOOK_SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

// Ограничения Telegram на secret_token: 1–256 символов из [A-Za-z0-9_-]
const SECRET_RE = /^[A-Za-z0-9_-]{1,256}$/;

/**
 * true, если заголовок X-Telegram-Bot-Api-Secret-Token совпадает с ожидаемым секретом.
 * Бросает исключение, если сам ожидаемый секрет не годится для setWebhook — это ошибка конфигурации.
 */
export async function verifyWebhookSecret(
  request: { readonly headers: Headers },
  expectedSecret: string,
): Promise<boolean> {
  if (typeof expectedSecret !== "string" || !SECRET_RE.test(expectedSecret)) {
    throw new Error("@bayramm/tg: секрет вебхука должен быть из [A-Za-z0-9_-], от 1 до 256 символов");
  }
  const received = request.headers.get(WEBHOOK_SECRET_HEADER);
  if (received === null) return false;
  // Сравниваем SHA-256 обеих строк: дайджесты одной длины, так что время сравнения
  // не выдаёт ни совпавший префикс, ни длину секрета
  const [a, b] = await Promise.all([sha256(utf8(received)), sha256(utf8(expectedSecret))]);
  return timingSafeEqual(a, b);
}
