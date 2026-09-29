import { describe, expect, it } from "vitest";
import { getWebApp } from "./webapp";

const webApp = { initData: "query_id=1&hash=abc", initDataUnsafe: { start_param: "vendor_zal-1" } };

describe("getWebApp", () => {
  it("внутри Telegram отдаёт SDK", () => {
    expect(getWebApp({ Telegram: { WebApp: webApp } })).toBe(webApp);
  });

  it("обычный браузер, старый клиент или пустая initData — null", () => {
    expect(getWebApp({})).toBeNull();
    expect(getWebApp(undefined)).toBeNull();
    expect(getWebApp({ Telegram: {} })).toBeNull();
    expect(getWebApp({ Telegram: { WebApp: { ...webApp, initData: "" } } })).toBeNull();
    expect(getWebApp({ Telegram: { WebApp: { initData: 42, initDataUnsafe: {} } } })).toBeNull();
    expect(getWebApp({ Telegram: { WebApp: { initData: "x" } } })).toBeNull();
  });

  it("без аргумента смотрит в globalThis", () => {
    expect(getWebApp()).toBeNull();
  });
});
