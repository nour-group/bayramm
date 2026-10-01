/* Только HTTPS — у всех воркеров: сайт, кабинет, панель, API и media.

   · Запрос по http:// — постоянный редирект на тот же адрес с https://: 301 для GET и HEAD,
     308 для остальных (метод и тело сохраняются — POST не превращается в GET). Свой компьютер
     (localhost, 127.0.0.1, [::1]) — без редиректа: wrangler dev и тесты ходят по http.
   · Strict-Transport-Security: браузер год помнит, что хост только HTTPS, и сам меняет
     http:// на https:// ещё до запроса. Без includeSubDomains — каждый поддомен (vendor, admin,
     api, media) ставит заголовок себе сам, а за прочие поддомены зоны этот код не отвечает; без
     preload — это решение на годы, его принимают отдельно. По http:// браузер заголовок
     не принимает, поэтому у редиректа его нет. */

/** Значение Strict-Transport-Security: год */
export const HSTS = "max-age=31536000";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Свой компьютер: http без редиректа */
export function isLoopback(hostname: string): boolean {
  return LOOPBACK.has(hostname) || hostname.endsWith(".localhost");
}

/** Редирект http:// → https://; null — запрос уже по HTTPS (или на свой компьютер) */
export function httpsRedirect(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.protocol !== "http:" || isLoopback(url.hostname)) return null;
  url.protocol = "https:";
  const status = request.method === "GET" || request.method === "HEAD" ? 301 : 308;
  return new Response(null, { status, headers: { Location: url.toString() } });
}
