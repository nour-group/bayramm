import { useEffect, useRef } from "react";
import { ROUTES } from "../router";

/* Официальный виджет входа Telegram — только на страницах хаба (/auth): CSP сайта пускает
   его скрипт и фрейм oauth.telegram.org только там (telegramLoginPaths в воркере). Колбэк
   data-onauth виджет собирает через eval, а CSP eval не пропускает, поэтому data-auth-url:
   после «Войти» виджет уводит браузер на /auth/telegram?id=…&hash=…, и экран отдаёт эти
   поля API. Виджет работает только на домене, который боту задан в @BotFather /setdomain —
   его знает API (GET /auth/methods → telegram.loginDomain). */
export const TELEGRAM_WIDGET_SRC = "https://telegram.org/js/telegram-widget.js?22";

interface TelegramLoginProps {
  readonly bot: string;
  readonly onLoadError: () => void;
}

export function TelegramLogin({ bot, onLoadError }: TelegramLoginProps) {
  const slot = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = slot.current;
    if (!host) return;
    // Скрипт ставит iframe кнопки рядом с собой; данные виджета — атрибуты data-*
    const script = document.createElement("script");
    script.async = true;
    script.src = TELEGRAM_WIDGET_SRC;
    script.dataset.telegramLogin = bot;
    script.dataset.size = "large";
    script.dataset.radius = "14";
    script.dataset.authUrl = new URL(ROUTES.authTelegram, window.location.origin).href;
    script.addEventListener("error", onLoadError);
    host.append(script);
    return () => {
      script.removeEventListener("error", onLoadError);
      host.replaceChildren();
    };
  }, [bot, onLoadError]);

  return <div className="tg-login" ref={slot} />;
}
