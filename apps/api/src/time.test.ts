import { describe, expect, it } from "vitest";
import { addDays, isIsoDate, tashkentToday } from "./time";

describe("tashkentToday", () => {
  it("день по Ташкенту (UTC+5): новые сутки начинаются в 19:00 UTC", () => {
    expect(tashkentToday(new Date("2026-09-29T18:59:59Z"))).toBe("2026-09-29");
    expect(tashkentToday(new Date("2026-09-29T19:00:00Z"))).toBe("2026-09-30");
    expect(tashkentToday(new Date("2026-12-31T19:30:00Z"))).toBe("2027-01-01");
  });
});

describe("isIsoDate", () => {
  it("только существующие дни в формате YYYY-MM-DD", () => {
    for (const ok of ["2026-10-03", "2028-02-29", "2000-01-01", "2100-12-31"])
      expect(isIsoDate(ok), ok).toBe(true);
    for (const bad of [
      "2026-02-29",
      "2026-13-01",
      "2026-00-10",
      "2026-1-01",
      "26-10-03",
      "2026-10-03T00:00",
      "",
    ]) {
      expect(isIsoDate(bad), bad).toBe(false);
    }
    expect(isIsoDate("1999-12-31")).toBe(false);
    expect(isIsoDate("2101-01-01")).toBe(false);
  });
});

describe("addDays", () => {
  it("через границы месяцев и лет, в обе стороны", () => {
    expect(addDays("2026-09-29", 1)).toBe("2026-09-30");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-09-29", 180)).toBe("2027-03-28");
  });
});
