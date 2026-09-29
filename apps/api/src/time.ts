// Даты событий — календарные дни по Ташкенту ("YYYY-MM-DD"). «Сегодня» считает
// API, не база и не клиент: в Узбекистане UTC+5 круглый год, перехода на летнее
// время нет — хватает сдвига, без базы часовых поясов.

const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Сегодняшняя дата в Ташкенте */
export function tashkentToday(now: Date = new Date()): string {
  return new Date(now.getTime() + TASHKENT_OFFSET_MS).toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" — существующий календарный день (не 2026-02-30) в разумных годах */
export function isIsoDate(value: string): boolean {
  const m = ISO_DATE_RE.exec(value);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (year < 2000 || year > 2100) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Дата + n дней (n может быть отрицательным). Вход — проверенная isIsoDate */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}
