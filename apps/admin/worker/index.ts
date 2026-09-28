import { createSiteWorker } from "@bayramm/edge";

/* Панель оператора: /api/* → API, остальное — SPA. Встраивать во фрейм нельзя никому.
   Вход — Cloudflare Access перед воркером, своей формы входа нет. Админские ручки API
   проверяют JWT Access (заголовок Cf-Access-Jwt-Assertion) сами: API доступно и напрямую. */
export default createSiteWorker({
  // Vite подставляет значение при сборке: в dist всегда false, строгий CSP
  dev: import.meta.env?.DEV === true,
}) satisfies ExportedHandler<Env>;
