import { createSiteWorker } from "@bayramm/edge";

// Кабинет вендора: /api/* → API, остальное — SPA. Встраивать во фрейм нельзя никому
export default createSiteWorker({
  // Vite подставляет значение при сборке: в dist всегда false, строгий CSP
  dev: import.meta.env?.DEV === true,
}) satisfies ExportedHandler<Env>;
