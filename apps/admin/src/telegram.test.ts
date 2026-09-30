// @vitest-environment jsdom
import type { TelegramWebApp } from "@bayramm/tg/webapp";
import { base } from "@bayramm/ui";
import { describe, expect, it } from "vitest";
import { hasNativeBack, IN_TELEGRAM_CLASS, initTelegram, supports } from "./telegram";

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
    BackButton: { show: log("back.show") },
  };
  return { webApp, calls };
}

describe("панель в Telegram", () => {
  it("свежий клиент: готовность, во весь экран, цвета шапки и фона из токенов, без сворачивания свайпом", () => {
    const { webApp, calls } = recorder("8.0");
    const root = document.createElement("html");
    initTelegram(webApp, root);
    expect(calls).toEqual([
      "ready",
      "expand",
      `setHeaderColor:${base.white}`,
      `setBackgroundColor:${base.paper}`,
      `setBottomBarColor:${base.railBg}`,
      "disableVerticalSwipes",
    ]);
    expect(root.classList.contains(IN_TELEGRAM_CLASS)).toBe(true);
    expect(hasNativeBack(webApp)).toBe(true);
  });

  it("старый клиент: только то, что он умеет; «назад» — своя в шапке", () => {
    const { webApp, calls } = recorder("6.0");
    initTelegram(webApp, null);
    expect(calls).toEqual(["ready", "expand"]);
    expect(hasNativeBack(webApp)).toBe(false);
  });

  it("без isVersionAtLeast и без методов — ничего не падает", () => {
    const bare = { initData: "x=1", initDataUnsafe: {} };
    expect(() => initTelegram(bare, null)).not.toThrow();
    expect(supports(bare, "6.1")).toBe(false);
    const throwing = {
      ...bare,
      isVersionAtLeast: () => {
        throw new Error("broken");
      },
    };
    expect(supports(throwing, "6.1")).toBe(false);
  });
});
