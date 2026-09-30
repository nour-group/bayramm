/* Заголовки безопасности для ответов статических приложений.

   CSP рассчитан на сборку Vite + React без встроенных скриптов и стилей: код, стили и шрифты —
   только со своего origin, запросы — только на свой origin (API проксируется через /api).
   Картинки ещё из data: (узор гириха в data-URI), blob: (превью фото до загрузки) и с воркера
   media (imageOrigins — фото площадок).
   Понадобится внешний источник — добавлять сюда явным параметром, а не ослаблять политику. */

import { TELEGRAM_WEB_APP_SCRIPT } from "@bayramm/tg/webapp";

/* Виджет входа Telegram: скрипт telegram-widget.js (путь точный — остальной telegram.org не
   нужен) и кнопка входа во фрейме с oauth.telegram.org. Колбэк data-onauth виджет собирает
   через eval — его CSP не пропустит; панель берёт данные через редирект data-auth-url */
export const TELEGRAM_WIDGET_SCRIPT = "https://telegram.org/js/telegram-widget.js";
export const TELEGRAM_OAUTH_ORIGIN = "https://oauth.telegram.org";

/* Cloudflare Turnstile (проверка «не робот» перед кодом на телефон): скрипт api.js и фрейм
   с виджетом — оба с challenges.cloudflare.com. Виджет рисуется явно (render=explicit) из
   кода приложения, встроенного скрипта и колбэка по имени нет */
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/* SDK Mini App: telegram-web-app.js (путь точный). С клиентом Telegram он говорит через
   postMessage и мост вебвью — других источников ему не нужно. Адрес — один на CSP и на
   загрузчик SDK (loadTelegramWebApp в @bayramm/tg/webapp) */
export { TELEGRAM_WEB_APP_SCRIPT };

export interface SecurityOptions {
  /** Кому разрешено встраивать страницу во фрейм. Пусто — никому: frame-ancestors 'none' */
  readonly frameAncestors?: readonly string[];
  /**
   * Виджет входа Telegram: разрешить его скрипт и фрейм. Только панели оператора — у клиента
   * и кабинета вендора этих источников нет
   */
  readonly telegramLogin?: boolean;
  /** SDK Mini App (telegram-web-app.js): клиент и кабинет вендора, открытые в Telegram */
  readonly telegramWebApp?: boolean;
  /**
   * Виджет Cloudflare Turnstile: его скрипт и фрейм (challenges.cloudflare.com). Только
   * страницам, где он нужен, — у сайта это хаб входа (turnstilePaths воркера)
   */
  readonly turnstile?: boolean;
  /**
   * Откуда ещё можно грузить картинки (img-src): origin вида https://host[:port], без пути.
   * Для фото площадок — воркер media. http: допустим только вместе с dev
   */
  readonly imageOrigins?: readonly string[];
  /**
   * Сервер разработки Vite. Он вставляет в HTML встроенную преамбулу React Refresh, добавляет
   * стили из JS и держит WebSocket для HMR — без послаблений страница не запустится.
   * В сборке всегда false.
   */
  readonly dev?: boolean;
}

/* Возможности браузера, которые приложениям не нужны. Пустой список () запрещает их
   и странице, и любому фрейму внутри. Только общепринятые имена — неизвестные браузер
   пишет в консоль предупреждением. */
const DENIED_FEATURES = [
  "accelerometer",
  "camera",
  "geolocation",
  "gyroscope",
  "magnetometer",
  "microphone",
  "payment",
  "usb",
] as const;

export const PERMISSIONS_POLICY = DENIED_FEATURES.map((feature) => `${feature}=()`).join(", ");

export const REFERRER_POLICY = "strict-origin-when-cross-origin";

/* Источник в CSP — только чистый origin: путь, звёздочка или лишний пробел в строке
   расширили бы политику незаметно. Ошибка настройки — исключение при создании воркера */
function assertOrigin(value: string, dev: boolean): string {
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  const allowed = url?.protocol === "https:" || (dev && url?.protocol === "http:");
  // URL пропускает «*» в имени хоста, а для CSP это шаблон на все поддомены
  if (!url || !allowed || url.origin !== value || !/^[a-z0-9.-]+$/.test(url.hostname)) {
    throw new TypeError(`imageOrigins: ожидался origin https://host, получено ${JSON.stringify(value)}`);
  }
  return value;
}

/** Значение Content-Security-Policy */
export function contentSecurityPolicy({
  frameAncestors = [],
  telegramLogin = false,
  telegramWebApp = false,
  turnstile = false,
  imageOrigins = [],
  dev = false,
}: SecurityOptions = {}): string {
  const images = imageOrigins.map((origin) => assertOrigin(origin, dev));
  const inline = dev ? ["'unsafe-inline'"] : [];
  const frames = [
    ...(telegramLogin ? [TELEGRAM_OAUTH_ORIGIN] : []),
    ...(turnstile ? [TURNSTILE_ORIGIN] : []),
  ];
  const directives: [string, readonly string[]][] = [
    ["default-src", ["'self'"]],
    [
      "script-src",
      [
        "'self'",
        ...(telegramLogin ? [TELEGRAM_WIDGET_SCRIPT] : []),
        ...(telegramWebApp ? [TELEGRAM_WEB_APP_SCRIPT] : []),
        ...(turnstile ? [TURNSTILE_ORIGIN] : []),
        ...inline,
      ],
    ],
    // Без виджетов frame-src не задаём: фреймы подчиняются default-src 'self'
    ...(frames.length > 0 ? [["frame-src", frames] as [string, string[]]] : []),
    ["style-src", ["'self'", ...inline]],
    ["img-src", ["'self'", "data:", "blob:", ...images]],
    ["font-src", ["'self'"]],
    ["connect-src", ["'self'", ...(dev ? ["ws:", "wss:"] : [])]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'none'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", frameAncestors.length > 0 ? frameAncestors : ["'none'"]],
  ];
  return directives.map(([name, sources]) => `${name} ${sources.join(" ")}`).join("; ");
}

/** Набор заголовков безопасности */
export function securityHeaders(options: SecurityOptions = {}): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Security-Policy": contentSecurityPolicy(options),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": REFERRER_POLICY,
    "Permissions-Policy": PERMISSIONS_POLICY,
  };
  // Для старых браузеров без frame-ancestors. Список разрешённых origin в X-Frame-Options
  // не выразить, поэтому при непустом frameAncestors заголовок не ставим
  if (!options.frameAncestors?.length) headers["X-Frame-Options"] = "DENY";
  return headers;
}

/** Копия ответа с заголовками безопасности (заголовки ответа ASSETS неизменяемы) */
export function withSecurityHeaders(response: Response, options: SecurityOptions = {}): Response {
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(securityHeaders(options))) secured.headers.set(name, value);
  return secured;
}
