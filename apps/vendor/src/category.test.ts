import { describe, expect, it } from "vitest";
import { partsLabel } from "./category";
import { vendorDict } from "./i18n";

const WINDOWS = {
  morning: { from: "06:00", to: "11:00" },
  day: { from: "12:00", to: "17:00" },
  evening: { from: "18:00", to: "24:00" },
};

describe("partsLabel", () => {
  const t = vendorDict.ru;

  it("части дня заявки: названия, с окнами витрины — и время", () => {
    expect(partsLabel(t, "hall", ["morning", "evening"])).toBe(
      `${t.part_morning}, ${t.part_evening.toLowerCase()}`,
    );
    expect(partsLabel(t, "hall", ["morning", "evening"], WINDOWS)).toBe(
      `${t.part_morning} 06:00–11:00, ${t.part_evening.toLowerCase()} 18:00–24:00`,
    );
  });

  it("весь день — без времени; у категории без календаря — ничего", () => {
    expect(partsLabel(t, "hall", [], WINDOWS)).toBe(t.wholeDay);
    expect(partsLabel(t, "cake", ["morning"], null)).toBeNull();
  });
});
