import { test as base, expect, type Route } from "@playwright/test";

/* Тесты не ходят в сеть. Страница видит только свой localhost; всё остальное:
   · SDK Telegram (telegram.org/js/…) — пустой скрипт: окружение Telegram тест задаёт сам
     (support/telegram.ts), а вне Telegram SDK и так ничего не делает;
   · фото с воркера media (localhost:8790 в разработке) — картинка 1×1;
   · любой другой адрес — отказ, и тест падает: значит, код стал звать чужой сервер.
   Ещё тест падает на необработанном исключении в странице. */

const MEDIA_DEV_ORIGIN = "http://localhost:8790";
const TELEGRAM_SCRIPTS = /^https:\/\/telegram\.org\/js\/telegram-(web-app|widget)\.js(\?.*)?$/;
// Прозрачный PNG 1×1
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

const isLocal = (url: URL) =>
  (url.hostname === "localhost" || url.hostname === "127.0.0.1") && url.origin !== MEDIA_DEV_ORIGIN;

export interface Offline {
  /** Адреса, куда страница пыталась уйти мимо подмен */
  readonly blocked: string[];
  /** Необработанные исключения в странице */
  readonly errors: string[];
}

export const test = base.extend<{ sealed: Offline }>({
  sealed: [
    async ({ context, page }, use) => {
      const offline: Offline = { blocked: [], errors: [] };
      await context.route(
        (url) => !isLocal(url),
        (route: Route) => {
          const url = route.request().url();
          if (TELEGRAM_SCRIPTS.test(url))
            return route.fulfill({
              status: 200,
              contentType: "text/javascript",
              body: "/* e2e: SDK Telegram не загружается */",
            });
          if (url.startsWith(`${MEDIA_DEV_ORIGIN}/`))
            return route.fulfill({ status: 200, contentType: "image/png", body: PIXEL });
          offline.blocked.push(url);
          return route.abort("blockedbyclient");
        },
      );
      page.on("pageerror", (error) => offline.errors.push(error.message));
      await use(offline);
      expect(offline.blocked, "запросы наружу").toEqual([]);
      expect(offline.errors, "исключения в странице").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
