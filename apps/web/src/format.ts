import type { Dict } from "@bayramm/shared";
import type { PriceUnit } from "@bayramm/shared/api";

/* Даты, деньги и телефоны для экрана.

   Даты событий — строки YYYY-MM-DD по Ташкенту (как в контракте API). Ташкент живёт
   в UTC+5 без перехода на летнее время, поэтому «сегодня» и время ответа считаем
   фиксированным сдвигом, а не через Intl с часовыми поясами (его нет в старых вебвью). */

export const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Сегодняшняя дата в Ташкенте: YYYY-MM-DD */
export function tashkentToday(now: number = Date.now()): string {
  return new Date(now + TASHKENT_OFFSET_MS).toISOString().slice(0, 10);
}

/** Настоящая календарная дата вида YYYY-MM-DD (не 2026-02-31) */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = ISO_DATE_RE.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function utcDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

export function addDays(iso: string, days: number): string {
  return new Date(utcDate(iso).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/** День недели с понедельника: 0 — пн, 6 — вс */
export function weekdayMon(iso: string): number {
  return (utcDate(iso).getUTCDay() + 6) % 7;
}

export function isWeekend(iso: string): boolean {
  return weekdayMon(iso) >= 5;
}

/** Первое число месяца даты: 2026-10-17 → 2026-10-01 */
export function monthOf(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

/** Сдвиг месяца: monthOf-дата ± n месяцев */
export function addMonths(monthIso: string, months: number): string {
  const date = utcDate(monthIso);
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
}

export function daysInMonth(monthIso: string): number {
  const date = utcDate(monthIso);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
}

/** «14 сен» / «14-sen» */
export function formatDayMonth(iso: string, t: Dict): string {
  const date = utcDate(iso);
  return t.dayMonth(date.getUTCDate(), t.monthsShort[date.getUTCMonth()] ?? "");
}

/** «Октябрь 2026» */
export function formatMonthYear(monthIso: string, t: Dict): string {
  const date = utcDate(monthIso);
  return `${t.monthsFull[date.getUTCMonth()] ?? ""} ${date.getUTCFullYear()}`;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Момент (ISO в UTC) как дата и время в Ташкенте: «29 сен, 18:40» */
export function formatMomentTashkent(isoInstant: string, t: Dict): string {
  const local = new Date(new Date(isoInstant).getTime() + TASHKENT_OFFSET_MS);
  const day = formatDayMonth(local.toISOString().slice(0, 10), t);
  return `${day}, ${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}`;
}

/** Сколько целых часов осталось до срока (вверх); срок прошёл — 0 */
export function hoursLeft(dueIso: string, now: number): number {
  const left = new Date(dueIso).getTime() - now;
  return left <= 0 ? 0 : Math.ceil(left / (60 * 60 * 1000));
}

/** Длительность: «2 ч 15 мин», «45 мин», «3 ч» */
export function formatDuration(ms: number, t: Dict): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return t.durMinutes(m);
  if (m === 0) return t.durHours(h);
  return `${t.durHours(h)} ${t.durMinutes(m)}`;
}

// Неразрывные пробелы: сумма и единица не должны расходиться по строкам
const NBSP = " ";

function groupThousands(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}

/** Сумма: от миллиона — «45 млн сум», «45,5 млн сум»; меньше — «250 000 сум» */
export function formatMoney(uzs: number, t: Dict): string {
  if (uzs >= 1_000_000) {
    const millions = Math.round(uzs / 100_000) / 10;
    return `${String(millions).replace(".", ",")}${NBSP}${t.mln.replace(" ", NBSP)}`;
  }
  return `${groupThousands(uzs)}${NBSP}${t.sum}`;
}

/** Единица цены подписью: «за гостя», «за час», «за кг»… */
export function unitText(unit: PriceUnit, t: Dict): string {
  switch (unit) {
    case "per_guest":
      return t.perGuest;
    case "per_event":
      return t.perEvent;
    case "per_hour":
      return t.perHour;
    case "per_item":
      return t.perItem;
    case "per_kg":
      return t.perKg;
    case "per_set":
      return t.perSet;
    case "per_table":
      return t.perTable;
  }
}

/**
 * Цена «от» с единицей: «за гостя», «за час», «за кг»…; за мероприятие — без подписи
 * (цена за всё — так и читается)
 */
export function formatPriceFrom(
  uzs: number,
  unit: PriceUnit,
  t: Dict,
): { amount: string; unit: string | null } {
  return { amount: t.priceFrom(formatMoney(uzs, t)), unit: unit === "per_event" ? null : unitText(unit, t) };
}

/** Цена с единицей, без «от»: за мероприятие — без подписи */
export function formatPrice(uzs: number, unit: PriceUnit, t: Dict): string {
  const money = formatMoney(uzs, t);
  return unit === "per_event" ? money : `${money} ${unitText(unit, t)}`;
}

/** Подпись поля количества услуги: «Сколько часов», «Сколько кг»…; у цены за гостя и за
 * мероприятие количества нет — null */
export function qtyQuestion(unit: PriceUnit, t: Dict): string | null {
  switch (unit) {
    case "per_hour":
      return t.qtyAskHour;
    case "per_kg":
      return t.qtyAskKg;
    case "per_item":
      return t.qtyAskItem;
    case "per_set":
      return t.qtyAskSet;
    case "per_table":
      return t.qtyAskTable;
    default:
      return null;
  }
}

/**
 * Количество в единице цены: «3 ч», «5 кг», «50 шт.», «200 гостей»; у цены за мероприятие
 * количества нет — null
 */
export function formatQty(unit: PriceUnit, n: number, t: Dict): string | null {
  switch (unit) {
    case "per_event":
      return null;
    case "per_guest":
      return t.guestsShort(n);
    case "per_hour":
      return t.durHours(n);
    case "per_item":
      return t.qtyItem(n);
    case "per_kg":
      return t.qtyKg(n);
    case "per_set":
      return t.qtySet(n);
    case "per_table":
      return t.qtyTable(n);
  }
}

/**
 * Строка фактов через точку: «Кортежи · Свадьба · 6 дек · 200 гостей». Перенос — только
 * после точки, а число с подписью («200 гостей», «6 дек», «№ 1044») не разрывается
 */
export function metaLine(parts: readonly (string | null | undefined | false)[]): string {
  const glue = (part: string) =>
    part.replace(/(\d) (?=\S)/g, `$1${NBSP}`).replace(/(^|\s)(№|до|от) (?=\d)/g, `$1$2${NBSP}`);
  return parts
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .map(glue)
    .join(`${NBSP}· `);
}

/* ---------- телефоны ---------- */

export const PHONE_PREFIX = "+998";

/**
 * 9 цифр номера после +998 из того, что ввёл человек: пробелы, скобки и дефисы
 * отбрасываются, вставленный целиком номер с 998 или +998 — тоже понимаем
 */
export function phoneDigits(input: string): string {
  const digits = input.replace(/\D/g, "");
  if (digits.length > 9 && digits.startsWith("998")) return digits.slice(3, 12);
  return digits.slice(0, 9);
}

export function isPhoneDigits(digits: string): boolean {
  return /^\d{9}$/.test(digits);
}

/** +998XXXXXXXXX → «+998 00 123 45 67»; другое — как есть */
export function formatPhone(phone: string): string {
  const match = /^\+998(\d{2})(\d{3})(\d{2})(\d{2})$/.exec(phone);
  return match ? `${PHONE_PREFIX} ${match[1]} ${match[2]} ${match[3]} ${match[4]}` : phone;
}

/** Ссылка для звонка: только цифры и ведущий плюс */
export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, "")}`;
}
