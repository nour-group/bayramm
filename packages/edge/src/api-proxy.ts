/** Минимум, который нужен от привязки воркера (ASSETS, сервисная привязка API) */
export interface FetcherLike {
  fetch(request: Request): Promise<Response>;
}

/** Префикс, под которым приложение отдаёт API на своём origin */
export const API_PREFIX = "/api";

/**
 * Путь запроса в API без префикса: /api/health → /health, /api → /.
 * Для остальных путей — null, в том числе для /apix и /api-docs.
 */
export function apiPath(pathname: string): string | null {
  if (pathname === API_PREFIX) return "/";
  if (pathname.startsWith(`${API_PREFIX}/`)) return pathname.slice(API_PREFIX.length);
  return null;
}

/**
 * Пересылает запрос в API по сервисной привязке с путём без префикса. Метод, заголовки,
 * тело и query сохраняются. Без привязки — 503, а не молчаливый уход в SPA.
 */
export async function proxyToApi(
  request: Request,
  path: string,
  api: FetcherLike | undefined,
): Promise<Response> {
  if (!api) return Response.json({ error: "api_unavailable" }, { status: 503 });
  const target = new URL(request.url);
  target.pathname = path;
  return api.fetch(new Request(target, request));
}
