/* Показ чисел, дат и адресов фото в панели. Время — по Ташкенту: команда и вендоры там. */

import { type MediaTarget, type MediaWidth, mediaSrcSet, mediaUrl } from "@bayramm/media";
import { t } from "./texts";

const TZ = "Asia/Tashkent";

// Intl есть не во всех старых движках с часовыми поясами — тогда без пояса
function formatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("ru-RU", { ...options, timeZone: TZ });
  } catch {
    return new Intl.DateTimeFormat("ru-RU", options);
  }
}

const dateTime = formatter({ day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const dateOnly = formatter({ day: "numeric", month: "long", year: "numeric" });

/** «29 сент., 14:05» по Ташкенту */
export function formatMoment(iso: string | null): string {
  if (!iso) return t.none;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? t.none : dateTime.format(date);
}

/** День события «YYYY-MM-DD» → «12 октября 2026» (без сдвига поясом: это календарная дата) */
export function formatDay(day: string): string {
  const date = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(date.getTime())
    ? day
    : new Intl.DateTimeFormat("ru-RU", { dateStyle: "long", timeZone: "UTC" }).format(date);
}

/** «Название · V101»; без названия — только код */
export function vendorLabel(vendor: { readonly name: string | null; readonly code: string }): string {
  return vendor.name ? `${vendor.name} · ${vendor.code}` : vendor.code;
}

/** 150000 → «150 000 сум» */
export function formatSum(value: number | null): string {
  if (value === null) return t.none;
  return `${new Intl.NumberFormat("ru-RU").format(value)} ${t.sum}`;
}

export { dateOnly };

// ── метрики ────────────────────────────────────────────────────────────────

const percent = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
const shortDay = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });

/** Доля в процентах: 62.5 → «62,5 %»; null — прочерк */
export function formatPercent(rate: number | null): string {
  return rate === null ? t.none : `${percent.format(rate)} %`;
}

/** Минуты: 85 → «1 ч 25 мин», 120 → «2 ч»; null — прочерк */
export function formatDuration(minutes: number | null): string {
  if (minutes === null) return t.none;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} мин`;
  return m === 0 ? `${h} ч` : `${h} ч ${m} мин`;
}

/** Неделя с понедельника «YYYY-MM-DD» → «21 сент. – 27 сент.» (календарные даты, без пояса) */
export function formatWeek(weekStart: string): string {
  const start = new Date(`${weekStart}T12:00:00Z`);
  if (Number.isNaN(start.getTime())) return weekStart;
  const end = new Date(start.getTime() + 6 * 86_400_000);
  return `${shortDay.format(start)} – ${shortDay.format(end)}`;
}

/** «2026-W40» → «неделя 40»: ISO-метка людям не нужна, даты недели уже в заголовке */
export function weekNumber(label: string): string {
  const n = Number(/W(\d{1,2})$/.exec(label)?.[1]);
  return Number.isInteger(n) && n > 0 ? t.weekNumber(n) : label;
}

// ── фото ───────────────────────────────────────────────────────────────────

/** Воркер media того же окружения, что и панель: по адресу панели */
export function mediaTarget(hostname = window.location.hostname): MediaTarget {
  if (hostname === "admin.bayramm.uz") return "production";
  if (hostname === "admin-staging.bayramm.uz") return "staging";
  return "local";
}

export function photoSrc(key: string, width: MediaWidth = 320): string {
  return mediaUrl(key, width, mediaTarget());
}

export function photoSrcSet(key: string): string {
  return mediaSrcSet(key, mediaTarget(), [320, 640]);
}
