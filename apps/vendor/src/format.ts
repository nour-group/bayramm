/* Числа, суммы, даты и срок ответа — по Ташкенту и на языке кабинета.
   Ташкент — UTC+5 круглый год, поэтому время считается сдвигом, без Intl с часовыми
   поясами: в старых вебвью Android его база бывает неполной (ловушка №5). */

import { ruPlural } from "@bayramm/shared";
import type { RequestSla } from "@bayramm/shared/api/vendor";
import { fill, type VendorDict } from "./i18n";

const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** Сегодня в Ташкенте, "YYYY-MM-DD" */
export function tashkentToday(now: number = Date.now()): string {
  return new Date(now + TASHKENT_OFFSET_MS).toISOString().slice(0, 10);
}

/** Часы и минуты момента по Ташкенту: "09:05" */
export function tashkentTime(iso: string): string {
  return new Date(Date.parse(iso) + TASHKENT_OFFSET_MS).toISOString().slice(11, 16);
}

/** Дата момента по Ташкенту */
export function tashkentDate(iso: string): string {
  return new Date(Date.parse(iso) + TASHKENT_OFFSET_MS).toISOString().slice(0, 10);
}

/** День недели "YYYY-MM-DD": 0 — понедельник … 6 — воскресенье */
export function weekdayIndex(day: string): number {
  return (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
}

/** "14 ноября" / "14-noyabr"; с днём недели — "14 ноября, сб" */
export function formatDate(day: string, t: VendorDict, withWeekday = false): string {
  const [, month, date] = day.split("-").map(Number);
  const text = fill(t.dateFormat, { d: date ?? "", m: t.monthsOf[(month ?? 1) - 1] ?? "" });
  return withWeekday ? `${text}, ${(t.weekdays[weekdayIndex(day)] ?? "").toLowerCase()}` : text;
}

/** Момент: "14 ноября, 09:05" (сегодняшний — только время) */
export function formatMoment(iso: string, t: VendorDict, now: number = Date.now()): string {
  const day = tashkentDate(iso);
  const time = tashkentTime(iso);
  return day === tashkentToday(now) ? time : `${formatDate(day, t)}, ${time}`;
}

/** Целое с разделителем разрядов: 150 000 (узкий неразрывный пробел не рвёт число) */
export function groupDigits(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** Сумма: от миллиона — «45 млн сум» / «45,5 млн сум», меньше — «150 000 сум» */
export function formatMoney(uzs: number, t: VendorDict, lang: "ru" | "uz"): string {
  if (uzs >= 1_000_000) {
    const mln = Math.round(uzs / 100_000) / 10;
    const text = Number.isInteger(mln) ? String(mln) : mln.toFixed(1).replace(".", lang === "ru" ? "," : ".");
    return fill(t.moneyMln, { n: text });
  }
  return fill(t.moneySum, { n: groupDigits(uzs) });
}

export function formatBudget(
  min: number | null,
  max: number | null,
  t: VendorDict,
  lang: "ru" | "uz",
): string | null {
  if (min !== null && max !== null) {
    if (min >= 1_000_000 && max >= 1_000_000) {
      // «40–60 млн сум», а не «40 млн сум – 60 млн сум»
      const unit = formatMoney(max, t, lang);
      const minMln = formatMoney(min, t, lang).split(" ")[0] ?? "";
      const [maxMln, ...rest] = unit.split(" ");
      return `${fill(t.budgetRange, { min: minMln, max: maxMln ?? "" })} ${rest.join(" ")}`;
    }
    return fill(t.budgetRange, { min: formatMoney(min, t, lang), max: formatMoney(max, t, lang) });
  }
  if (min !== null && min > 0) return fill(t.budgetFrom, { min: formatMoney(min, t, lang) });
  if (max !== null) return fill(t.budgetTo, { max: formatMoney(max, t, lang) });
  return null;
}

export function formatGuests(n: number, t: VendorDict): string {
  return fill(ruPlural(n, t.guestsOne, t.guestsFew, t.guestsMany), { n });
}

/** «5 ч 20 мин», «40 мин», «0 мин» */
export function formatDuration(ms: number, t: VendorDict): string {
  const total = Math.max(0, Math.floor(ms / MINUTE_MS));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(fill(t.hours, { n: hours }));
  if (minutes > 0 || hours === 0) parts.push(fill(t.minutes, { n: minutes }));
  return parts.join(" ");
}

export type SlaView =
  | { readonly kind: "left"; readonly ms: number; readonly share: number; readonly warn: boolean }
  | { readonly kind: "late"; readonly ms: number }
  | { readonly kind: "answered"; readonly late: boolean };

const SLA_MS = 12 * 60 * 60 * 1000;
// Последние 4 часа из 12 — предупреждение
const WARN_MS = 4 * 60 * 60 * 1000;

/** Счётчик 12 часов: сколько осталось, насколько просрочено или уже отвечено */
export function slaView(sla: RequestSla, now: number = Date.now()): SlaView {
  if (sla.firstResponseAt !== null) return { kind: "answered", late: sla.breached };
  const left = Date.parse(sla.dueAt) - now;
  if (left <= 0) return { kind: "late", ms: -left };
  return { kind: "left", ms: left, share: Math.min(1, left / SLA_MS), warn: left <= WARN_MS };
}

/** +998001234567 → +998 00 123 45 67; другой вид — как есть */
export function formatPhone(phone: string): string {
  const match = /^\+998(\d{2})(\d{3})(\d{2})(\d{2})$/.exec(phone);
  return match ? `+998 ${match[1]} ${match[2]} ${match[3]} ${match[4]}` : phone;
}
