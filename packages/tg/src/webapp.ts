/* Telegram Mini App в браузере: window.Telegram.WebApp из telegram-web-app.js
   (CSP: telegramWebApp в @bayramm/edge).

   Приложение обязано работать и в обычном браузере, и в старом клиенте Telegram, поэтому
   методы SDK в типе необязательные: каждый вызов — через проверку наличия (`webApp.ready?.()`).
   Данные initDataUnsafe не проверены — для прав только initData, которую сверяет сервер.

   SDK грузит loadTelegramWebApp — из кода, а не тегом в index.html, и только если страницу
   открыл Telegram: в обычном браузере чужой скрипт не нужен вовсе. */

/**
 * Адрес SDK Mini App. Путь точный — CSP (@bayramm/edge) пускает ровно его. Без integrity:
 * Telegram обновляет файл по тому же адресу, хэш сломал бы Mini App
 */
export const TELEGRAM_WEB_APP_SCRIPT = "https://telegram.org/js/telegram-web-app.js";

/** Сколько ждать SDK, прежде чем решить, что он не загрузится */
export const SDK_TIMEOUT_MS = 8_000;

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

/** Кнопка внизу экрана Telegram (MainButton): текст, видимость, активность, нажатие */
export interface WebAppBottomButton {
  readonly isVisible?: boolean;
  readonly isActive?: boolean;
  setText?(text: string): void;
  show?(): void;
  hide?(): void;
  enable?(): void;
  disable?(): void;
  showProgress?(leaveActive?: boolean): void;
  hideProgress?(): void;
  /** Цвета — «#RRGGBB» */
  setParams?(params: {
    readonly text?: string;
    readonly color?: string;
    readonly text_color?: string;
    readonly is_active?: boolean;
    readonly is_visible?: boolean;
  }): void;
  onClick?(handler: () => void): void;
  offClick?(handler: () => void): void;
}

/** Кнопка «назад» в шапке Telegram (с версии 6.1) */
export interface WebAppBackButton {
  readonly isVisible?: boolean;
  show?(): void;
  hide?(): void;
  onClick?(handler: () => void): void;
  offClick?(handler: () => void): void;
}

/** Тактильный отклик (с версии 6.1) */
export interface WebAppHapticFeedback {
  impactOccurred?(style: "light" | "medium" | "heavy" | "rigid" | "soft"): void;
  notificationOccurred?(type: "error" | "success" | "warning"): void;
  selectionChanged?(): void;
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
  readonly MainButton?: WebAppBottomButton;
  readonly BackButton?: WebAppBackButton;
  readonly HapticFeedback?: WebAppHapticFeedback;
  isVersionAtLeast?(version: string): boolean;
  ready?(): void;
  expand?(): void;
  /** Цвет шапки и фона Telegram: «#RRGGBB» (с версии 6.1) */
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  /** Цвет полосы под нижними кнопками (с версии 7.10) */
  setBottomBarColor?(color: string): void;
  /** Свайп вниз не сворачивает приложение (с версии 7.7) */
  disableVerticalSwipes?(): void;
  /** Ссылка t.me внутри Telegram, без выхода в браузер */
  openTelegramLink?(url: string): void;
  /** Спросить разрешение боту писать пользователю первым (с версии 6.9) */
  requestWriteAccess?(callback?: (granted: boolean) => void): void;
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

// ── загрузка SDK ───────────────────────────────────────────────────────────

/** Нужная загрузчику часть окна браузера: в тестах — подделка без DOM */
interface ScriptLike {
  src: string;
  addEventListener(type: "load" | "error", listener: () => void, options?: { once?: boolean }): void;
}

interface BrowserScope {
  readonly location?: { readonly hash: string; readonly search: string };
  readonly sessionStorage?: { getItem(key: string): string | null };
  readonly document?: {
    createElement(tag: "script"): ScriptLike;
    readonly head: { append(node: ScriptLike): void };
  };
}

// Telegram передаёт параметры запуска в адресе (#tgWebAppData=…&tgWebAppVersion=…),
// а SDK при загрузке сохраняет их в sessionStorage — на случай перезагрузки без них
const LAUNCH_PARAM_RE = /[#&?]tgWebApp[A-Za-z]+=/;
const SDK_SESSION_KEY = "__telegram__initParams";

/** Открыта ли страница из Telegram (Mini App), даже если SDK ещё не загружен */
export function launchedFromTelegram(scope: unknown = globalThis): boolean {
  if (!isRecord(scope)) return false;
  const { location, sessionStorage } = scope as BrowserScope;
  if (location && (LAUNCH_PARAM_RE.test(location.hash) || LAUNCH_PARAM_RE.test(location.search))) return true;
  try {
    return (sessionStorage?.getItem(SDK_SESSION_KEY) ?? null) !== null;
  } catch {
    // хранилище запрещено (приватный режим, старый вебвью)
    return false;
  }
}

// Одна загрузка на окно: несколько вызовов при старте ждут один и тот же скрипт
const loading = new WeakMap<object, Promise<TelegramWebApp | null>>();

/**
 * SDK Mini App: уже есть — сразу; страница открыта не из Telegram — null без загрузки
 * (обычный браузер не тянет чужой скрипт); иначе — скрипт TELEGRAM_WEB_APP_SCRIPT, ждём
 * не дольше timeoutMs. Не загрузился — null, следующий вызов пробует снова.
 * scope — для тестов, по умолчанию globalThis.
 */
export function loadTelegramWebApp(
  scope: unknown = globalThis,
  timeoutMs: number = SDK_TIMEOUT_MS,
): Promise<TelegramWebApp | null> {
  const ready = getWebApp(scope);
  if (ready) return Promise.resolve(ready);
  if (!isRecord(scope) || !launchedFromTelegram(scope)) return Promise.resolve(null);
  const doc = (scope as BrowserScope).document;
  if (!doc) return Promise.resolve(null);

  const pending = loading.get(scope);
  if (pending) return pending;
  const attempt = new Promise<TelegramWebApp | null>((resolve) => {
    const script = doc.createElement("script");
    let settled = false;
    // Первое из трёх: загрузка, ошибка, время вышло. Опоздавший load старой попытки
    // не трогает следующую
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (loading.get(scope) === attempt) loading.delete(scope);
      resolve(getWebApp(scope));
    };
    const timer = setTimeout(done, timeoutMs);
    script.addEventListener("load", done, { once: true });
    script.addEventListener("error", done, { once: true });
    script.src = TELEGRAM_WEB_APP_SCRIPT;
    doc.head.append(script);
  });
  loading.set(scope, attempt);
  return attempt;
}
