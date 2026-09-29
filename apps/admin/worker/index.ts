import { createSiteWorker } from "@bayramm/edge";
import { mediaImageOrigins } from "@bayramm/media";

// Vite подставляет значение при сборке: в dist всегда false, строгий CSP
const dev = import.meta.env?.DEV === true;

/* Панель оператора: /api/* → API, остальное — SPA. Вход — через хаб входа на сайте
   (одноразовый код и PKCE, виджета здесь нет) или Mini App: кнопка «Панель оператора» в
   боте открывает панель в Telegram — SDK telegram-web-app.js (telegramWebApp), встраивать
   разрешено только Telegram Web. Права проверяет API: ручки панели — за сессией
   сотрудника (requireStaff), до входа доступна только статика. */
export default createSiteWorker({
  telegramWebApp: true,
  frameAncestors: ["https://web.telegram.org"],
  dev,
  // Фото площадок на модерации — с воркера media
  imageOrigins: mediaImageOrigins(dev),
}) satisfies ExportedHandler<Env>;
