import type { Availability } from "@bayramm/shared/api/staff";
import { describe, expect, it } from "vitest";
import { dayState, mergeBusy, rangeDays } from "./pages/Calendar";

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
      mode: "day",
      parallelCapacity: 1,
      parts: [],
      bookings: [],
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
      mode: "day",
      parallelCapacity: 1,
      parts: [],
      bookings: [],
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

describe("части дня (кортеж, фото и видео, декор)", () => {
  const month: Availability = {
    mode: "parts",
    parallelCapacity: 2,
    from: "2026-10-01",
    to: "2026-10-31",
    version: 7,
    busy: [{ day: "2026-10-20", source: "vendor" }],
    parts: [{ day: "2026-10-10", part: "morning", source: "staff" }],
    bookings: [
      { day: "2026-10-10", part: "evening", count: 1 },
      { day: "2026-10-12", part: "day", count: 2 },
    ],
  };

  it("часть занята отметкой или когда мест не осталось; день — когда занят целиком или все части", () => {
    const tenth = dayState(month, "2026-10-10");
    expect(tenth.load).toBe("partial");
    expect(tenth.parts.map((p) => [p.part, p.busy, p.count])).toEqual([
      ["morning", true, 0],
      ["day", false, 0],
      ["evening", false, 1],
    ]);
    expect(dayState(month, "2026-10-12").parts.find((p) => p.part === "day")).toMatchObject({
      full: true,
      busy: true,
    });
    expect(dayState(month, "2026-10-20").load).toBe("busy");
    expect(dayState(month, "2026-10-21").load).toBe("free");
    const full: Availability = {
      ...month,
      parts: (["morning", "day", "evening"] as const).map((part) => ({
        day: "2026-10-05",
        part,
        source: "staff" as const,
      })),
    };
    expect(dayState(full, "2026-10-05").load).toBe("busy");
  });

  it("ответ правки части дня вливается вместе с договорённостями и местами", () => {
    const result: Availability = {
      ...month,
      from: "2026-10-10",
      to: "2026-10-10",
      parallelCapacity: 3,
      version: 8,
      busy: [],
      parts: [
        { day: "2026-10-10", part: "morning", source: "staff" },
        { day: "2026-10-10", part: "evening", source: "staff" },
      ],
      bookings: [{ day: "2026-10-10", part: "evening", count: 1 }],
    };
    const merged = mergeBusy(month, result);
    expect(merged.version).toBe(8);
    expect(merged.parallelCapacity).toBe(3);
    expect(merged.parts.map((p) => `${p.day}:${p.part}`)).toEqual([
      "2026-10-10:morning",
      "2026-10-10:evening",
    ]);
    expect(merged.bookings).toHaveLength(2);
    expect(merged.busy).toEqual(month.busy);
  });
});
