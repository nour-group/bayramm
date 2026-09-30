// Ответ API 5xx → счётчик в базе и оповещение администраторам в боте (ops.api_error) не чаще
// раза в 30 минут. Считает и решает база: app.record_api_error (миграция
// 20260930220000_launch_metrics.sql) — так порог общий для всех экземпляров воркера.
//
// Best effort: после ответа (waitUntil) и своим подключением — запрос от этого не страдает и не
// ждёт; неудача (база и есть то, что упало) — только в лог. В базу и в оповещение уходят только
// метод и шаблон маршрута (GET /staff/requests/:id): без id из пути, значений, текста ошибки и
// стека — подробности остаются в логах воркера.

import type { Context } from "hono";
import { routePath } from "hono/route";
import { sql } from "kysely";
import { SYSTEM, withActor } from "../db/actor";
import { createDb } from "../db/client";
import type { AppEnv } from "../env";
import { isPgError } from "../errors";

/** Длина шаблона маршрута — как проверяет база */
const ROUTE_MAX = 190;

/** «GET /staff/requests/:id»: метод и шаблон маршрута, только печатные ASCII */
export function routeLabel(method: string, path: string): string {
  const verb = /^[A-Z]{3,7}$/.test(method) ? method : "OTHER";
  const pattern = path.replace(/[^!-~]/g, "?").slice(0, ROUTE_MAX);
  return `${verb} ${pattern || "*"}`;
}

/** Шаблон маршрута, на котором упал запрос; не нашёлся — «*» */
function matchedPattern(c: Context<AppEnv>): string {
  try {
    return routePath(c, -1) || "*";
  } catch {
    return "*";
  }
}

/** Посчитать ошибку в базе (актор system); true — поставлено оповещение команде */
export async function recordApiError(connectionString: string, route: string): Promise<boolean> {
  const db = createDb(connectionString);
  try {
    return await withActor(db, SYSTEM, async (trx) => {
      const { rows } = await sql<{ alerted: boolean }>`
        select app.record_api_error(${route}::text) as alerted`.execute(trx);
      return rows[0]?.alerted ?? false;
    });
  } finally {
    await db.destroy().catch(() => {});
  }
}

function errorName(err: unknown): string {
  if (isPgError(err)) return `pg ${err.code}`;
  return err instanceof Error ? err.name : typeof err;
}

/** После ответа 5xx (app.onError): посчитать в waitUntil. Нет базы или контекста — ничего */
export function reportApiError(c: Context<AppEnv>): void {
  const hyperdrive = (c.env as Partial<Env> | undefined)?.HYPERDRIVE;
  if (!hyperdrive) return;
  let waitUntil: (promise: Promise<unknown>) => void;
  try {
    const ctx = c.executionCtx;
    waitUntil = (promise) => ctx.waitUntil(promise);
  } catch {
    return;
  }
  const route = routeLabel(c.req.method, matchedPattern(c));
  waitUntil(
    recordApiError(hyperdrive.connectionString, route).then(
      (alerted) => {
        if (alerted) console.info("api error: team alerted", { route });
      },
      (err: unknown) => console.warn("api error: not recorded", { route, error: errorName(err) }),
    ),
  );
}
