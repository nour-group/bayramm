/* «Отправить в Telegram»: текст приглашения — в выбор чата Telegram (t.me/share/url), без
   копирования и переключения приложений. В Mini App ссылку открывает сам Telegram
   (openTelegramLink — его есть не у всех клиентов, проверяем), в браузере — новая вкладка. */

import { getWebApp } from "@bayramm/tg/webapp";
import type { ReactNode } from "react";

/**
 * Ссылка «Поделиться» Telegram: link — ссылка сообщения (её Telegram покажет первой), text — всё
 * остальное. У t.me/share/url ссылка обязательна
 */
export function telegramShareUrl(link: string, text: string): string {
  return `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
}

/**
 * Первая ссылка в тексте приглашения (бот или сайт) — ссылкой сообщения; текст — целиком, чтобы
 * шаги «1. Откройте бота: …» не остались без адреса
 */
export function shareParts(message: string): { link: string; text: string } | null {
  const found = /https?:\/\/\S+/.exec(message);
  return found ? { link: found[0], text: message } : null;
}

/** Кнопка-ссылка «Отправить в Telegram»: в Mini App — через Telegram, в браузере — вкладкой */
export function ShareToTelegram({
  message,
  className = "btn",
  children,
}: {
  message: string;
  className?: string;
  children: ReactNode;
}) {
  const parts = shareParts(message);
  if (!parts) return null;
  const url = telegramShareUrl(parts.link, parts.text);
  return (
    <a
      href={url}
      className={className}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => {
        const webApp = getWebApp();
        if (typeof webApp?.openTelegramLink !== "function") return;
        event.preventDefault();
        webApp.openTelegramLink(url);
      }}
    >
      {children}
    </a>
  );
}
