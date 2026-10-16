import { describe, expect, it } from "vitest";
import { requestWindowsOf } from "./sessions";

describe("requestWindowsOf", () => {
  it("окна категории, свои окна витрины — поверх них", () => {
    expect(requestWindowsOf("hall", null)).toEqual({
      morning: { from: "06:00", to: "11:00" },
      day: { from: "12:00", to: "17:00" },
      evening: { from: "18:00", to: "24:00" },
    });
    expect(requestWindowsOf("hall", { morning: { from: "06:00", to: "10:00" } })?.morning).toEqual({
      from: "06:00",
      to: "10:00",
    });
  });

  it("без календаря (срок заказа) и у неизвестной категории — null", () => {
    expect(requestWindowsOf("cake", null)).toBeNull();
    expect(requestWindowsOf("no-such-category", null)).toBeNull();
  });

  it("мусор в part_windows — окна категории", () => {
    expect(requestWindowsOf("hall", { morning: { from: "6", to: "x" } })?.morning).toEqual({
      from: "06:00",
      to: "11:00",
    });
  });
});
