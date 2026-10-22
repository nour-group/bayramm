import { formatUzPhone } from "@bayramm/shared";
import { hasTeamContact, TeamContact, type TeamContactValue } from "@bayramm/ui/react";
import type { MouseEvent } from "react";
import { isApiError } from "../api/errors";
import { useLang, useServices } from "../context";
import { useAsync } from "../hooks";
import { Icon } from "../icons";

/* Контакт команды Bayramm у клиента: настройка панели (team_telegram, team_phone) из GET
   /auth/methods — тот же запрос, что имя бота (кэш вкладки). Где он нужен: у ошибок, с которыми
   клиент сам ничего не сделает (заявки ограничены, аккаунт отключён, способ входа у другого
   аккаунта), в «О площадке» и в подвале сайта. Не указан — ни ссылок, ни «напишите нам». */

/** Коды ошибок, после которых остаётся только написать команде */
const TEAM_CODES: readonly string[] = ["client_blocked", "account_disabled", "identity_taken"];

export const needsTeam = (error: unknown): boolean => isApiError(error) && TEAM_CODES.includes(error.code);

/** Контакт команды; не указан или не узнали — null */
export function useTeamContact(): TeamContactValue | null {
  const { api } = useServices();
  const methods = useAsync("auth-methods", (signal) => api.authMethods(signal));
  // Старый API без поля team — как «не указан»
  const team = methods.status === "ready" ? (methods.data.team ?? null) : null;
  return hasTeamContact(team) ? team : null;
}

/** Ссылки «Написать в Telegram» и «Позвонить»: в Mini App Telegram открывает ссылку сам */
export function TeamLinks({
  team,
  variant = "buttons",
}: {
  team: TeamContactValue;
  variant?: "buttons" | "links";
}) {
  const { webApp } = useServices();
  const { t } = useLang();
  const openInTelegram = (href: string, event: MouseEvent<HTMLAnchorElement>) => {
    if (!webApp?.openTelegramLink) return;
    event.preventDefault();
    webApp.openTelegramLink(href);
  };
  return (
    <TeamContact
      team={team}
      variant={variant}
      telegramLabel={t.teamTelegram}
      phoneLabel={(phone) => t.teamCall(formatUzPhone(phone))}
      telegramIcon={<Icon name="tg" size={17} />}
      phoneIcon={<Icon name="phone" size={17} />}
      onTelegram={openInTelegram}
    />
  );
}

/**
 * Строка «Напишите команде…» и контакт — под ошибкой или в «О площадке»; контакта нет — ничего
 * (текст ошибки сам по себе не зовёт писать)
 */
export function TeamHelp({ lead }: { lead?: string }) {
  const { t } = useLang();
  const team = useTeamContact();
  if (!team) return null;
  return (
    <div className="team-help">
      <p className="small">{lead ?? t.teamHelp}</p>
      <TeamLinks team={team} />
    </div>
  );
}
