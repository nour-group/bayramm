import { getWebApp } from "@bayramm/tg/webapp";
import { createHttpApi, telegramSignIn } from "./api/http";
import { createTelegramAuth, guestAuth } from "./api/session";
import type { Services } from "./context";
import { mediaEnvFor } from "./media";
import { initTelegram } from "./telegram";

/* Сборка сервисов при старте: Telegram или обычный браузер, настоящий API или демо.

   Демо-API — только в `pnpm dev:web` (import.meta.env.DEV) и только если не просили
   настоящий (VITE_API=live). В сборке ветка вырезается целиком вместе с модулем mock. */
export async function bootstrap(): Promise<Services> {
  const webApp = getWebApp();
  if (webApp) initTelegram(webApp);
  const mediaEnv = mediaEnvFor(window.location.hostname);
  const now = () => Date.now();

  if (import.meta.env.DEV && import.meta.env.VITE_API !== "live") {
    const { createMockApi, demoListings, demoRequests } = await import("./api/mock");
    const { tashkentToday } = await import("./format");
    const listings = demoListings(tashkentToday());
    const api = createMockApi({ latencyMs: 350, listings, requests: demoRequests(listings, Date.now()) });
    // ?guest в адресе — посмотреть приложение глазами гостя из обычного браузера
    const guest = new URLSearchParams(window.location.search).has("guest");
    return { api, identity: webApp ? "telegram" : guest ? "guest" : "demo", webApp, mediaEnv, now };
  }

  const auth = webApp
    ? createTelegramAuth({
        initData: webApp.initData,
        userId: webApp.initDataUnsafe.user?.id ?? null,
        signIn: telegramSignIn((input, init) => fetch(input, init)),
      })
    : guestAuth;
  // Входим сразу, не дожидаясь первой заявки: «Мои заявки» откроются без задержки.
  // Ошибку покажет экран, которому нужна сессия
  if (webApp) auth.token().catch(() => {});
  const api = createHttpApi({ auth, source: webApp ? "tma" : "web" });
  return { api, identity: webApp ? "telegram" : "guest", webApp, mediaEnv, now };
}
