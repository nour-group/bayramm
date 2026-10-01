import { describe, expect, it } from "vitest";
import { formatUzPhone, isUzPhone, normalizeUzPhone } from "./phone";

describe("normalizeUzPhone", () => {
  it.each([
    ["+998001234567", "+998001234567"],
    ["+998 00 123 45 67", "+998001234567"],
    ["998 (00) 123-45-67", "+998001234567"],
    ["00 123 45 67", "+998001234567"],
    ["  +998.00.123.45.67 ", "+998001234567"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeUzPhone(input)).toBe(expected);
  });

  it.each([
    "",
    "+7 912 345 67 89",
    "+99800123456",
    "+9980012345678",
    "+001234567",
    "90123456a",
    "++998001234567",
    "+998 00 123 45 67 доб. 2",
  ])("%j — не номер Узбекистана", (input) => {
    expect(normalizeUzPhone(input)).toBeNull();
  });
});

describe("isUzPhone / formatUzPhone", () => {
  it("только нормальный вид", () => {
    expect(isUzPhone("+998001234567")).toBe(true);
    expect(isUzPhone("998001234567")).toBe(false);
  });

  it("для показа — группами", () => {
    expect(formatUzPhone("+998001234567")).toBe("+998 00 123 45 67");
    expect(formatUzPhone("12345")).toBe("12345");
  });
});
