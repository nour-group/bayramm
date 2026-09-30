/* Telegram внутри кабинета. Каждый вызов SDK — через проверку наличия метода:
   кабинет обязан работать и в старом клиенте Telegram, и в обычном браузере
   (там он показывает «откройте из бота»). Безопасные зоны SDK сам кладёт в
   CSS-переменные --tg-safe-area-inset-*; их складывают токены --pad-t / --pad-b.

   SDK (telegram-web-app.js) грузит loadTelegramWebApp из @bayramm/tg/webapp — только если
   страницу открыл Telegram: в обычном браузере чужой скрипт не нужен вовсе. */

import { getWebApp, launchedFromTelegram, loadTelegramWebApp, type TelegramWebApp } from "@bayramm/tg/webapp";
import { useEffect } from "react";

export type { TelegramWebApp };
export { getWebApp, launchedFromTelegram, loadTelegramWebApp };

/** Кабинет открыт в Telegram: есть SDK с initData или адрес от Telegram */
export function inTelegram(): boolean {
  return Boolean(getWebApp()?.initData) || launchedFromTelegram();
}

/** Mini App готов: убрать заставку Telegram и развернуть на весь экран */
export function announceReady(webApp: TelegramWebApp): void {
  webApp.ready?.();
  webApp.expand?.();
}

/**
 * Кнопка «Назад» Telegram, пока экран показан; без SDK или в старом клиенте — ничего.
 * true — кнопка Telegram есть, своя ссылка «Назад» на экране не нужна.
 */
export function useBackButton(onBack: (() => void) | null): boolean {
  useEffect(() => {
    const button = getWebApp()?.BackButton;
    if (!button || !onBack) return;
    button.onClick?.(onBack);
    button.show?.();
    return () => {
      button.offClick?.(onBack);
      button.hide?.();
    };
  }, [onBack]);
  return typeof getWebApp()?.BackButton?.show === "function";
}

/** Ссылка на бота: внутри Telegram — не закрывая кабинет, в браузере — обычный переход */
export function openBotLink(url: string, event?: { preventDefault(): void }): void {
  const webApp = getWebApp();
  if (webApp?.openTelegramLink) {
    event?.preventDefault();
    webApp.openTelegramLink(url);
  }
}
