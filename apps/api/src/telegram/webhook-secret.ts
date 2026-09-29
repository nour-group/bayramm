// Секрет вебхука бота — не отдельный секрет окружения, а производный от ID_HASH_KEY:
// HMAC-SHA256(ID_HASH_KEY, "telegram-webhook:v1") в base64url — 43 символа из
// [A-Za-z0-9_-], как требует setWebhook. Его знают только API и Telegram (/telegram/sync
// передаёт его в secret_token); по секрету ключ не восстановить, а псевдонимы
// считаются от других сообщений (Telegram ID, +998…), так что секрет с ними не совпадёт.
//
// Сменить секрет — поднять версию в метке (v2) и выполнить /telegram/sync.

import { idHmac, toBase64Url } from "../auth/crypto";

const LABEL = "telegram-webhook:v1";

export async function webhookSecret(idHashKey: string): Promise<string> {
  return toBase64Url(await idHmac(idHashKey, LABEL));
}
