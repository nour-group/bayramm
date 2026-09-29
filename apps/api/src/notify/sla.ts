// SLA заявки: 12 часов на ответ вендора (обещание клиенту в интерфейсе).
//
// Этапы (app.requests.sla_stage), пока заявка без ответа (new/viewed,
// first_response_at null):
//   1, 2 — напоминание вендору через sla_reminder_hours (4 и 8 часов). Только
//          вне тихих часов по Ташкенту (quiet_hours, 22:00–08:00): ночью этап
//          ждёт утра. Проспали оба — утром одно напоминание (этап 2), а не два;
//   3    — наступил sla_due_at: заявка просрочена, клиенту — предложение
//          посмотреть похожие (ночью — к утру), администраторам — оповещение.
//          Сама просрочка фиксируется вовремя, тихие часы её не двигают.
// Когда какой этап, решает slaStep (чистая функция); сдвиг этапа и постановка
// уведомлений — app.sla_advance, атомарно и идемпотентно. Запуск — cron раз в минуту.

import { sql } from "kysely";
import { SYSTEM, withActor } from "../db/actor";
import type { Db } from "../db/client";
import type { Json } from "../db/schema.generated";
import { isPgError } from "../errors";

/** Ташкент — UTC+5 круглый год: перехода на летнее время в Узбекистане нет с 1992 года */
export const TASHKENT_OFFSET_MINUTES = 5 * 60;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MINUTES = 24 * 60;

/** Последний этап — просрочка */
export const BREACH_STAGE = 3;

export interface SlaConfig {
  /** Часы от создания заявки до напоминаний 1 и 2, по возрастанию */
  readonly reminderHours: readonly number[];
  /** Тихие часы по Ташкенту, минуты от полуночи: [from, to), через полночь, если from > to */
  readonly quietFrom: number;
  readonly quietTo: number;
}

export const DEFAULT_SLA_CONFIG: SlaConfig = { reminderHours: [4, 8], quietFrom: 22 * 60, quietTo: 8 * 60 };

// ── настройки ──────────────────────────────────────────────────────────────

function minutesOf(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/**
 * Настройки из app.settings: sla_reminder_hours ([4, 8]) и quiet_hours
 * ({"from": "22:00", "to": "08:00"}). Кривое значение — значение по умолчанию:
 * напоминание по умолчанию лучше, чем ни одного
 */
export function parseSlaConfig(settings: Readonly<Record<string, Json | undefined>>): SlaConfig {
  const hours = settings.sla_reminder_hours;
  const reminderHours = Array.isArray(hours)
    ? hours
        .filter((h): h is number => typeof h === "number" && Number.isInteger(h) && h >= 1 && h <= 72)
        .sort((a, b) => a - b)
        .slice(0, BREACH_STAGE - 1)
    : DEFAULT_SLA_CONFIG.reminderHours;

  const quiet = settings.quiet_hours;
  const from =
    typeof quiet === "object" && quiet !== null && !Array.isArray(quiet) ? minutesOf(quiet.from) : null;
  const to =
    typeof quiet === "object" && quiet !== null && !Array.isArray(quiet) ? minutesOf(quiet.to) : null;
  return {
    reminderHours,
    quietFrom: from !== null && to !== null ? from : DEFAULT_SLA_CONFIG.quietFrom,
    quietTo: from !== null && to !== null ? to : DEFAULT_SLA_CONFIG.quietTo,
  };
}

// ── время по Ташкенту ──────────────────────────────────────────────────────

/** Минуты от полуночи по Ташкенту */
export function tashkentMinutes(at: Date): number {
  const local = Math.floor(at.getTime() / MINUTE_MS) + TASHKENT_OFFSET_MINUTES;
  return ((local % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
}

export function isQuiet(at: Date, config: SlaConfig): boolean {
  const m = tashkentMinutes(at);
  const { quietFrom: from, quietTo: to } = config;
  if (from === to) return false;
  return from < to ? m >= from && m < to : m >= from || m < to;
}

/** Ближайший момент, когда уже можно писать: at, если сейчас не тихие часы, иначе их конец */
export function notQuietFrom(at: Date, config: SlaConfig): Date {
  if (!isQuiet(at, config)) return at;
  const m = tashkentMinutes(at);
  const wait = (config.quietTo - m + DAY_MINUTES) % DAY_MINUTES;
  // до целой минуты: конец тихих часов — ровно 08:00
  const startOfMinute = Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS;
  return new Date(startOfMinute + wait * MINUTE_MS);
}

// ── этап ───────────────────────────────────────────────────────────────────

export interface SlaRequest {
  readonly createdAt: Date;
  readonly slaDueAt: Date;
  readonly slaStage: number;
}

export type SlaStep =
  | { readonly stage: 1 | 2; readonly clientAt: null }
  /** Просрочка: clientAt — когда можно написать клиенту */
  | { readonly stage: 3; readonly clientAt: Date };

/**
 * Какой этап сдвинуть сейчас (для заявки без ответа). null — ничего: этап уже
 * тот, время не пришло или напоминание ждёт конца тихих часов
 */
export function slaStep(request: SlaRequest, now: Date, config: SlaConfig): SlaStep | null {
  if (request.slaStage >= BREACH_STAGE) return null;
  if (now.getTime() >= request.slaDueAt.getTime()) {
    return { stage: BREACH_STAGE, clientAt: notQuietFrom(now, config) };
  }
  let due = 0;
  config.reminderHours.forEach((hours, i) => {
    if (now.getTime() >= request.createdAt.getTime() + hours * HOUR_MS) due = i + 1;
  });
  if (due <= request.slaStage || isQuiet(now, config)) return null;
  return { stage: due === 1 ? 1 : 2, clientAt: null };
}

// ── проход по заявкам ──────────────────────────────────────────────────────

export const SLA_BATCH = 200;

export interface SlaReport {
  /** Заявок без ответа, у которых подошёл какой-то этап */
  checked: number;
  advanced: number;
  /** Напоминание ждёт утра */
  waiting: number;
  failed: number;
}

async function loadConfig(db: Db): Promise<SlaConfig> {
  const rows = await withActor(db, SYSTEM, (trx) =>
    trx
      .selectFrom("app.settings")
      .select(["key", "value"])
      .where("key", "in", ["sla_reminder_hours", "quiet_hours"])
      .execute(),
  );
  return parseSlaConfig(Object.fromEntries(rows.map((row) => [row.key, row.value])));
}

/**
 * Один проход: заявки без ответа, у которых подошла просрочка или очередное
 * напоминание, и сдвиг их этапа. Каждая заявка — своя транзакция: сбой одной
 * не мешает остальным, повтор в следующую минуту ничего не задвоит
 */
export async function sweepSla(db: Db, now: Date = new Date(), limit = SLA_BATCH): Promise<SlaReport> {
  const config = await loadConfig(db);
  const firstReminder = config.reminderHours[0];
  const reminders = config.reminderHours.length;

  const candidates = await withActor(db, SYSTEM, (trx) =>
    trx
      .selectFrom("app.requests")
      .select(["id", "created_at", "sla_due_at", "sla_stage"])
      .where("status", "in", ["new", "viewed"])
      .where("first_response_at", "is", null)
      .where("sla_stage", "<", BREACH_STAGE)
      .where((w) => {
        const breach = w("sla_due_at", "<=", now);
        if (firstReminder === undefined) return breach;
        return w.or([
          breach,
          w.and([
            w("sla_stage", "<", reminders),
            w("created_at", "<=", new Date(now.getTime() - firstReminder * HOUR_MS)),
          ]),
        ]);
      })
      .orderBy("sla_due_at")
      .limit(limit)
      .execute(),
  );

  const report: SlaReport = { checked: candidates.length, advanced: 0, waiting: 0, failed: 0 };
  for (const row of candidates) {
    const step = slaStep(
      { createdAt: row.created_at, slaDueAt: row.sla_due_at, slaStage: row.sla_stage },
      now,
      config,
    );
    if (step === null) {
      report.waiting++;
      continue;
    }
    try {
      const advanced = await withActor(db, SYSTEM, async (trx) => {
        const { rows } = await sql<{ advanced: boolean }>`
          select app.sla_advance(${row.id}::uuid, ${step.stage}::smallint, ${step.clientAt}::timestamptz) as advanced`.execute(
          trx,
        );
        return rows[0]?.advanced === true;
      });
      if (advanced) {
        report.advanced++;
        console.info("sla: stage advanced", { requestId: row.id, stage: step.stage });
      }
    } catch (err) {
      report.failed++;
      console.error("sla: advance failed", {
        requestId: row.id,
        stage: step.stage,
        error: isPgError(err) ? `pg ${err.code}` : err instanceof Error ? err.name : typeof err,
      });
    }
  }
  return report;
}
