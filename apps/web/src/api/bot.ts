import type { AuthMethods } from "@bayramm/shared/api/account";
import { ApiError } from "./errors";
import type { BotInfo } from "./types";

/**
 * Имя бота и адрес Mini App из способов входа: GET /auth/methods уже несёт и то и другое
 * (telegram.bot — имя от getMe, apps.web — WEB_APP_URL, то же, что miniAppUrl у /telegram/bot).
 * Имени нет — Telegram не ответил: как 503 telegram_unavailable у старого маршрута
 */
export function botInfoOf(methods: AuthMethods): BotInfo {
  const username = methods.telegram.bot;
  if (!username) throw new ApiError(503, "telegram_unavailable");
  return { username, miniAppUrl: methods.apps.web };
}
