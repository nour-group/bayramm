import { loadTelegramWebApp } from "@bayramm/tg/webapp";
import { withCache } from "./api/cache";
import { createHttpApi, telegramSignIn } from "./api/http";
import { createSiteAuth, createTelegramAuth, hasSiteSession } from "./api/session";
import { initialLang, type Services, takeLangParam } from "./context";
import { loadDictionary } from "./i18n";
import { mediaEnvFor } from "./media";
import { legacyCatalogHref, matchRoute, screenOf } from "./routes";
import { loadStartScreen, preloadScreens, SCREEN_CHUNK } from "./screens";
import { initTelegram } from "./telegram";

/* Сборка сервисов при старте: Telegram или обычный браузер, настоящий API или демо.

   SDK Mini App грузится, только если страницу открыл Telegram (loadTelegramWebApp):
   обычный браузер не тянет чужой скрипт. Не загрузился — приложение работает как сайт.

   Демо-API — только в `pnpm dev:web` (import.meta.env.DEV) и только если не просили
   настоящий (VITE_API=live). В сборке ветка вырезается целиком вместе с модулем mock.

   До первой отрисовки — словарь своего языка (второй грузится при переключении) и, у
   лендинга, его экран: лендинг сменяет пререндер из HTML за одну отрисовку, без заглушки.
   Экран другого маршрута только начинает грузиться — показ как раньше, с заглушкой.
   Оба куска обычно уже в кэше: их заранее просит public/boot.js (modulepreload).

   Публичные ответы API (категории, выдача, витрина, бот) идут через кэш вкладки
   (api/cache.ts) — и у настоящего API, и у демо. */
export async function bootstrap(): Promise<Services> {
  const webApp = await loadTelegramWebApp();
  if (webApp) initTelegram(webApp);
  normalizeStartUrl(webApp !== null);
  const start = screenOf(matchRoute(window.location.pathname), webApp !== null);
  if (start && start.name !== "home") preloadScreens([SCREEN_CHUNK[start.name]]);
  await Promise.all([
    loadDictionary(initialLang(webApp)),
    start?.name === "home" ? loadStartScreen(SCREEN_CHUNK.home) : null,
  ]);
  const mediaEnv = mediaEnvFor(window.location.hostname);
  const now = () => Date.now();

  if (import.meta.env.DEV && import.meta.env.VITE_API !== "live") {
    const { createMockApi, allDemoListings, demoRequests } = await import("./api/mock");
    const { tashkentToday } = await import("./format");
    const listings = allDemoListings(tashkentToday());
    // Язык демо-профиля — как у сервера при первом входе: язык Telegram или браузера
    const env = import.meta.env;
    // ?guest — посмотреть приложение глазами гостя из обычного браузера; ?turnstile — хаб с
    // проверкой «не робот» (тестовый ключ Cloudflare; сквозные тесты подменяют api.js)
    const params = new URLSearchParams(window.location.search);
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
      turnstileSiteKey: params.has("turnstile") ? DEMO_TURNSTILE_SITE_KEY : null,
    });
    // Вход в хабе демо-кодом делает гостя «сайтом со входом»
    const guest = params.has("guest");
    const identity = webApp ? "telegram" : hasSiteSession() ? "site" : guest ? "guest" : "demo";
    return { api: withCache(api, now), identity, webApp, mediaEnv, now };
  }

  // Вне Telegram — токен сайта из хранилища вкладки; нет его — запросы идут как у гостя.
  // Решает всё равно API: токен без действующей сессии — 401
  const auth = webApp
    ? createTelegramAuth({
        initData: webApp.initData,
        userId: webApp.initDataUnsafe.user?.id ?? null,
        signIn: telegramSignIn((input, init) => fetch(input, init)),
      })
    : createSiteAuth();
  // Входим сразу, не дожидаясь первой заявки: «Мои заявки» откроются без задержки.
  // Ошибку покажет экран, которому нужна сессия
  if (webApp) auth.token().catch(() => {});
  // Публичные ответы — через кэш вкладки (api/cache.ts): один запрос на всех и мгновенный «назад»
  const api = withCache(createHttpApi({ auth, source: webApp ? "tma" : "web" }), now);
  const identity = webApp ? "telegram" : hasSiteSession() ? "site" : "guest";
  return { api, identity, webApp, mediaEnv, now };
}

/**
 * Адрес первой загрузки — до того, как его прочитает роутер: ?lang= становится выбором
 * языка, а старая ссылка на каталог с фильтрами в корне (/?date=…) в браузере ведёт в
 * /catalog — корень сайта теперь лендинг (в Telegram корень — по-прежнему каталог).
 * Хэш остаётся на месте: в нём Telegram передаёт данные Mini App
 */
export function normalizeStartUrl(inTelegram: boolean): void {
  const url = new URL(window.location.href);
  let changed = takeLangParam(url);
  const legacy = inTelegram ? null : legacyCatalogHref(url.pathname, url.search);
  if (legacy) {
    const next = new URL(legacy, url.origin);
    url.pathname = next.pathname;
    url.search = next.search;
    changed = true;
  }
  if (changed)
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

/** Тестовый ключ виджета Turnstile (всегда проходит): только демо, настоящего секрета нет */
const DEMO_TURNSTILE_SITE_KEY = "1x00000000000000000000AA";

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
