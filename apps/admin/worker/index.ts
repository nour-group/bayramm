import { createSiteWorker } from "@bayramm/edge";
import { mediaImageOrigins } from "@bayramm/media";

// Vite подставляет значение при сборке: в dist всегда false, строгий CSP
const dev = import.meta.env?.DEV === true;

/* Панель оператора: /api/* → API, остальное — SPA. Встраивать во фрейм нельзя никому.
   Вход — виджет Telegram на странице /login: CSP пускает только его скрипт и фрейм
   (telegramLogin), больше ни одному приложению это не разрешено. Права проверяет API:
   ручки панели — за сессией сотрудника (requireStaff), до входа доступна только статика. */
export default createSiteWorker({
  telegramLogin: true,
  dev,
  // Фото площадок на модерации — с воркера media
  imageOrigins: mediaImageOrigins(dev),
}) satisfies ExportedHandler<Env>;
