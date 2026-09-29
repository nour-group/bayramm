// Cron Trigger API (раз в минуту, triggers.crons в wrangler.jsonc):
//   1. SLA: напоминания вендору и просрочки (notify/sla.ts);
//   2. outbox: отправка подошедших уведомлений, в том числе только что
//      поставленных шагом 1 (notify/outbox.ts);
//   3. чистка: update_id вебхука старше трёх дней (Telegram повторяет доставку
//      не дольше суток);
//   4. раз в день, в окне 21:00–21:59 UTC (02:00 по Ташкенту): истечение заявок
//      и сроки хранения (maintenance/index.ts). База сама пропускает повтор в тот
//      же день, упавший запуск повторит следующая минута окна.
// Шаги независимы: сбой одного — в лог, остальные выполняются.

import { sql } from "kysely";
import { SYSTEM, withActor } from "./db/actor";
import { createDb, type Db } from "./db/client";
import { isPgError } from "./errors";
import { dailyMaintenance, isDailyMaintenanceTick } from "./maintenance";
import { outboxDeps } from "./notify/kick";
import { dispatchOutbox } from "./notify/outbox";
import { sweepSla } from "./notify/sla";

export const TELEGRAM_UPDATES_RETENTION_DAYS = 3;

async function purgeTelegramUpdates(db: Db): Promise<number> {
  const result = await withActor(db, SYSTEM, (trx) =>
    trx
      .deleteFrom("app.telegram_updates")
      .where("received_at", "<", sql<Date>`now() - make_interval(days => ${TELEGRAM_UPDATES_RETENTION_DAYS})`)
      .executeTakeFirst(),
  );
  return Number(result.numDeletedRows);
}

async function step(name: string, run: () => Promise<unknown>): Promise<boolean> {
  try {
    const report = await run();
    console.info("cron: step done", { step: name, report });
    return true;
  } catch (err) {
    console.error("cron: step failed", {
      step: name,
      error: isPgError(err)
        ? `pg ${err.code}`
        : err instanceof Error
          ? `${err.name}: ${err.message}`
          : typeof err,
    });
    return false;
  }
}

/** Все шаги по очереди; false — какой-то шаг не удался (подробности в логе) */
export async function runCron(env: Env, now: Date = new Date()): Promise<boolean> {
  const db = createDb(env.HYPERDRIVE.connectionString);
  try {
    const sla = await step("sla", () => sweepSla(db, now));
    const outbox = await step("outbox", () =>
      dispatchOutbox({ db, ...outboxDeps(env), now: () => new Date() }),
    );
    const purge = await step("telegram_updates", () => purgeTelegramUpdates(db));
    const daily = isDailyMaintenanceTick(now.getTime())
      ? await step("daily_maintenance", () => dailyMaintenance(db))
      : true;
    return sla && outbox && purge && daily;
  } finally {
    await db.destroy().catch(() => {});
  }
}

export const scheduled: ExportedHandlerScheduledHandler<Env> = async (_controller, env) => {
  await runCron(env);
};
