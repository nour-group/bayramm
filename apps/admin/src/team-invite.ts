/* Текст приглашения в панель команды — что отправить новому сотруднику: открыть бота, /start,
   кнопка панели. Без /start бот не знает его чат — оповещения команды не придут («Бот вам не
   пишет»). Номера в тексте нет: сотрудник знает свой. Панель русская — текст тоже. */

import type { StaffRole } from "@bayramm/shared/api/staff";

export interface TeamInviteFacts {
  readonly name: string;
  readonly role: StaffRole;
  /** Как войдёт: по имени в Telegram или по номеру */
  readonly by: "telegram" | "phone";
  /** Имя пользователя Telegram из приглашения (без @) */
  readonly username: string | null;
  /** Имя бота окружения (GET /auth/methods); null — Telegram не ответил: только сайт */
  readonly bot: string | null;
  /** Адрес панели окружения, без «/» в конце */
  readonly adminUrl: string;
  /** Вход по коду на телефон включён */
  readonly phoneLogin: boolean;
}

const ROLE: Readonly<Record<StaffRole, string>> = {
  admin: "администратор",
  manager: "менеджер",
  moderator: "модератор",
};

/** Панель вне Telegram: ?signin=1 сразу уводит в хаб входа */
export const adminSignInLink = (adminUrl: string): string => `${adminUrl.replace(/\/+$/, "")}/?signin=1`;

export function teamInviteText(f: TeamInviteFacts): string {
  const site = adminSignInLink(f.adminUrl);
  const lines = [
    `Здравствуйте, ${f.name}!`,
    `Вас пригласили в панель команды Bayramm — роль: ${ROLE[f.role]}.`,
    "",
  ];
  if (f.bot) {
    lines.push(
      `1. Откройте бота: https://t.me/${f.bot}`,
      "2. Нажмите «Старт» (/start) — так бот сможет присылать вам оповещения команды.",
      "3. Откройте панель кнопкой под сообщением бота.",
      "",
      f.by === "telegram"
        ? `Войти можно только с аккаунта${f.username ? ` @${f.username}` : ", имя которого вы дали"}.`
        : "Приглашение примется, когда вы подтвердите в боте или на сайте номер, который дали.",
      `Панель открывается и на сайте: ${site}`,
    );
  } else {
    lines.push(
      f.by === "phone" && f.phoneLogin
        ? `Войдите на сайте кодом на номер, который вы дали: ${site}`
        : `Войдите на сайте через Telegram: ${site}`,
    );
  }
  return lines.join("\n");
}
