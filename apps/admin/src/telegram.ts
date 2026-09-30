/* Панель как Mini App: обвязка SDK Telegram. Каждый вызов — через проверку наличия метода
   и версии клиента: панель обязана работать и в обычном браузере, и в старом Telegram.
   Безопасные зоны и высоту экрана SDK сам кладёт в CSS-переменные (--tg-safe-area-inset-*,
   --tg-content-safe-area-inset-*, --tg-viewport-stable-height) — их подхватывают стили. */

import type { TelegramWebApp } from "@bayramm/tg/webapp";
import { base } from "@bayramm/ui";
import { useEffect, useRef } from "react";

/** Клиент Telegram не старше version; нет метода проверки — считаем, что старше нет */
export function supports(webApp: TelegramWebApp | null, version: string): boolean {
  try {
    return webApp?.isVersionAtLeast?.(version) === true;
  } catch {
    return false;
  }
}

/** Класс на <html>: панель внутри Telegram — страница не пружинит (styles.css) */
export const IN_TELEGRAM_CLASS = "in-telegram";

/**
 * Старт внутри Telegram: готовность, во весь экран, цвета шапки, фона и нижней полосы —
 * из токенов основной темы (шапка панели белая, фон — бумага, нижняя панель — railBg),
 * прокрутка списка не сворачивает приложение
 */
export function initTelegram(webApp: TelegramWebApp, root: Element | null = document.documentElement): void {
  webApp.ready?.();
  webApp.expand?.();
  if (supports(webApp, "6.1")) {
    webApp.setHeaderColor?.(base.white);
    webApp.setBackgroundColor?.(base.paper);
  }
  if (supports(webApp, "7.10")) webApp.setBottomBarColor?.(base.railBg);
  if (supports(webApp, "7.7")) webApp.disableVerticalSwipes?.();
  root?.classList.add(IN_TELEGRAM_CLASS);
}

/** Кнопка «назад» Telegram есть (6.1+) — тогда своя в шапке не нужна */
export function hasNativeBack(webApp: TelegramWebApp | null): boolean {
  return supports(webApp, "6.1") && typeof webApp?.BackButton?.show === "function";
}

/** Показывает «назад» Telegram, пока экран вложенный; нажатие — onBack */
export function useBackButton(webApp: TelegramWebApp | null, visible: boolean, onBack: () => void): void {
  const handler = useRef(onBack);
  handler.current = onBack;

  useEffect(() => {
    if (!visible || !hasNativeBack(webApp)) return;
    const button = webApp?.BackButton;
    const onClick = () => handler.current();
    button?.onClick?.(onClick);
    button?.show?.();
    return () => {
      button?.offClick?.(onClick);
      button?.hide?.();
    };
  }, [webApp, visible]);
}
