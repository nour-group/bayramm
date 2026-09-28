/* Заголовки безопасности для ответов статических приложений.

   CSP рассчитан на сборку Vite + React без встроенных скриптов и стилей: код, стили и шрифты —
   только со своего origin, запросы — только на свой origin (API проксируется через /api).
   Картинки ещё из data: (узор гириха в data-URI) и blob: (превью фото до загрузки).
   Понадобится внешний источник — добавлять сюда явным параметром, а не ослаблять политику. */

export interface SecurityOptions {
  /** Кому разрешено встраивать страницу во фрейм. Пусто — никому: frame-ancestors 'none' */
  readonly frameAncestors?: readonly string[];
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

/** Значение Content-Security-Policy */
export function contentSecurityPolicy({ frameAncestors = [], dev = false }: SecurityOptions = {}): string {
  const inline = dev ? ["'unsafe-inline'"] : [];
  const directives: [string, readonly string[]][] = [
    ["default-src", ["'self'"]],
    ["script-src", ["'self'", ...inline]],
    ["style-src", ["'self'", ...inline]],
    ["img-src", ["'self'", "data:", "blob:"]],
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
