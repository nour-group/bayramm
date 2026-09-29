/* Telegram Mini App в браузере: window.Telegram.WebApp из telegram-web-app.js
   (CSP: telegramWebApp в @bayramm/edge).

   Приложение обязано работать и в обычном браузере, и в старом клиенте Telegram, поэтому
   методы SDK в типе необязательные: каждый вызов — через проверку наличия (`webApp.ready?.()`).
   Данные initDataUnsafe не проверены — для прав только initData, которую сверяет сервер. */

export interface WebAppUser {
  readonly id: number;
  readonly first_name: string;
  readonly last_name?: string;
  readonly username?: string;
  readonly language_code?: string;
}

export interface WebAppInsets {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

/** Нужная нам часть SDK. Расширять по мере надобности — только необязательными методами */
export interface TelegramWebApp {
  /** Подписанная строка для POST /auth/telegram; вне Telegram — пустая */
  readonly initData: string;
  readonly initDataUnsafe: {
    readonly start_param?: string;
    readonly user?: WebAppUser;
  };
  readonly platform?: string;
  readonly version?: string;
  readonly colorScheme?: "light" | "dark";
  readonly safeAreaInset?: WebAppInsets;
  readonly contentSafeAreaInset?: WebAppInsets;
  isVersionAtLeast?(version: string): boolean;
  ready?(): void;
  expand?(): void;
  onEvent?(event: string, handler: () => void): void;
  offEvent?(event: string, handler: () => void): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * SDK, если страница открыта внутри Telegram; иначе null (обычный браузер, SDK не загрузился,
 * пустая initData). scope — для тестов, по умолчанию globalThis.
 */
export function getWebApp(scope: unknown = globalThis): TelegramWebApp | null {
  const telegram = isRecord(scope) ? scope.Telegram : undefined;
  const webApp = isRecord(telegram) ? telegram.WebApp : undefined;
  if (!isRecord(webApp)) return null;
  if (typeof webApp.initData !== "string" || webApp.initData.length === 0) return null;
  if (!isRecord(webApp.initDataUnsafe)) return null;
  return webApp as unknown as TelegramWebApp;
}
