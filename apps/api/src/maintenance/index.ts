// Ежедневное обслуживание базы: истечение заявок с прошедшей датой события и
// сроки хранения (контакты из заявок, коды входа, старые сессии). Вся логика —
// в app.run_daily_maintenance() (миграция 20260930140000_platform_hardening.sql),
// здесь только вызов под актором system.
//
// Отдельного Cron Trigger нет (на бесплатном тарифе их пять на аккаунт): шаг
// встроен в ежеминутный cron API (src/cron.ts) и срабатывает в окне — час с
// 21:00 UTC (02:00 по Ташкенту). База сама пропускает повтор в тот же день, а
// упавший запуск откатывается целиком — следующая минута окна его повторит.
// Лишние вызовы в окне стоят одного короткого запроса. runDailyMaintenance —
// тот же запуск со своим подключением (ручной вызов, тесты).
//
// За базой — сверка фото с хранилищем (photos/sweep.ts): строки фото, удалённые
// больше 30 дней назад, и объекты без строки. Только в тот запуск, который
// провёл обслуживание базы (ran), — раз в день; её сбой не отменяет сделанного в
// базе и пишется в лог, следующая попытка — завтра.

import { sql } from "kysely";
import { SYSTEM, withActor } from "../db/actor";
import { createDb, type Db } from "../db/client";
import { isPgError } from "../errors";
import { type PhotoSweepReport, sweepPhotoStorage } from "../photos/sweep";
import { type ObjectSweeper, StorageError } from "../storage/supabase";

/** Час окна по UTC: 21:00 UTC = 02:00 в Ташкенте (UTC+5, без летнего времени) */
export const DAILY_MAINTENANCE_UTC_HOUR = 21;

export interface DailyMaintenanceResult {
  /** false — сегодня обслуживание уже прошло, ничего не сделано */
  readonly ran: boolean;
  /** День по Ташкенту, YYYY-MM-DD */
  readonly day: string;
  readonly expiredRequests: number;
  readonly purgedRequestContacts: number;
  readonly deletedOtpCodes: number;
  readonly deletedSessions: number;
  /** Сверка фото с хранилищем: null — не запускалась (или не удалась, см. лог) */
  readonly photos?: PhotoSweepReport | null;
}

export interface DailyMaintenanceOptions {
  /** Хранилище фото; без него сверка с хранилищем не запускается */
  readonly photos?: () => ObjectSweeper;
  readonly now?: Date;
}

interface Row {
  ran: boolean;
  run_day: string;
  expired_requests: number;
  purged_request_contacts: number;
  deleted_otp_codes: number;
  deleted_sessions: number;
}

/** Попадает ли срабатывание Cron (controller.scheduledTime, мс) в окно обслуживания. */
export function isDailyMaintenanceTick(scheduledTime: number): boolean {
  return new Date(scheduledTime).getUTCHours() === DAILY_MAINTENANCE_UTC_HOUR;
}

/** Обслуживание на уже открытой базе (одна транзакция под актором system). */
export async function dailyMaintenance(
  db: Db,
  options: DailyMaintenanceOptions = {},
): Promise<DailyMaintenanceResult> {
  const row = await withActor(db, SYSTEM, async (trx) => {
    const { rows } = await sql<Row>`select * from app.run_daily_maintenance()`.execute(trx);
    return rows[0];
  });
  if (row === undefined) throw new Error("app.run_daily_maintenance() не вернула строку");
  const result: DailyMaintenanceResult = {
    ran: row.ran,
    day: row.run_day,
    expiredRequests: row.expired_requests,
    purgedRequestContacts: row.purged_request_contacts,
    deletedOtpCodes: row.deleted_otp_codes,
    deletedSessions: row.deleted_sessions,
  };
  if (!row.ran || options.photos === undefined) return result;
  return { ...result, photos: await photoSweep(db, options.photos, options.now) };
}

/** Сверка фото: сбой — в лог (без ключей), обслуживание базы уже сделано */
async function photoSweep(
  db: Db,
  storage: () => ObjectSweeper,
  now: Date = new Date(),
): Promise<PhotoSweepReport | null> {
  try {
    return await sweepPhotoStorage({ db, storage: storage() }, now);
  } catch (err) {
    const reason =
      err instanceof StorageError
        ? `storage ${err.reason} ${err.status}`
        : isPgError(err)
          ? `pg ${err.code}`
          : err instanceof Error
            ? err.name
            : typeof err;
    console.error("maintenance: photo storage sweep failed", reason);
    return null;
  }
}

/** Обслуживание для scheduled-обработчика: своё подключение, закрывается в конце. */
export async function runDailyMaintenance(env: Pick<Env, "HYPERDRIVE">): Promise<DailyMaintenanceResult> {
  const db = createDb(env.HYPERDRIVE.connectionString);
  try {
    return await dailyMaintenance(db);
  } finally {
    await db.destroy().catch((err: unknown) => console.error("maintenance: pool close failed", err));
  }
}
