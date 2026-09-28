import { apiPath, type FetcherLike, proxyToApi } from "./api-proxy";
import { type SecurityOptions, withSecurityHeaders } from "./security-headers";

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
}

/**
 * Воркер статического приложения. В wrangler.jsonc у него обязаны быть
 * `run_worker_first: true` (иначе /api/* и HTML обойдут воркер) и
 * `not_found_handling: "single-page-application"` (фолбэк SPA делает ASSETS).
 *
 * Порядок: before → /api/* в API без префикса → статика с заголовками безопасности.
 */
export function createSiteWorker(options: SiteWorkerOptions = {}) {
  return {
    async fetch(request: Request, env: SiteEnv): Promise<Response> {
      const url = new URL(request.url);

      const early = options.before?.(url);
      if (early) return early;

      const path = apiPath(url.pathname);
      if (path !== null) return proxyToApi(request, path, env.API);

      // Путь, которого нет среди файлов сборки, ASSETS отдаёт как index.html со статусом 200.
      // Заголовки ставим на всё из ASSETS: HTML они защищают, остальному не мешают
      return withSecurityHeaders(await env.ASSETS.fetch(request), options);
    },
  };
}
