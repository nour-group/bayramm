// Метрики запуска в панели: только чтение, только числа (право metrics.read — все роли).
// Определения и расчёт — в базе (metrics/queries.ts → app.metrics_*).
//
//   GET /staff/metrics?weeks=8                по неделям (текущая — первой) и очереди команды
//   GET /staff/metrics/vendors?days=30        ответы вендоров за последние N дней
//   GET /staff/metrics/vendors/:id?days=30    вендор и его площадки

import type { MetricsOverview, VendorMetricsList, VendorResponseStats } from "@bayramm/shared/api/staff";
import { Hono } from "hono";
import { sql } from "kysely";
import { staffOf } from "../auth/session";
import { withActor } from "../db/actor";
import type { AppEnv } from "../env";
import { notFound } from "../errors";
import {
  DAYS_DEFAULT,
  DAYS_MAX,
  loadListings,
  loadQueues,
  loadVendors,
  loadWeekly,
  WEEKS_DEFAULT,
  WEEKS_MAX,
} from "../metrics/queries";
import { requirePermission } from "./access";
import { invalidInput } from "./input";
import { pathId } from "./shared";

export const metrics = new Hono<AppEnv>();

/** Целое из строки запроса в границах; нет параметра — по умолчанию; иначе 422 с его именем */
export function intParam(raw: string | undefined, name: string, fallback: number, max: number): number {
  if (raw === undefined || raw === "") return fallback;
  const value = /^\d{1,4}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || value < 1 || value > max) throw invalidInput([name]);
  return value;
}

metrics.get("/", requirePermission("metrics.read"), async (c) => {
  const weeks = intParam(c.req.query("weeks"), "weeks", WEEKS_DEFAULT, WEEKS_MAX);
  const body: MetricsOverview = await withActor(c.var.db, staffOf(c), async (trx) => {
    const { rows } = await sql<{
      hours: number | null;
    }>`select app.setting_int('sla_hours') as hours`.execute(trx);
    return {
      slaHours: rows[0]?.hours ?? 12,
      weeks: await loadWeekly(trx, weeks),
      queues: await loadQueues(trx),
    };
  });
  return c.json(body);
});

metrics.get("/vendors", requirePermission("metrics.read"), async (c) => {
  const days = intParam(c.req.query("days"), "days", DAYS_DEFAULT, DAYS_MAX);
  const items = await withActor(c.var.db, staffOf(c), (trx) => loadVendors(trx, days));
  const body: VendorMetricsList = { days, items };
  return c.json(body);
});

metrics.get("/vendors/:id", requirePermission("metrics.read"), async (c) => {
  const id = pathId(c.req.param("id"));
  const days = intParam(c.req.query("days"), "days", DAYS_DEFAULT, DAYS_MAX);
  const body: VendorResponseStats = await withActor(c.var.db, staffOf(c), async (trx) => {
    const [vendor] = await loadVendors(trx, days, id);
    if (vendor === undefined) throw notFound();
    return { days, vendor, listings: await loadListings(trx, id, days) };
  });
  return c.json(body);
});
