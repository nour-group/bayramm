/* Контакт команды Bayramm: «Написать в Telegram» и «Позвонить» — что из них указано (настройка
   панели team_telegram и team_phone; всем отдаёт GET /auth/methods — контакт компании, не ПДн).
   Не указано ничего — компонента нет: кнопка «связаться» в никуда хуже, чем её нет, и текст рядом
   не должен звать «напишите нам». Слова — пропсами из словаря приложения; Telegram внутри Mini App
   приложение открывает само (onTelegram: openTelegramLink). */

import type { MouseEvent, ReactNode } from "react";

export interface TeamContactValue {
  /** Имя в Telegram без @ */
  readonly telegram: string | null;
  /** +998XXXXXXXXX */
  readonly phone: string | null;
}

/** Указан ли хоть один способ связи */
export const hasTeamContact = (team: TeamContactValue | null | undefined): team is TeamContactValue =>
  Boolean(team && (team.telegram || team.phone));

export interface TeamContactProps {
  readonly team: TeamContactValue | null | undefined;
  /** «Написать в Telegram» */
  readonly telegramLabel: string;
  /** «Позвонить: +998 90 111 22 33» — номер приходит как есть (+998…), формат — у приложения */
  readonly phoneLabel: (phone: string) => string;
  /** Иконки приложения слева от подписи */
  readonly telegramIcon?: ReactNode;
  readonly phoneIcon?: ReactNode;
  /** buttons — кнопками (по умолчанию), links — ссылками строкой (подвал) */
  readonly variant?: "buttons" | "links";
  /** Нажали «Написать в Telegram»: Mini App открывает ссылку сам (event.preventDefault) */
  readonly onTelegram?: (href: string, event: MouseEvent<HTMLAnchorElement>) => void;
  readonly className?: string;
}

export function TeamContact({
  team,
  telegramLabel,
  phoneLabel,
  telegramIcon,
  phoneIcon,
  variant = "buttons",
  onTelegram,
  className,
}: TeamContactProps) {
  if (!hasTeamContact(team)) return null;
  const telegram = team.telegram ? `https://t.me/${encodeURIComponent(team.telegram)}` : null;
  const link = variant === "buttons" ? "ui-btn ui-btn-secondary ui-team-link" : "ui-team-link";
  return (
    <div
      className={[variant === "links" ? "ui-team ui-team-links" : "ui-team", className]
        .filter(Boolean)
        .join(" ")}
    >
      {telegram ? (
        <a
          className={link}
          href={telegram}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => onTelegram?.(telegram, event)}
        >
          {telegramIcon}
          {telegramLabel}
        </a>
      ) : null}
      {team.phone ? (
        <a className={link} href={`tel:${team.phone}`}>
          {phoneIcon}
          {phoneLabel(team.phone)}
        </a>
      ) : null}
    </div>
  );
}
