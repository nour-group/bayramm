import { createSiteWorker } from "@bayramm/edge";
import { mediaImageOrigins } from "@bayramm/media";
import { taklifnomaRedirect } from "./legacy";

// Vite подставляет значение при сборке: в dist всегда false, строгий CSP
const dev = import.meta.env?.DEV === true;

export default createSiteWorker({
  dev,
  // Фото площадок — с воркера media
  imageOrigins: mediaImageOrigins(dev),
  // Mini App в Telegram Web открывается во фрейме web.telegram.org — встраивать разрешено только ему.
  // Подключая telegram-web-app.js, добавить https://telegram.org в script-src (@bayramm/edge)
  frameAncestors: ["https://web.telegram.org"],
  before: taklifnomaRedirect,
}) satisfies ExportedHandler<Env>;
