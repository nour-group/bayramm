import { createSiteWorker } from "@bayramm/edge";

/* Панель оператора: /api/* → API, остальное — SPA. Встраивать во фрейм нельзя никому.
   Вход — виджет Telegram на странице /login: CSP пускает только его скрипт и фрейм
   (telegramLogin), больше ни одному приложению это не разрешено. Права проверяет API:
   ручки панели — за сессией сотрудника (requireStaff), до входа доступна только статика. */
export default createSiteWorker({
  telegramLogin: true,
  // Vite подставляет значение при сборке: в dist всегда false, строгий CSP
  dev: import.meta.env?.DEV === true,
}) satisfies ExportedHandler<Env>;
