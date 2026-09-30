import type { Availability } from "@bayramm/shared/api/staff";
import { describe, expect, it } from "vitest";
import { mergeBusy, rangeDays } from "./pages/Calendar";

describe("несколько дней календаря", () => {
  it("дни от раннего к позднему, концы — в любом порядке, через границу месяца", () => {
    expect(rangeDays("2026-10-30", "2026-11-02", "2026-10-01")).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
    expect(rangeDays("2026-11-02", "2026-10-31", "2026-10-01")).toEqual([
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
  });

  it("прошедшие дни в выбор не входят; один день — сам день", () => {
    expect(rangeDays("2026-09-29", "2026-10-02", "2026-10-01")).toEqual(["2026-10-01", "2026-10-02"]);
    expect(rangeDays("2026-10-05", "2026-10-05", "2026-10-01")).toEqual(["2026-10-05"]);
  });

  it("не больше, чем сервер примет одной правкой (400)", () => {
    expect(rangeDays("2026-10-01", "2028-12-31", "2026-10-01")).toHaveLength(400);
  });

  it("ответ правки вливается в месяц: на его отрезке — как у сервера, вне — как было", () => {
    const month: Availability = {
      from: "2026-10-01",
      to: "2026-10-31",
      version: 3,
      busy: [
        { day: "2026-10-02", source: "vendor" },
        { day: "2026-10-10", source: "staff" },
        { day: "2026-10-20", source: "staff" },
      ],
    };
    const result: Availability = {
      from: "2026-10-09",
      to: "2026-10-12",
      version: 4,
      busy: [
        { day: "2026-10-09", source: "staff" },
        { day: "2026-10-11", source: "staff" },
      ],
    };
    expect(mergeBusy(month, result)).toEqual({
      ...month,
      version: 4,
      busy: [
        { day: "2026-10-02", source: "vendor" },
        { day: "2026-10-09", source: "staff" },
        { day: "2026-10-11", source: "staff" },
        { day: "2026-10-20", source: "staff" },
      ],
    });
  });
});
