import type { TelegramWebApp, WebAppBottomButton } from "@bayramm/tg/webapp";
import { base } from "@bayramm/ui";
import { useEffect, useRef } from "react";

/* Обвязка SDK Mini App. Каждый вызов — через проверку наличия метода и версии клиента:
   приложение обязано работать в обычном браузере и в старом Telegram. Безопасные зоны
   SDK сам кладёт в CSS-переменные --tg-safe-area-inset-* и --tg-content-safe-area-inset-*,
   их подхватывают токены --sa-* / --csa-* (@bayramm/ui). */

/** Клиент Telegram не старше version; нет метода проверки — считаем, что старше нет */
export function supports(webApp: TelegramWebApp | null, version: string): boolean {
  try {
    return webApp?.isVersionAtLeast?.(version) === true;
  } catch {
    return false;
  }
}

/** Старт внутри Telegram: сообщить о готовности, развернуть, цвета из токенов основной темы */
export function initTelegram(webApp: TelegramWebApp): void {
  webApp.ready?.();
  webApp.expand?.();
  if (supports(webApp, "6.1")) {
    webApp.setHeaderColor?.(base.paper);
    webApp.setBackgroundColor?.(base.paper);
  }
  if (supports(webApp, "7.10")) webApp.setBottomBarColor?.(base.paper);
  // Прокрутка ленты не должна сворачивать приложение
  if (supports(webApp, "7.7")) webApp.disableVerticalSwipes?.();
}

export function haptic(webApp: TelegramWebApp | null, type: "success" | "error" | "warning"): void {
  if (!supports(webApp, "6.1")) return;
  webApp?.HapticFeedback?.notificationOccurred?.(type);
}

/** Кнопка «назад» Telegram есть (6.1+) — тогда своя в шапке не нужна */
export function hasNativeBack(webApp: TelegramWebApp | null): boolean {
  return supports(webApp, "6.1") && typeof webApp?.BackButton?.show === "function";
}

/** Главная кнопка Telegram пригодна: есть показ, текст и подписка на нажатие */
export function hasNativeMainButton(webApp: TelegramWebApp | null): boolean {
  const button = webApp?.MainButton;
  return (
    typeof button?.show === "function" &&
    typeof button.setText === "function" &&
    typeof button.onClick === "function"
  );
}

/** Показывает «назад» Telegram, пока экран на месте; нажатие — onBack */
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

export interface MainButtonOptions {
  readonly text: string;
  readonly visible: boolean;
  readonly onClick: () => void;
}

/* Цвета главной кнопки — как у своей: белый на --coral-deep (пара btnInk/coralDeep в pairs.ts) */
function paint(button: WebAppBottomButton) {
  button.setParams?.({ color: base.coralDeep, text_color: base.btnInk });
}

/**
 * Главная кнопка Telegram внизу экрана. true — она показана, и своя кнопка на странице
 * не нужна; false — SDK нет или он старый, страница рисует свою
 */
export function useMainButton(webApp: TelegramWebApp | null, { text, visible, onClick }: MainButtonOptions) {
  const handler = useRef(onClick);
  handler.current = onClick;
  const native = visible && hasNativeMainButton(webApp);

  useEffect(() => {
    if (!native) return;
    const button = webApp?.MainButton;
    if (!button) return;
    const click = () => handler.current();
    paint(button);
    button.setText?.(text);
    button.enable?.();
    button.onClick?.(click);
    button.show?.();
    return () => {
      button.offClick?.(click);
      button.hide?.();
    };
  }, [webApp, native, text]);

  return native;
}
