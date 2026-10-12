// Очереди команды — только числа, для счётчиков у разделов панели (право metrics.read).
//
//   GET /staff/queues → 200 { queues }   заявки без ответа и просроченные, недоставленные
//        уведомления, витрины на проверке, предложения, фото и услуги — ждут решения
//
// Те же числа, что в `queues` у GET /staff/metrics (app.metrics_ops_now), но без недельных
// метрик: те пересчитывают факты по всем заявкам и стоят сотни миллисекунд, а счётчики нужны
// при каждом открытии панели и при смене раздела.

import type { StaffQueues } from "@bayramm/shared/api/staff";
import { Hono } from "hono";
import { staffOf } from "../auth/session";
import { withActor } from "../db/actor";
import type { AppEnv } from "../env";
import { loadQueues } from "../metrics/queries";
import { requirePermission } from "./access";

export const queues = new Hono<AppEnv>();

queues.get("/", requirePermission("metrics.read"), async (c) => {
  const body: StaffQueues = { queues: await withActor(c.var.db, staffOf(c), loadQueues) };
  return c.json(body);
});
