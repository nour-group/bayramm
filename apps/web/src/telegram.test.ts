import type { TelegramWebApp } from "@bayramm/tg/webapp";
import { base } from "@bayramm/ui";
import { describe, expect, it } from "vitest";
import { haptic, hasNativeBack, hasNativeMainButton, initTelegram, supports } from "./telegram";

function recorder(version: string | null) {
  const calls: string[] = [];
  const log =
    (name: string) =>
    (...args: unknown[]) =>
      calls.push([name, ...args].join(":"));
  const webApp: TelegramWebApp = {
    initData: "x=1",
    initDataUnsafe: {},
    ...(version === null
      ? {}
      : { isVersionAtLeast: (v: string) => Number.parseFloat(v) <= Number.parseFloat(version) }),
    ready: log("ready"),
    expand: log("expand"),
    setHeaderColor: log("setHeaderColor"),
    setBackgroundColor: log("setBackgroundColor"),
    setBottomBarColor: log("setBottomBarColor"),
    disableVerticalSwipes: log("disableVerticalSwipes"),
    HapticFeedback: { notificationOccurred: log("haptic") },
  };
  return { webApp, calls };
}

describe("SDK Telegram", () => {
  it("свежий клиент: готовность, разворот, цвета из токенов, без сворачивания свайпом", () => {
    const { webApp, calls } = recorder("8.0");
    initTelegram(webApp);
    expect(calls).toEqual([
      "ready",
      "expand",
      `setHeaderColor:${base.paper}`,
      `setBackgroundColor:${base.paper}`,
      `setBottomBarColor:${base.paper}`,
      "disableVerticalSwipes",
    ]);
  });

  it("старый клиент: только то, что он умеет", () => {
    const { webApp, calls } = recorder("6.0");
    initTelegram(webApp);
    haptic(webApp, "success");
    expect(calls).toEqual(["ready", "expand"]);
  });

  it("без isVersionAtLeast и без методов — ничего не падает", () => {
    const bare = { initData: "x=1", initDataUnsafe: {} };
    expect(() => initTelegram(bare)).not.toThrow();
    expect(supports(bare, "6.1")).toBe(false);
    expect(hasNativeBack(bare)).toBe(false);
    expect(hasNativeMainButton(bare)).toBe(false);
    expect(() => haptic(null, "error")).not.toThrow();
    const throwing = {
      ...bare,
      isVersionAtLeast: () => {
        throw new Error("broken");
      },
    };
    expect(supports(throwing, "6.1")).toBe(false);
  });
});
