// @vitest-environment jsdom
// Загрузчик SDK общий (@bayramm/tg/webapp, там же подробные проверки); здесь — что он
// работает с настоящим окном браузера: адрес, sessionStorage, <script> в <head>
import { TELEGRAM_WEB_APP_SCRIPT } from "@bayramm/edge";
import { afterEach, describe, expect, it } from "vitest";
import { launchedFromTelegram, loadTelegramWebApp } from "./telegram";

const sdkScripts = () =>
  [...document.head.querySelectorAll("script")].filter((s) => s.src === TELEGRAM_WEB_APP_SCRIPT);

afterEach(() => {
  for (const script of sdkScripts()) script.remove();
  delete (window as { Telegram?: unknown }).Telegram;
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("SDK Telegram в окне браузера", () => {
  it("обычный браузер — чужой скрипт не грузится", async () => {
    expect(launchedFromTelegram()).toBe(false);
    expect(await loadTelegramWebApp()).toBeNull();
    expect(sdkScripts()).toHaveLength(0);
  });

  it("открыто из Telegram — скрипт с адресом, который пускает CSP; после загрузки — SDK", async () => {
    window.history.replaceState(null, "", "/requests#tgWebAppData=x&tgWebAppVersion=8.0");
    const attempt = loadTelegramWebApp();
    expect(sdkScripts()).toHaveLength(1);
    const webApp = { initData: "hash=x", initDataUnsafe: {} };
    Object.assign(window, { Telegram: { WebApp: webApp } });
    sdkScripts()[0]?.dispatchEvent(new Event("load"));
    expect(await attempt).toBe(webApp);
  });

  it("перезагрузка без параметров в адресе — Telegram узнаётся по сохранённым SDK", () => {
    window.sessionStorage.setItem("__telegram__initParams", "{}");
    expect(launchedFromTelegram()).toBe(true);
  });
});
