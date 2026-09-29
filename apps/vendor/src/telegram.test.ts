// @vitest-environment jsdom
import { TELEGRAM_WEB_APP_SCRIPT } from "@bayramm/edge";
import { afterEach, describe, expect, it } from "vitest";
import { launchedFromTelegram, loadTelegramSdk } from "./telegram";

const sdkScripts = () =>
  [...document.head.querySelectorAll("script")].filter((s) => s.src === TELEGRAM_WEB_APP_SCRIPT);

afterEach(() => {
  for (const script of sdkScripts()) script.remove();
  delete (window as { Telegram?: unknown }).Telegram;
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("открыто ли из Telegram", () => {
  it("по параметрам запуска в адресе или по сохранённым SDK", () => {
    expect(launchedFromTelegram({ hash: "#tgWebAppData=query_id%3D1&tgWebAppVersion=8.0", search: "" })).toBe(
      true,
    );
    expect(launchedFromTelegram({ hash: "", search: "?tgWebAppStartParam=x" })).toBe(true);
    expect(launchedFromTelegram({ hash: "#section", search: "?utm=1" })).toBe(false);
    window.sessionStorage.setItem("__telegram__initParams", "{}");
    expect(launchedFromTelegram({ hash: "", search: "" })).toBe(true);
  });
});

describe("loadTelegramSdk", () => {
  it("в обычном браузере чужой скрипт не грузится", async () => {
    expect(await loadTelegramSdk()).toBeNull();
    expect(sdkScripts()).toHaveLength(0);
  });

  it("SDK уже есть — без загрузки", async () => {
    const webApp = { initData: "hash=x", initDataUnsafe: {} };
    Object.assign(window, { Telegram: { WebApp: webApp } });
    expect(await loadTelegramSdk()).toBe(webApp);
    expect(sdkScripts()).toHaveLength(0);
  });

  it("открыто из Telegram — один скрипт с telegram.org; после загрузки — SDK", async () => {
    window.history.replaceState(null, "", "/requests#tgWebAppData=x&tgWebAppVersion=8.0");
    const first = loadTelegramSdk();
    const second = loadTelegramSdk();
    expect(sdkScripts()).toHaveLength(1);
    const webApp = { initData: "hash=x", initDataUnsafe: {} };
    Object.assign(window, { Telegram: { WebApp: webApp } });
    sdkScripts()[0]?.dispatchEvent(new Event("load"));
    expect(await first).toBe(webApp);
    expect(await second).toBe(webApp);
  });

  it("скрипт не загрузился — null, следующий вызов пробует снова", async () => {
    window.history.replaceState(null, "", "/requests#tgWebAppData=x");
    const attempt = loadTelegramSdk();
    sdkScripts()[0]?.dispatchEvent(new Event("error"));
    expect(await attempt).toBeNull();
    void loadTelegramSdk();
    expect(sdkScripts()).toHaveLength(2);
  });
});
