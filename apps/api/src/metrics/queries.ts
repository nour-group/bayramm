// Метрики запуска: вызов функций базы app.metrics_* и перевод строк в контракт панели
// (@bayramm/shared/api/staff). Определения — ответ площадки, «в срок», какие заявки в
// расчёте доли — в базе (миграция 20260930220000_launch_metrics.sql, категории —
// 20261002090000_services_only_category_metrics.sql) и только там: их читают и панель
// (staff/metrics.ts), и отчёты бота (notify/reports.ts).
//
// Функции базы проверяют актора сами: действующий сотрудник или система. category — код
// категории витрины (null — все), проверяет вызывающий.

import type {
  CategoryMetrics,
  ContactMetrics,
  ListingMetrics,
  ListingStatus,
  OpsQueues,
  PeriodMetrics,
  ResponseStats,
  VendorMetrics,
  WeeklyMetrics,
} from "@bayramm/shared/api/staff";
import { sql } from "kysely";
import type { Tx } from "../db/actor";

export const WEEKS_DEFAULT = 8;
export const WEEKS_MAX = 52;
export const DAYS_DEFAULT = 30;
export const DAYS_MAX = 366;

/** numeric из pg приходит строкой; доля — число процентов или null */
function rate(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

interface PeriodRow {
  requests: number;
  clients: number;
  measurable: number;
  answered_in_time: number;
  answered_rate: string | null;
  responded: number;
  median_response_minutes: number | null;
  p90_response_minutes: number | null;
  agreed: number;
  agreed_rate: string | null;
  sla_breaches: number;
  dead_notifications: number;
}

function periodView(row: PeriodRow): PeriodMetrics {
  return {
    requests: row.requests,
    clients: row.clients,
    measurable: row.measurable,
    answeredInTime: row.answered_in_time,
    answeredRate: rate(row.answered_rate),
    responded: row.responded,
    medianResponseMinutes: row.median_response_minutes,
    p90ResponseMinutes: row.p90_response_minutes,
    agreed: row.agreed,
    agreedRate: rate(row.agreed_rate),
    slaBreaches: row.sla_breaches,
    deadNotifications: row.dead_notifications,
  };
}

/**
 * Метрики за календарные дни по Ташкенту: с дня from ("YYYY-MM-DD") включительно, days дней
 */
export async function loadDays(trx: Tx, from: string, days: number): Promise<PeriodMetrics> {
  const { rows } = await sql<PeriodRow>`
    select * from app.metrics_period((${from}::date)::timestamp at time zone 'Asia/Tashkent',
                                     (${from}::date + ${days}::int)::timestamp at time zone 'Asia/Tashkent')`.execute(
    trx,
  );
  const row = rows[0];
  if (row === undefined) throw new Error("app.metrics_period не вернула строку");
  return periodView(row);
}

interface WeekRow extends PeriodRow {
  week_start: string;
  week_label: string;
  partial: boolean;
}

/** По ISO-неделям по Ташкенту: weeks последних, текущая — первой */
export async function loadWeekly(
  trx: Tx,
  weeks: number,
  category: string | null = null,
): Promise<WeeklyMetrics[]> {
  const { rows } = await sql<WeekRow>`
    select * from app.metrics_weekly(${weeks}::int, ${category}::text)`.execute(trx);
  return rows.map((row) => ({
    weekStart: row.week_start,
    weekLabel: row.week_label,
    partial: row.partial,
    ...periodView(row),
  }));
}

interface ResponseRow {
  requests: number;
  measurable: number;
  answered_in_time: number;
  answered_rate: string | null;
  responded: number;
  median_response_minutes: number | null;
  sla_breaches: number;
  agreed: number;
  last_request_at: Date | null;
}

function responseView(row: ResponseRow): ResponseStats {
  return {
    requests: row.requests,
    measurable: row.measurable,
    answeredInTime: row.answered_in_time,
    answeredRate: rate(row.answered_rate),
    responded: row.responded,
    medianResponseMinutes: row.median_response_minutes,
    slaBreaches: row.sla_breaches,
    agreed: row.agreed,
    lastRequestAt: row.last_request_at === null ? null : row.last_request_at.toISOString(),
  };
}

interface VendorRow extends ResponseRow {
  vendor_id: string;
  vendor_code: string;
  vendor_name: string | null;
  active_listings: number;
  categories: string[];
}

/**
 * По вендорам за последние days дней; vendorId — только этот (пусто — такого нет);
 * category — только заявки и витрины этой категории
 */
export async function loadVendors(
  trx: Tx,
  days: number,
  vendorId: string | null = null,
  category: string | null = null,
): Promise<VendorMetrics[]> {
  const { rows } = await sql<VendorRow>`
    select * from app.metrics_vendors(${days}::int, ${vendorId}::uuid, ${category}::text)`.execute(trx);
  return rows.map((row) => ({
    vendor: { id: row.vendor_id, code: row.vendor_code, name: row.vendor_name },
    activeListings: row.active_listings,
    categories: row.categories,
    ...responseView(row),
  }));
}

interface CategoryRow extends ResponseRow {
  category_code: string;
  active_listings: number;
  active_vendors: number;
  clients: number;
  p90_response_minutes: number | null;
  agreed_rate: string | null;
}

/** Сводка по категориям за последние days дней, по порядку категорий */
export async function loadCategories(trx: Tx, days: number): Promise<CategoryMetrics[]> {
  const { rows } = await sql<CategoryRow>`select * from app.metrics_categories(${days}::int)`.execute(trx);
  return rows.map((row) => ({
    categoryCode: row.category_code,
    activeListings: row.active_listings,
    activeVendors: row.active_vendors,
    clients: row.clients,
    p90ResponseMinutes: row.p90_response_minutes,
    agreedRate: rate(row.agreed_rate),
    ...responseView(row),
  }));
}

interface ListingRow extends ResponseRow {
  listing_id: string;
  listing_name: string;
  listing_status: ListingStatus;
  category_code: string;
}

/** По площадкам вендора за последние days дней */
export async function loadListings(trx: Tx, vendorId: string, days: number): Promise<ListingMetrics[]> {
  const { rows } = await sql<ListingRow>`
    select * from app.metrics_listings(${vendorId}::uuid, ${days}::int)`.execute(trx);
  return rows.map((row) => ({
    listing: {
      id: row.listing_id,
      name: row.listing_name,
      status: row.listing_status,
      categoryCode: row.category_code,
    },
    ...responseView(row),
  }));
}

interface ContactRow {
  listing_id: string;
  listing_name: string;
  listing_status: ListingStatus;
  category_code: string;
  vendor_id: string;
  vendor_name: string;
  opens: number;
  phone: number;
  telegram: number;
}

/** У каких витрин чаще открывают контакты за последние days дней (app.metrics_contacts) */
export async function loadContacts(
  trx: Tx,
  days: number,
  category: string | null,
): Promise<ContactMetrics["items"]> {
  const { rows } = await sql<ContactRow>`
    select * from app.metrics_contacts(${days}::int, ${category}::text)`.execute(trx);
  return rows.map((row) => ({
    listing: {
      id: row.listing_id,
      name: row.listing_name,
      status: row.listing_status,
      categoryCode: row.category_code,
    },
    vendor: { id: row.vendor_id, name: row.vendor_name },
    opens: row.opens,
    phone: row.phone,
    telegram: row.telegram,
  }));
}

interface QueuesRow {
  awaiting: number;
  overdue: number;
  dead_total: number;
  listings_review: number;
  revisions_pending: number;
  photos_pending: number;
}

/** Что ждёт команду сейчас: заявки без ответа, недоставленное, модерация */
export async function loadQueues(trx: Tx): Promise<OpsQueues> {
  const { rows } = await sql<QueuesRow>`select * from app.metrics_ops_now()`.execute(trx);
  const row = rows[0];
  if (row === undefined) throw new Error("app.metrics_ops_now не вернула строку");
  return {
    awaiting: row.awaiting,
    overdue: row.overdue,
    deadTotal: row.dead_total,
    listingsReview: row.listings_review,
    revisionsPending: row.revisions_pending,
    photosPending: row.photos_pending,
  };
}
