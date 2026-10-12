/* До приложения, из <head> (CSP: только внешний файл). Открыто из Telegram (Mini App) — заказывает
   SDK сразу, не дожидаясь бандла; loadTelegramWebApp (@bayramm/tg/webapp) ждёт этот же тег.
   Правило «открыто из Telegram» — копия getWebApp/launchedFromTelegram: src/boot.test.ts. */
((w) => {
  const d = w.document;
  const LAUNCH_RE = /[#&?]tgWebApp[A-Za-z]+=/;
  const SDK_KEY = "__telegram__initParams";
  // TELEGRAM_WEB_APP_SCRIPT из @bayramm/tg/webapp (CSP его пускает, тест сверяет)
  const SDK_URL = "https://telegram.org/js/telegram-web-app.js";
  const loc = w.location;

  const stored = (store, key) => {
    try {
      return w[store].getItem(key);
    } catch {
      return null;
    }
  };

  const sdk = () => {
    const app = w.Telegram?.WebApp;
    return typeof app?.initData === "string" && app.initData.length > 0 ? app : null;
  };

  const telegram =
    sdk() !== null ||
    LAUNCH_RE.test(loc.hash) ||
    LAUNCH_RE.test(loc.search) ||
    stored("sessionStorage", SDK_KEY) !== null;

  // SDK уже в window или тег уже стоит — второго не нужно
  if (!telegram || sdk() !== null || d.querySelector(`script[src="${SDK_URL}"]`)) return;
  const script = d.createElement("script");
  script.async = true;
  script.src = SDK_URL;
  script.addEventListener("load", () => script.setAttribute("data-state", "loaded"));
  script.addEventListener("error", () => {
    script.setAttribute("data-state", "failed");
    script.remove();
  });
  d.head.appendChild(script);
})(window);
