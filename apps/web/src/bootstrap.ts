import { loadTelegramWebApp } from "@bayramm/tg/webapp";
import { createHttpApi, telegramSignIn } from "./api/http";
import { createSiteAuth, createTelegramAuth, guestAuth, hasSiteSession } from "./api/session";
import { initialLang, type Services } from "./context";
import { mediaEnvFor } from "./media";
import { initTelegram } from "./telegram";

/* Сборка сервисов при старте: Telegram или обычный браузер, настоящий API или демо.

   SDK Mini App грузится, только если страницу открыл Telegram (loadTelegramWebApp):
   обычный браузер не тянет чужой скрипт. Не загрузился — приложение работает как сайт.

   Демо-API — только в `pnpm dev:web` (import.meta.env.DEV) и только если не просили
   настоящий (VITE_API=live). В сборке ветка вырезается целиком вместе с модулем mock. */
export async function bootstrap(): Promise<Services> {
  const webApp = await loadTelegramWebApp();
  if (webApp) initTelegram(webApp);
  const mediaEnv = mediaEnvFor(window.location.hostname);
  const now = () => Date.now();

  if (import.meta.env.DEV && import.meta.env.VITE_API !== "live") {
    const { createMockApi, demoListings, demoRequests } = await import("./api/mock");
    const { tashkentToday } = await import("./format");
    const listings = demoListings(tashkentToday());
    // Язык демо-профиля — как у сервера при первом входе: язык Telegram или браузера
    const env = import.meta.env;
    const api = createMockApi({
      latencyMs: 350,
      listings,
      requests: demoRequests(listings, Date.now()),
      me: { locale: initialLang(webApp) },
      // Хаб в демо ведёт в кабинет и панель на этих адресах (сквозные тесты — свои порты)
      apps: {
        web: window.location.origin,
        vendor: env.VITE_VENDOR_APP_URL || "http://localhost:5174",
        admin: env.VITE_ADMIN_APP_URL || "http://localhost:5175",
      },
      roles: { vendors: DEMO_VENDORS, staff: { role: "admin" } },
    });
    // ?guest в адресе — посмотреть приложение глазами гостя из обычного браузера;
    // вход в хабе демо-кодом делает его «сайтом со входом»
    const guest = new URLSearchParams(window.location.search).has("guest");
    const identity = webApp ? "telegram" : hasSiteSession() ? "site" : guest ? "guest" : "demo";
    return { api, identity, webApp, mediaEnv, now };
  }

  const auth = webApp
    ? createTelegramAuth({
        initData: webApp.initData,
        userId: webApp.initDataUnsafe.user?.id ?? null,
        signIn: telegramSignIn((input, init) => fetch(input, init)),
      })
    : hasSiteSession()
      ? createSiteAuth()
      : guestAuth;
  // Входим сразу, не дожидаясь первой заявки: «Мои заявки» откроются без задержки.
  // Ошибку покажет экран, которому нужна сессия
  if (webApp) auth.token().catch(() => {});
  const api = createHttpApi({ auth, source: webApp ? "tma" : "web" });
  const identity = webApp ? "telegram" : hasSiteSession() ? "site" : "guest";
  return { api, identity, webApp, mediaEnv, now };
}

/** Демо-аккаунт — партнёр одного вендора: в профиле видна кнопка кабинета */
const DEMO_VENDORS = [
  {
    vendorUserId: "00000000-0000-4000-8200-000000000001",
    vendorId: "00000000-0000-4000-8400-000000000001",
    code: "V101",
    name: "Lola",
    role: "owner" as const,
  },
];
