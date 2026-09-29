import { describe, expect, it } from "vitest";
import {
  formatBudget,
  formatDate,
  formatDuration,
  formatGuests,
  formatMoment,
  formatMoney,
  formatPhone,
  slaView,
  tashkentTime,
  tashkentToday,
  weekdayIndex,
} from "./format";
import { vendorDict } from "./i18n";

const { ru, uz } = vendorDict;
const HOUR = 3600 * 1000;

describe("время по Ташкенту", () => {
  it("UTC+5: полночь в Ташкенте — ещё вечер по UTC", () => {
    expect(tashkentToday(Date.parse("2026-09-30T19:30:00Z"))).toBe("2026-10-01");
    expect(tashkentToday(Date.parse("2026-09-30T18:59:00Z"))).toBe("2026-09-30");
    expect(tashkentTime("2026-10-01T04:05:00Z")).toBe("09:05");
  });

  it("день недели с понедельника; дата словами на двух языках", () => {
    expect(weekdayIndex("2026-10-05")).toBe(0);
    expect(weekdayIndex("2026-10-04")).toBe(6);
    expect(formatDate("2026-11-14", ru, true)).toBe("14 ноября, сб");
    expect(formatDate("2026-11-14", uz, true)).toBe("14-noyabr, sh");
    expect(formatDate("2026-01-01", ru)).toBe("1 января");
  });

  it("момент: сегодня — только время, иначе дата и время", () => {
    const now = Date.parse("2026-10-01T10:00:00Z");
    expect(formatMoment("2026-10-01T04:05:00Z", ru, now)).toBe("09:05");
    expect(formatMoment("2026-09-29T04:05:00Z", ru, now)).toBe("29 сентября, 09:05");
  });
});

describe("суммы и гости", () => {
  it("от миллиона — в миллионах, меньше — с разрядами", () => {
    expect(formatMoney(45_000_000, ru, "ru")).toBe("45 млн сум");
    expect(formatMoney(45_500_000, ru, "ru")).toBe("45,5 млн сум");
    expect(formatMoney(45_500_000, uz, "uz")).toBe("45.5 mln soʻm");
    expect(formatMoney(150_000, ru, "ru")).toBe("150 000 сум");
  });

  it("бюджет: диапазон, от, до, не указан", () => {
    expect(formatBudget(40_000_000, 60_000_000, ru, "ru")).toBe("40–60 млн сум");
    expect(formatBudget(40_000_000, 60_000_000, uz, "uz")).toBe("40–60 mln soʻm");
    expect(formatBudget(40_000_000, null, ru, "ru")).toBe("от 40 млн сум");
    expect(formatBudget(null, 60_000_000, uz, "uz")).toBe("60 mln soʻm gacha");
    expect(formatBudget(null, null, ru, "ru")).toBeNull();
    expect(formatBudget(0, null, ru, "ru")).toBeNull();
  });

  it("телефон — группами, чужой формат — как есть", () => {
    expect(formatPhone("+998901234567")).toBe("+998 90 123 45 67");
    expect(formatPhone("12345")).toBe("12345");
  });

  it("гости склоняются по-русски", () => {
    expect([1, 3, 5, 21, 112].map((n) => formatGuests(n, ru))).toEqual([
      "1 гость",
      "3 гостя",
      "5 гостей",
      "21 гость",
      "112 гостей",
    ]);
    expect(formatGuests(3, uz)).toBe("3 mehmon");
  });
});

describe("счётчик 12 часов", () => {
  const created = Date.parse("2026-10-01T08:00:00Z");
  const sla = { dueAt: new Date(created + 12 * HOUR).toISOString(), firstResponseAt: null, breached: false };

  it("осталось, с предупреждением в последние 4 часа", () => {
    expect(slaView(sla, created + HOUR)).toEqual({
      kind: "left",
      ms: 11 * HOUR,
      share: 11 / 12,
      warn: false,
    });
    expect(slaView(sla, created + 9 * HOUR)).toMatchObject({ kind: "left", warn: true });
    expect(formatDuration(5 * HOUR + 20 * 60_000, ru)).toBe("5 ч 20 мин");
    expect(formatDuration(40 * 60_000, uz)).toBe("40 daq");
    expect(formatDuration(2 * HOUR, uz)).toBe("2 soat");
  });

  it("просрочено — сколько сверх срока", () => {
    expect(slaView(sla, created + 13 * HOUR)).toEqual({ kind: "late", ms: HOUR });
  });

  it("ответил — счётчика нет, отмечено, если после срока", () => {
    expect(slaView({ ...sla, firstResponseAt: new Date(created + HOUR).toISOString() })).toEqual({
      kind: "answered",
      late: false,
    });
    expect(slaView({ ...sla, firstResponseAt: sla.dueAt, breached: true })).toEqual({
      kind: "answered",
      late: true,
    });
  });
});
