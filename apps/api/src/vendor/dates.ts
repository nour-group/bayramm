// Даты кабинета: календарные дни "YYYY-MM-DD" по Ташкенту.
//
// Ташкент живёт в UTC+5 круглый год (перехода на летнее время нет с 1992-го),
// поэтому «сегодня» считается сдвигом, без базы часовых поясов.

const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;

/** Сегодняшняя дата в Ташкенте */
export function tashkentToday(now: Date = new Date()): string {
  return new Date(now.getTime() + TASHKENT_OFFSET_MS).toISOString().slice(0, 10);
}

/** Настоящая календарная дата "YYYY-MM-DD" (не 2026-02-30) в разумных годах */
export function isIsoDate(value: string): boolean {
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 2000 || year > 2100) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Месяц "YYYY-MM" → первый и последний день; кривой месяц — null */
export function monthRange(month: string): { first: string; last: string } | null {
  const match = MONTH_RE.exec(month);
  if (!match) return null;
  const [year, mon] = [Number(match[1]), Number(match[2])];
  if (year < 2000 || year > 2100 || mon < 1 || mon > 12) return null;
  const first = `${month}-01`;
  const last = new Date(Date.UTC(year, mon, 0)).toISOString().slice(0, 10);
  return { first, last };
}
