/* Показ чисел, дат и адресов фото в панели. Время — по Ташкенту: команда и вендоры там. */

import { type MediaTarget, type MediaWidth, mediaSrcSet, mediaUrl } from "@bayramm/media";
import type { PriceUnit } from "@bayramm/shared/api/staff";
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

/** 150000 → «150 000 сум» */
export function formatSum(value: number | null): string {
  if (value === null) return t.none;
  return `${new Intl.NumberFormat("ru-RU").format(value)} ${t.sum}`;
}

export function formatPrice(value: number | null, unit: PriceUnit): string {
  return value === null ? t.none : `${formatSum(value)} ${t.priceUnits[unit]}`;
}

export { dateOnly };

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
