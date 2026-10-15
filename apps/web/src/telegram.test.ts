import type { TelegramWebApp } from "@bayramm/tg/webapp";
import { base } from "@bayramm/ui";
import { describe, expect, it } from "vitest";
import {
  canRequestPhone,
  haptic,
  hasNativeBack,
  hasNativeMainButton,
  initTelegram,
  requestPhone,
  supports,
} from "./telegram";

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

describe("«Поделиться номером» (requestContact)", () => {
  type Answer = Parameters<Parameters<NonNullable<TelegramWebApp["requestContact"]>>[0] & {}>;
  const withContact = (version: string, answer: Answer): TelegramWebApp => ({
    ...recorder(version).webApp,
    requestContact: (callback) => callback?.(...answer),
  });

  it("поделился — номер как его отдал Telegram; отказал или номера нет — null", () => {
    const got: (string | null)[] = [];
    const ok = withContact("7.0", [
      true,
      { status: "sent", responseUnsafe: { contact: { phone_number: "998901234567" } } },
    ]);
    expect(canRequestPhone(ok)).toBe(true);
    requestPhone(ok, (phone) => got.push(phone));
    requestPhone(withContact("7.0", [false, { status: "cancelled" }]), (phone) => got.push(phone));
    requestPhone(withContact("7.0", [true]), (phone) => got.push(phone));
    expect(got).toEqual(["998901234567", null, null]);
  });

  it("клиент старше 6.9 или без метода — кнопки нет, вызова нет", () => {
    const old = withContact("6.1", [true]);
    expect(canRequestPhone(old)).toBe(false);
    expect(canRequestPhone(recorder("8.0").webApp)).toBe(false);
    expect(canRequestPhone(null)).toBe(false);
    const got: (string | null)[] = [];
    requestPhone(old, (phone) => got.push(phone));
    expect(got).toEqual([]);
  });
});
