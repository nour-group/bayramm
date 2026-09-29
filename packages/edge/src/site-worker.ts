import { apiPath, type FetcherLike, proxyToApi } from "./api-proxy";
import { contentSecurityPolicy, type SecurityOptions, withSecurityHeaders } from "./security-headers";

/** Привязки воркера статического приложения */
export interface SiteEnv {
  /** Статика сборки Vite */
  readonly ASSETS: FetcherLike;
  /** Сервисная привязка к воркеру API */
  readonly API?: FetcherLike;
}

export interface SiteWorkerOptions extends SecurityOptions {
  /** Ответ до маршрутизации (например, редирект старой ссылки); null — идти дальше */
  readonly before?: (url: URL) => Response | null;
  /**
   * Пути страниц, где разрешён виджет входа Telegram (его скрипт и фрейм): сам путь и всё
   * под ним. Остальные страницы приложения — без него. Только для полной загрузки
   * документа: CSP страницы задаёт ответ, с которым она загружена
   */
  readonly telegramLoginPaths?: readonly string[];
}

// Путь страницы виджета — «/auth» и всё под «/auth/»; «/authx» — нет
function underPath(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

/**
 * Воркер статического приложения. В wrangler.jsonc у него обязаны быть
 * `run_worker_first: true` (иначе /api/* и HTML обойдут воркер) и
 * `not_found_handling: "single-page-application"` (фолбэк SPA делает ASSETS).
 *
 * Порядок: before → /api/* в API без префикса → статика с заголовками безопасности.
 */
export function createSiteWorker(options: SiteWorkerOptions = {}) {
  const loginPaths = options.telegramLoginPaths ?? [];
  for (const path of loginPaths) {
    if (!/^\/[a-z0-9/-]*[a-z0-9]$/.test(path))
      throw new TypeError(`telegramLoginPaths: путь ${JSON.stringify(path)}`);
  }
  const withLogin: SecurityOptions = { ...options, telegramLogin: true };
  // Неверный источник в параметрах — ошибка при загрузке модуля, а не на первом запросе
  contentSecurityPolicy(options);
  return {
    async fetch(request: Request, env: SiteEnv): Promise<Response> {
      const url = new URL(request.url);

      const early = options.before?.(url);
      if (early) return early;

      const path = apiPath(url.pathname);
      if (path !== null) return proxyToApi(request, path, env.API);

      // Путь, которого нет среди файлов сборки, ASSETS отдаёт как index.html со статусом 200.
      // Заголовки ставим на всё из ASSETS: HTML они защищают, остальному не мешают
      const login = loginPaths.some((base) => underPath(url.pathname, base));
      return withSecurityHeaders(await env.ASSETS.fetch(request), login ? withLogin : options);
    },
  };
}
