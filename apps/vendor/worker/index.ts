import { createSiteWorker } from "@bayramm/edge";
import { mediaImageOrigins } from "@bayramm/media";

// Vite подставляет значение при сборке: в dist всегда false, строгий CSP
const dev = import.meta.env?.DEV === true;

// Кабинет вендора: /api/* → API, остальное — SPA. Это Mini App, открытый из бота:
// SDK telegram-web-app.js (telegramWebApp) и фрейм только в Telegram Web
export default createSiteWorker({
  dev,
  telegramWebApp: true,
  frameAncestors: ["https://web.telegram.org"],
  // Фото площадок — с воркера media
  imageOrigins: mediaImageOrigins(dev),
}) satisfies ExportedHandler<Env>;
