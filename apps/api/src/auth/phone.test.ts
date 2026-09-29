import { describe, expect, it } from "vitest";
import { normalizeUzPhone } from "./phone";

describe("normalizeUzPhone", () => {
  it.each([
    ["998901234567", "+998901234567"], // так номер контакта отдаёт Telegram
    ["+998901234567", "+998901234567"],
    [" +998 (90) 123-45-67 ", "+998901234567"],
    ["+998 90 123 45 67", "+998901234567"],
  ])("%s → %s", (raw, expected) => {
    expect(normalizeUzPhone(raw)).toBe(expected);
  });

  it.each([
    "79001234567", // другая страна
    "+7 900 123-45-67",
    "90 123 45 67", // без кода страны: не угадываем
    "+99890123456", // цифры не той длины
    "+9989012345678",
    "+998 90 123 45 6a",
    "",
    "+".repeat(40),
  ])("%s — не узбекский номер", (raw) => {
    expect(normalizeUzPhone(raw)).toBeNull();
  });
});
