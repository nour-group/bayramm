import { createSiteWorker } from "@bayramm/edge";
import { mediaImageOrigins } from "@bayramm/media";

// Vite подставляет значение при сборке: в dist всегда false, строгий CSP
const dev = import.meta.env?.DEV === true;

// Кабинет вендора: /api/* → API, остальное — SPA. Встраивать во фрейм нельзя никому
export default createSiteWorker({
  dev,
  // Фото площадок — с воркера media
  imageOrigins: mediaImageOrigins(dev),
}) satisfies ExportedHandler<Env>;
