import { ru, uz } from "@bayramm/shared";
import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  daysInMonth,
  formatDayMonth,
  formatDuration,
  formatMomentTashkent,
  formatMoney,
  formatPhone,
  formatPrice,
  formatPriceFrom,
  hoursLeft,
  isIsoDate,
  phoneDigits,
  tashkentToday,
  telHref,
  weekdayMon,
} from "./format";

const NBSP = " ";

describe("даты по Ташкенту", () => {
  it("«сегодня» — по UTC+5: в 20:00 UTC в Ташкенте уже завтра", () => {
    expect(tashkentToday(Date.parse("2026-10-01T18:59:00Z"))).toBe("2026-10-01");
    expect(tashkentToday(Date.parse("2026-10-01T19:00:00Z"))).toBe("2026-10-02");
  });

  it.each([
    ["2026-10-01", true],
    ["2026-02-29", false],
    ["2028-02-29", true],
    ["2026-13-01", false],
    ["2026-1-01", false],
    ["", false],
    [null, false],
  ])("isIsoDate(%s) → %s", (value, ok) => {
    expect(isIsoDate(value)).toBe(ok);
  });

  it("арифметика дат и месяцев", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addMonths("2026-12-01", 1)).toBe("2027-01-01");
    expect(addMonths("2026-01-01", -1)).toBe("2025-12-01");
    expect(daysInMonth("2028-02-01")).toBe(29);
    expect(weekdayMon("2026-10-05")).toBe(0); // понедельник
    expect(weekdayMon("2026-10-04")).toBe(6); // воскресенье
  });

  it("день и месяц на двух языках", () => {
    expect(formatDayMonth("2026-09-14", ru)).toBe("14 сен");
    expect(formatDayMonth("2026-09-14", uz)).toBe("14-sen");
  });

  it("момент в UTC показывается ташкентским временем", () => {
    expect(formatMomentTashkent("2026-10-01T16:05:00Z", ru)).toBe("1 окт, 21:05");
    expect(formatMomentTashkent("2026-10-01T19:30:00Z", uz)).toBe("2-okt, 00:30");
  });

  it("остаток часов — вверх, после срока — ноль", () => {
    const due = "2026-10-01T16:00:00Z";
    expect(hoursLeft(due, Date.parse("2026-10-01T07:00:00Z"))).toBe(9);
    expect(hoursLeft(due, Date.parse("2026-10-01T15:59:00Z"))).toBe(1);
    expect(hoursLeft(due, Date.parse("2026-10-01T16:00:00Z"))).toBe(0);
  });

  it("длительность ответа", () => {
    expect(formatDuration(135 * 60_000, ru)).toBe("2 ч 15 мин");
    expect(formatDuration(45 * 60_000, ru)).toBe("45 мин");
    expect(formatDuration(3 * 3_600_000, uz)).toBe("3 soat");
    expect(formatDuration(10_000, ru)).toBe("1 мин");
  });
});

describe("деньги", () => {
  it("миллионы — «млн», дробь через запятую; меньше — по разрядам", () => {
    expect(formatMoney(45_000_000, ru)).toBe(`45${NBSP}млн${NBSP}сум`);
    expect(formatMoney(45_500_000, ru)).toBe(`45,5${NBSP}млн${NBSP}сум`);
    expect(formatMoney(250_000, ru)).toBe(`250${NBSP}000${NBSP}сум`);
    expect(formatMoney(45_000_000, uz)).toBe(`45${NBSP}mln${NBSP}soʻm`);
  });

  it("цена «от»: по-русски впереди, по-узбекски — окончание -dan", () => {
    expect(formatPriceFrom(60_000_000, "per_event", ru)).toEqual({
      amount: `от 60${NBSP}млн${NBSP}сум`,
      unit: null,
    });
    expect(formatPriceFrom(60_000_000, "per_event", uz).amount).toBe(`60${NBSP}mln${NBSP}soʻmdan`);
    expect(formatPriceFrom(150_000, "per_guest", ru).unit).toBe("за гостя");
    expect(formatPrice(150_000, "per_guest", uz)).toBe(`150${NBSP}000${NBSP}soʻm mehmon uchun`);
  });
});

describe("телефоны", () => {
  it.each([
    ["90 123 45 67", "901234567"],
    ["(90) 123-45-67", "901234567"],
    ["+998 90 123 45 67", "901234567"],
    ["998901234567", "901234567"],
    ["90123", "90123"],
    ["9012345678901", "901234567"],
  ])("%s → %s", (input, digits) => {
    expect(phoneDigits(input)).toBe(digits);
  });

  it("вывод и ссылка для звонка", () => {
    expect(formatPhone("+998901234567")).toBe("+998 90 123 45 67");
    expect(formatPhone("+7 999")).toBe("+7 999");
    expect(telHref("+998 90 123-45-67")).toBe("tel:+998901234567");
  });
});
