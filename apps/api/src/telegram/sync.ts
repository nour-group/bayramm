// Применение профиля бота (bot-profile.ts): вызовы по очереди, отчёт по каждому.
//
// Неудача одного вызова не останавливает остальные — отчёт показывает всё
// сразу, а повторный запуск доделает то, что не прошло. Наружу — только метод,
// язык, причина и код; описание ошибки от Telegram — в лог.

import type { BotProfileStep, ProfileLanguage } from "./bot-profile";
import {
  type BotApiCall,
  type BotApiMethod,
  type TelegramClient,
  TelegramError,
  type TelegramFailure,
} from "./client";

export type SyncResult =
  | { method: BotApiMethod; language: ProfileLanguage; ok: true }
  | { method: BotApiMethod; language: ProfileLanguage; ok: false; error: TelegramFailure; status: number };

// Метод и параметры одного вызова связаны через M — без приведения типов
function send<M extends BotApiMethod>(client: TelegramClient, call: BotApiCall<M>) {
  return client.call(call.method, call.params);
}

export async function syncBotProfile(
  client: TelegramClient,
  steps: readonly BotProfileStep[],
): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  // По очереди, не параллельно: у Telegram лимиты на частоту, а порядок отчёта — порядок применения
  for (const step of steps) {
    const { method, language } = step;
    try {
      await send(client, step);
      results.push({ method, language, ok: true });
    } catch (err) {
      if (!(err instanceof TelegramError)) throw err;
      console.warn("telegram.sync: step failed", {
        method,
        language,
        reason: err.reason,
        status: err.status,
        description: err.description,
      });
      results.push({ method, language, ok: false, error: err.reason, status: err.status });
    }
  }
  return results;
}
