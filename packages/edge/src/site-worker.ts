import { apiPath, type FetcherLike, proxyToApi } from "./api-proxy";
import { cacheControlFor, isMissingAsset, missingAsset } from "./cache-headers";
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
  /**
   * Пути страниц, где разрешён виджет Cloudflare Turnstile (скрипт и фрейм
   * challenges.cloudflare.com): сам путь и всё под ним, как telegramLoginPaths
   */
  readonly turnstilePaths?: readonly string[];
}

// Путь страницы виджета — «/auth» и всё под «/auth/»; «/authx» — нет
function underPath(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

/** Пути страниц с виджетом: «/auth», «/a/b»; без «/» в конце, звёздочек и пробелов */
function checkPaths(name: string, paths: readonly string[]): readonly string[] {
  for (const path of paths) {
    if (!/^\/[a-z0-9/-]*[a-z0-9]$/.test(path)) throw new TypeError(`${name}: путь ${JSON.stringify(path)}`);
  }
  return paths;
}

/**
 * Воркер статического приложения. В wrangler.jsonc у него обязаны быть
 * `run_worker_first: true` (иначе /api/* и HTML обойдут воркер) и
 * `not_found_handling: "single-page-application"` (фолбэк SPA делает ASSETS).
 *
 * Порядок: before → /api/* в API без префикса → статика с заголовками безопасности и
 * кэша (cache-headers.ts: файлы сборки — год, страницы — со сверкой).
 */
export function createSiteWorker(options: SiteWorkerOptions = {}) {
  const loginPaths = checkPaths("telegramLoginPaths", options.telegramLoginPaths ?? []);
  const turnstilePaths = checkPaths("turnstilePaths", options.turnstilePaths ?? []);
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
      const turnstile = turnstilePaths.some((base) => underPath(url.pathname, base));
      const security: SecurityOptions =
        login || turnstile
          ? {
              ...options,
              telegramLogin: options.telegramLogin === true || login,
              turnstile: options.turnstile === true || turnstile,
            }
          : options;
      const response = await env.ASSETS.fetch(request);
      // Сервер разработки Vite кэшем управляет сам
      if (options.dev) return withSecurityHeaders(response, security);
      if (isMissingAsset(url.pathname, response)) {
        await response.body?.cancel();
        return withSecurityHeaders(missingAsset(), security);
      }
      const secured = withSecurityHeaders(response, security);
      const cacheControl = cacheControlFor(url.pathname, secured);
      if (cacheControl !== null) secured.headers.set("Cache-Control", cacheControl);
      return secured;
    },
  };
}
