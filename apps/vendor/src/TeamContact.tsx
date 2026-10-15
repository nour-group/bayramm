/* Контакт команды Bayramm — настройка панели (team_telegram, team_phone), его отдаёт всем
   GET /auth/methods (контакт компании, не ПДн). Где он нужен: будущему партнёру на экране входа
   («Стать партнёром»), партнёру — в «Аккаунте» («Команда Bayramm») и у дня, который закрыл
   менеджер. Не указан — ничего не показываем: кнопка «связаться» в никуда хуже, чем её нет.
   Telegram внутри Mini App открывается самим Telegram (openTelegramLink), снаружи — ссылкой. */

import { formatUzPhone } from "@bayramm/shared";
import type { AuthMethods } from "@bayramm/shared/api/account";
import { type MouseEvent, useEffect, useState } from "react";
import { authMethods } from "./hub";
import { fill, type VendorDict } from "./i18n";
import { Icon } from "./icons";
import { openBotLink } from "./telegram";

export type TeamContact = AuthMethods["team"];

/** Контакт команды из GET /auth/methods (один запрос на страницу); null — не узнали или не указан */
export function useTeamContact(): TeamContact | null {
  const [team, setTeam] = useState<TeamContact | null>(null);
  useEffect(() => {
    let active = true;
    void authMethods().then((methods) => {
      // Старый API без поля team — как «не указан»
      const contact = methods?.team ?? null;
      if (active) setTeam(contact && (contact.telegram || contact.phone) ? contact : null);
    });
    return () => {
      active = false;
    };
  }, []);
  return team;
}

/** «Написать в Telegram» и «Позвонить: +998 …» — что из них указано */
export function TeamContactLinks({ t, team }: { t: VendorDict; team: TeamContact }) {
  const telegram = team.telegram ? `https://t.me/${team.telegram}` : null;
  return (
    <div className="team-links">
      {telegram ? (
        <a
          className="btn btn-ghost"
          href={telegram}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event: MouseEvent<HTMLAnchorElement>) => openBotLink(telegram, event)}
        >
          {t.teamWrite}
        </a>
      ) : null}
      {team.phone ? (
        <a className="btn btn-ghost" href={`tel:${team.phone}`}>
          <Icon name="phone" size={17} />
          {fill(t.teamCall, { phone: formatUzPhone(team.phone) })}
        </a>
      ) : null}
    </div>
  );
}

/** Контакт команды строкой ссылок под сообщением (день закрыл менеджер); не указан — ничего */
export function TeamContactInline({ t }: { t: VendorDict }) {
  const team = useTeamContact();
  return team ? <TeamContactLinks t={t} team={team} /> : null;
}
