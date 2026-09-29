/* Telegram внутри кабинета. Каждый вызов SDK — через проверку наличия метода:
   кабинет обязан работать и в старом клиенте Telegram, и в обычном браузере
   (там он показывает «откройте из бота»). Безопасные зоны SDK сам кладёт в
   CSS-переменные --tg-safe-area-inset-*; их складывают токены --pad-t / --pad-b.

   SDK (telegram-web-app.js) грузится из кода, а не тегом в index.html, и только если
   страницу открыл Telegram: в обычном браузере чужой скрипт не нужен вовсе. Без
   integrity: Telegram обновляет файл по тому же адресу, хэш сломал бы вход; CSP
   (telegramWebApp в @bayramm/edge) пускает ровно этот путь. */

import { TELEGRAM_WEB_APP_SCRIPT } from "@bayramm/edge";
import { getWebApp, type TelegramWebApp } from "@bayramm/tg/webapp";
import { useEffect } from "react";

export type { TelegramWebApp };
export { getWebApp };

// Telegram передаёт параметры запуска в адресе (#tgWebAppData=…&tgWebAppVersion=…),
// а SDK при загрузке сохраняет их в sessionStorage — на случай перезагрузки без них
const LAUNCH_PARAM_RE = /[#&?]tgWebApp[A-Za-z]+=/;
const SDK_SESSION_KEY = "__telegram__initParams";
const SDK_TIMEOUT_MS = 8_000;

/** Открыта ли страница из Telegram (Mini App), даже если SDK ещё не загружен */
export function launchedFromTelegram(url: { hash: string; search: string } = window.location): boolean {
  if (LAUNCH_PARAM_RE.test(url.hash) || LAUNCH_PARAM_RE.test(url.search)) return true;
  try {
    return window.sessionStorage.getItem(SDK_SESSION_KEY) !== null;
  } catch {
    return false;
  }
}

let loading: Promise<TelegramWebApp | null> | null = null;

/**
 * SDK Mini App: уже есть — сразу; страница открыта не из Telegram — null без загрузки;
 * иначе — скрипт с telegram.org (не дольше 8 секунд). Не загрузился — null, повтор
 * при следующем вызове.
 */
export function loadTelegramSdk(): Promise<TelegramWebApp | null> {
  const ready = getWebApp();
  if (ready) return Promise.resolve(ready);
  if (!launchedFromTelegram()) return Promise.resolve(null);
  loading ??= new Promise((resolve) => {
    const script = document.createElement("script");
    const done = () => {
      clearTimeout(timer);
      loading = null;
      resolve(getWebApp());
    };
    const timer = setTimeout(done, SDK_TIMEOUT_MS);
    script.addEventListener("load", done, { once: true });
    script.addEventListener("error", done, { once: true });
    script.src = TELEGRAM_WEB_APP_SCRIPT;
    document.head.append(script);
  });
  return loading;
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
