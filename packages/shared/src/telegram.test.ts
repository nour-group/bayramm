import { describe, expect, it } from "vitest";
import { normalizeTelegram, stripTelegram } from "./telegram";

describe("normalizeTelegram", () => {
  it.each([
    ["bayramm_hall", "bayramm_hall"],
    ["@Bayramm_Hall", "Bayramm_Hall"],
    ["t.me/bayramm_hall", "bayramm_hall"],
    ["https://t.me/bayramm_hall/", "bayramm_hall"],
    ["  telegram.me/bayramm_hall ", "bayramm_hall"],
    ["http://www.t.me/Oq_Kortej_Official", "Oq_Kortej_Official"],
  ])("%s → %s", (raw, name) => {
    expect(normalizeTelegram(raw)).toBe(name);
  });

  it.each([
    "",
    "abc",
    "abcd",
    "1hall_name",
    "_hall_name",
    "hall_",
    "hall name",
    "hall-name",
    "https://example.com/hall",
    "a".repeat(33),
  ])("%j — не имя Telegram", (raw) => {
    expect(normalizeTelegram(raw)).toBeNull();
  });

  it("5 и 32 знака — границы", () => {
    expect(normalizeTelegram("abcde")).toBe("abcde");
    expect(normalizeTelegram("a".repeat(32))).toBe("a".repeat(32));
  });
});

describe("stripTelegram", () => {
  it("снимает обёртку, имя не проверяет", () => {
    expect(stripTelegram(" https://t.me/ab ")).toBe("ab");
    expect(stripTelegram("@@x")).toBe("@x");
    expect(stripTelegram("lola hall")).toBe("lola hall");
  });
});
