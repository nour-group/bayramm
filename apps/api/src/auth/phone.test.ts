import { describe, expect, it } from "vitest";
import { normalizeUzPhone } from "./phone";

describe("normalizeUzPhone", () => {
  it.each([
    ["998001234567", "+998001234567"], // так номер контакта отдаёт Telegram
    ["+998001234567", "+998001234567"],
    [" +998 (00) 123-45-67 ", "+998001234567"],
    ["+998 00 123 45 67", "+998001234567"],
  ])("%s → %s", (raw, expected) => {
    expect(normalizeUzPhone(raw)).toBe(expected);
  });

  it.each([
    "79001234567", // другая страна
    "+7 900 123-45-67",
    "00 123 45 67", // без кода страны: не угадываем
    "+99800123456", // цифры не той длины
    "+9980012345678",
    "+998 00 123 45 6a",
    "",
    "+".repeat(40),
  ])("%s — не узбекский номер", (raw) => {
    expect(normalizeUzPhone(raw)).toBeNull();
  });
});
