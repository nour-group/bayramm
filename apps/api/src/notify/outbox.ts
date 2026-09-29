// Отправка уведомлений из app.outbox в Telegram.
//
// Очередь — сама таблица в Postgres, без Cloudflare Queues: строки ставятся в той
// же транзакции, что и событие (триггеры базы), а разбирает их cron раз в минуту
// (cron.ts) плюс немедленный запуск после записи (kick.ts). Так проще, бесплатно
// и не нужно согласовывать две системы.
//
// Жизненный цикл строки: pending → sending → sent | failed → … | dead.
//   · взять: UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) — два
//     отправителя (cron и немедленный запуск) не возьмут одну строку; взятая —
//     sending, attempts + 1, enqueued_at = сейчас. Если воркер упал посреди
//     отправки, строку через 10 минут возьмут снова (лучше повтор, чем потеря);
//   · 429 — повтор через retry_after, попытка не считается;
//   · 400 и 403 (бот заблокирован, чата нет, неверный запрос) — dead сразу:
//     повтор не поможет. Клиенту, заблокировавшему бота, снимаем can_message;
//   · остальное (сеть, таймаут, 5xx) — failed, повтор через 30 с × 2^(n−1), не
//     дольше часа; после MAX_ATTEMPTS попыток — dead;
//   · каждый dead (кроме оповещений команды) — оповещение администраторам: его
//     ставит триггер базы outbox_dead_alert.
// Текст собирается при отправке (render.ts): в payload только id.

import { sql } from "kysely";
import { SYSTEM, withActor } from "../db/actor";
import type { Db } from "../db/client";
import { isPgError } from "../errors";
import { type TelegramClient, TelegramError } from "../telegram/client";
import { type OutboxRow, renderNotice, type Urls } from "./render";

export const OUTBOX_BATCH = 25;
export const MAX_ATTEMPTS = 8;
export const BASE_DELAY_SECONDS = 30;
export const MAX_DELAY_SECONDS = 60 * 60;
/** Строку в sending дольше этого считаем брошенной */
export const STUCK_AFTER_MINUTES = 10;
const LAST_ERROR_MAX = 500;

export type Outcome =
  | { readonly status: "sent"; readonly providerMsgId: string }
  | {
      readonly status: "failed";
      readonly delaySeconds: number;
      readonly error: string;
      /** false — попытка не считается (429: ограничение частоты, а не сбой) */
      readonly countAttempt: boolean;
    }
  | { readonly status: "dead"; readonly error: string; readonly blocked: boolean };

/** Пауза перед повтором после attempts-й неудачной попытки */
export function backoffSeconds(attempts: number): number {
  return Math.min(BASE_DELAY_SECONDS * 2 ** Math.max(0, attempts - 1), MAX_DELAY_SECONDS);
}

function describeError(err: TelegramError): string {
  const status = err.status ? ` ${err.status}` : "";
  const description = err.description ? `: ${err.description}` : "";
  return `${err.reason}${status}${description}`.slice(0, LAST_ERROR_MAX);
}

/** Что делать со строкой после ошибки отправки; attempts — уже с этой попыткой */
export function failureOutcome(err: unknown, attempts: number): Outcome {
  if (err instanceof TelegramError && err.reason === "api") {
    if (err.status === 429) {
      return {
        status: "failed",
        delaySeconds: (err.retryAfter ?? BASE_DELAY_SECONDS) + 1,
        error: describeError(err),
        countAttempt: false,
      };
    }
    if (err.status === 403 || err.status === 400) {
      return { status: "dead", error: describeError(err), blocked: err.status === 403 };
    }
  }
  const error = err instanceof TelegramError ? describeError(err) : "internal_error";
  if (attempts >= MAX_ATTEMPTS)
    return { status: "dead", error: `attempts_exhausted: ${error}`, blocked: false };
  return { status: "failed", delaySeconds: backoffSeconds(attempts), error, countAttempt: true };
}

export interface DispatchDeps {
  readonly db: Db;
  readonly telegram: TelegramClient;
  readonly urls: Urls;
  readonly limit?: number;
  readonly now?: () => Date;
}

export interface DispatchReport {
  claimed: number;
  sent: number;
  retry: number;
  dead: number;
}

/** Берёт до limit строк, срок которых подошёл, и помечает их sending */
function claimDue(db: Db, limit: number): Promise<OutboxRow[]> {
  return withActor(db, SYSTEM, (trx) =>
    trx
      .updateTable("app.outbox")
      .set((eb) => ({
        status: "sending",
        attempts: eb("attempts", "+", 1),
        enqueued_at: sql<Date>`now()`,
      }))
      .where("id", "in", (eb) =>
        eb
          .selectFrom("app.outbox")
          .select("id")
          .where((w) =>
            w.or([
              w.and([w("status", "in", ["pending", "failed"]), w("next_attempt_at", "<=", sql<Date>`now()`)]),
              w.and([
                w("status", "=", "sending"),
                w("enqueued_at", "<", sql<Date>`now() - make_interval(mins => ${STUCK_AFTER_MINUTES})`),
              ]),
            ]),
          )
          .orderBy("next_attempt_at")
          .limit(limit)
          .forUpdate()
          .skipLocked(),
      )
      .returning([
        "id",
        "kind",
        "channel",
        "recipient_kind",
        "recipient_id",
        "request_id",
        "payload",
        "attempts",
      ])
      .execute(),
  );
}

/** Итог отправки — в строку. Только если она всё ещё наша (sending) */
async function finish(db: Db, row: OutboxRow, outcome: Outcome): Promise<void> {
  await withActor(db, SYSTEM, async (trx) => {
    const base = trx.updateTable("app.outbox").where("id", "=", row.id).where("status", "=", "sending");
    switch (outcome.status) {
      case "sent":
        await base
          .set({
            status: "sent",
            sent_at: sql<Date>`now()`,
            provider_msg_id: outcome.providerMsgId,
            last_error: null,
          })
          .execute();
        return;
      case "failed":
        await base
          .set((eb) => ({
            status: "failed",
            next_attempt_at: sql<Date>`now() + make_interval(secs => ${outcome.delaySeconds})`,
            last_error: outcome.error,
            attempts: outcome.countAttempt ? eb.ref("attempts") : sql<number>`greatest(attempts - 1, 0)`,
          }))
          .execute();
        return;
      case "dead":
        await base.set({ status: "dead", last_error: outcome.error }).execute();
        // Клиент заблокировал бота — больше ему не пишем, пока сам не откроет бота
        if (outcome.blocked && row.recipient_kind === "client" && row.recipient_id !== null) {
          await trx
            .updateTable("app.clients")
            .set({ can_message: false })
            .where("id", "=", row.recipient_id)
            .execute();
        }
        return;
    }
  });
}

async function deliver(deps: DispatchDeps, row: OutboxRow, now: Date): Promise<Outcome> {
  const rendered = await withActor(deps.db, SYSTEM, (trx) => renderNotice(trx, row, deps.urls, now));
  if (!rendered.ok) return { status: "dead", error: `skipped: ${rendered.reason}`, blocked: false };
  try {
    const sent = await deps.telegram.call("sendMessage", rendered.message);
    return { status: "sent", providerMsgId: String(sent.message_id) };
  } catch (err) {
    if (!(err instanceof TelegramError))
      console.error("outbox: send failed", { id: row.id, error: errorName(err) });
    return failureOutcome(err, row.attempts);
  }
}

function errorName(err: unknown): string {
  if (isPgError(err)) return `pg ${err.code}`;
  return err instanceof Error ? err.name : typeof err;
}

/**
 * Один проход: взять подошедшие строки и отправить по одной (Telegram ограничивает
 * частоту — параллельность не нужна). Ошибка одной строки не останавливает остальные.
 */
export async function dispatchOutbox(deps: DispatchDeps): Promise<DispatchReport> {
  const now = deps.now ?? (() => new Date());
  const rows = await claimDue(deps.db, deps.limit ?? OUTBOX_BATCH);
  const report: DispatchReport = { claimed: rows.length, sent: 0, retry: 0, dead: 0 };
  for (const row of rows) {
    let outcome: Outcome;
    try {
      outcome = await deliver(deps, row, now());
    } catch (err) {
      // База не ответила при сборке текста — повтор позже, как при сбое сети
      console.error("outbox: render failed", { id: row.id, kind: row.kind, error: errorName(err) });
      outcome = failureOutcome(err, row.attempts);
    }
    try {
      await finish(deps.db, row, outcome);
    } catch (err) {
      // Строка останется в sending и вернётся в работу через STUCK_AFTER_MINUTES
      console.error("outbox: status update failed", { id: row.id, error: errorName(err) });
      continue;
    }
    if (outcome.status === "sent") report.sent++;
    else if (outcome.status === "failed") report.retry++;
    else {
      report.dead++;
      console.warn("outbox: dead", { id: row.id, kind: row.kind, error: outcome.error });
    }
  }
  return report;
}
