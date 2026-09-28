import { createSiteWorker } from "@bayramm/edge";
import { taklifnomaRedirect } from "./legacy";

export default createSiteWorker({
  // Vite подставляет значение при сборке: в dist всегда false, строгий CSP
  dev: import.meta.env?.DEV === true,
  // Mini App в Telegram Web открывается во фрейме web.telegram.org — встраивать разрешено только ему.
  // Подключая telegram-web-app.js, добавить https://telegram.org в script-src (@bayramm/edge)
  frameAncestors: ["https://web.telegram.org"],
  before: taklifnomaRedirect,
}) satisfies ExportedHandler<Env>;
