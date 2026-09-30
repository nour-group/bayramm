// Отчёты команде в боте и оповещение об ошибках API — администраторам, только числа, без ПДн:
//   ops.daily_digest   каждое утро (09:00 по Ташкенту): сводка за вчера;
//   ops.weekly_report  по понедельникам: прошлая неделя;
//   ops.api_error      API ответил 5xx (не чаще раза в 30 минут): маршрут и сколько ошибок.
//
// Ставит отчёты база (app.enqueue_ops_reports) по шагу cron в окне 04:00–04:59 UTC — один раз
// за день и неделю, сколько бы раз cron ни сработал. В payload — только день или неделя; числа
// считают функции метрик (metrics/queries.ts) при отправке, те же, что в панели.
//
// Язык — сохранённый у аккаунта администратора (как у ответов бота): язык клиента в профиле,
// партнёра в кабинете, иначе — язык аккаунта. Узбекский — латиница с ʻ (U+02BB) и ʼ (U+02BC).

import { type Lang, ruPlural } from "@bayramm/shared";
import type { OpsQueues, PeriodMetrics } from "@bayramm/shared/api/staff";
import { type RawBuilder, sql } from "kysely";
import { SYSTEM, type Tx, withActor } from "../db/actor";
import type { Db } from "../db/client";
import { loadDays, loadQueues } from "../metrics/queries";
import { formatDate } from "./texts";

/** Час окна по UTC: 04:00 UTC = 09:00 в Ташкенте (UTC+5, без летнего времени) */
export const OPS_REPORT_UTC_HOUR = 4;

/** Попадает ли срабатывание cron (мс) в окно утренних отчётов */
export function isOpsReportTick(scheduledTime: number): boolean {
  return new Date(scheduledTime).getUTCHours() === OPS_REPORT_UTC_HOUR;
}

/** Поставить отчёты в outbox (под актором system); повтор в тот же день ничего не ставит */
export async function enqueueOpsReports(db: Db): Promise<{ daily: number; weekly: number }> {
  return withActor(db, SYSTEM, async (trx) => {
    const { rows } = await sql<{ daily: number; weekly: number }>`
      select daily, weekly from app.enqueue_ops_reports()`.execute(trx);
    return rows[0] ?? { daily: 0, weekly: 0 };
  });
}

/**
 * Язык сотрудника по его аккаунту — как у ответов бота (bot/handler.ts, savedLocale): язык
 * клиента из профиля, партнёра из кабинета, иначе язык аккаунта; без аккаунта — null
 */
export function staffLocale(accountColumn: string): RawBuilder<Lang | null> {
  const account = sql.ref(accountColumn);
  return sql<Lang | null>`coalesce(
    (select c.locale from app.clients c where c.account_id = ${account} and c.deleted_at is null),
    (select u.locale from app.vendor_users u
      where u.account_id = ${account} and u.disabled_at is null and u.last_login_at is not null
      order by u.created_at limit 1),
    (select a.locale from app.accounts a where a.id = ${account} and a.deleted_at is null))`;
}

// ── дни ────────────────────────────────────────────────────────────────────

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDay(value: string | null): value is string {
  return value !== null && DAY_RE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** «2026-09-30» ± n дней */
export function addDays(day: string, n: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}

// ── факты отчётов ──────────────────────────────────────────────────────────

export interface DigestFacts {
  /** За какой день, «YYYY-MM-DD» (по Ташкенту) */
  readonly day: string;
  /** Заявки этого дня */
  readonly today: PeriodMetrics;
  /** Семь дней по этот день включительно: доля ответов в срок и медиана */
  readonly week: PeriodMetrics;
  readonly queues: OpsQueues;
}

export interface WeeklyFacts {
  /** Понедельник недели, «YYYY-MM-DD» */
  readonly weekStart: string;
  readonly metrics: PeriodMetrics;
  readonly queues: OpsQueues;
}

export interface ApiErrorFacts {
  /** Метод и шаблон маршрута: «GET /staff/requests/:id» */
  readonly route: string;
  /** Ответов 5xx с прошлого оповещения, вместе с этим */
  readonly errors: number;
  /** Было ли прошлое оповещение */
  readonly repeated: boolean;
}

export async function loadDigest(trx: Tx, day: string): Promise<DigestFacts> {
  return {
    day,
    today: await loadDays(trx, day, 1),
    week: await loadDays(trx, addDays(day, -6), 7),
    queues: await loadQueues(trx),
  };
}

export async function loadWeekReport(trx: Tx, weekStart: string): Promise<WeeklyFacts> {
  return { weekStart, metrics: await loadDays(trx, weekStart, 7), queues: await loadQueues(trx) };
}

// ── тексты ─────────────────────────────────────────────────────────────────

const DASH = "—";

/** 62.5 → «62,5%», 50 → «50%»; null — прочерк */
export function formatRate(rate: number | null, lang: Lang): string {
  if (rate === null) return DASH;
  const text = Number.isInteger(rate) ? String(rate) : rate.toFixed(1);
  return `${lang === "ru" ? text.replace(".", ",") : text}%`;
}

/** 85 → «1 ч 25 мин» / «1 soat 25 daqiqa»; null — прочерк */
export function formatMinutes(minutes: number | null, lang: Lang): string {
  if (minutes === null) return DASH;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (lang === "ru") return h === 0 ? `${m} мин` : m === 0 ? `${h} ч` : `${h} ч ${m} мин`;
  return h === 0 ? `${m} daqiqa` : m === 0 ? `${h} soat` : `${h} soat ${m} daqiqa`;
}

export interface ReportTexts {
  dailyDigest(f: DigestFacts): string;
  weeklyReport(f: WeeklyFacts): string;
  apiError(f: ApiErrorFacts): string;
}

const queuesRu = (q: OpsQueues) =>
  `Ждут ответа площадки: ${q.awaiting}, из них срок вышел: ${q.overdue}\n` +
  `Не доставлено уведомлений (всего): ${q.deadTotal}\n` +
  `На проверке: карточек ${q.listingsReview}, правок ${q.revisionsPending}, фото ${q.photosPending}`;

const queuesUz = (q: OpsQueues) =>
  `Maydon javobini kutmoqda: ${q.awaiting}, shundan muddati oʻtgan: ${q.overdue}\n` +
  `Yetkazilmagan xabarlar (jami): ${q.deadTotal}\n` +
  `Tekshiruvda: kartochkalar ${q.listingsReview}, oʻzgarish takliflari ${q.revisionsPending}, ` +
  `foto ${q.photosPending}`;

const answeredRu = (m: PeriodMetrics) =>
  `${formatRate(m.answeredRate, "ru")} (${m.answeredInTime} из ${m.measurable})`;
const answeredUz = (m: PeriodMetrics) =>
  `${formatRate(m.answeredRate, "uz")} (${m.measurable} tadan ${m.answeredInTime} tasi)`;

const weekRange = (weekStart: string) => `${formatDate(weekStart)}–${formatDate(addDays(weekStart, 6))}`;

export const REPORT_TEXTS: Readonly<Record<Lang, ReportTexts>> = {
  ru: {
    dailyDigest: (f) =>
      `Bayramm — сводка за ${formatDate(f.day)}\n\n` +
      `Новых заявок: ${f.today.requests} (клиентов: ${f.today.clients})\n` +
      `Недоставленных уведомлений: ${f.today.deadNotifications}\n\n` +
      "За 7 дней:\n" +
      `Заявок: ${f.week.requests}\n` +
      `Площадка ответила в срок: ${answeredRu(f.week)}\n` +
      `Медиана ответа: ${formatMinutes(f.week.medianResponseMinutes, "ru")}\n` +
      `Договорились: ${f.week.agreed}\n\n` +
      `Сейчас:\n${queuesRu(f.queues)}`,
    weeklyReport: (f) =>
      `Bayramm — неделя ${weekRange(f.weekStart)}\n\n` +
      `Заявок: ${f.metrics.requests} (клиентов: ${f.metrics.clients})\n` +
      `Площадка ответила в срок: ${answeredRu(f.metrics)}\n` +
      `Время ответа: медиана ${formatMinutes(f.metrics.medianResponseMinutes, "ru")}, ` +
      `90% — до ${formatMinutes(f.metrics.p90ResponseMinutes, "ru")}\n` +
      `Договорились: ${f.metrics.agreed} (${formatRate(f.metrics.agreedRate, "ru")})\n` +
      `Срок ответа сорван: ${f.metrics.slaBreaches} ${ruPlural(f.metrics.slaBreaches, "раз", "раза", "раз")}\n` +
      `Недоставленных уведомлений: ${f.metrics.deadNotifications}\n\n` +
      `Сейчас:\n${queuesRu(f.queues)}`,
    apiError: (f) =>
      `API ответил ошибкой сервера (5xx): ${f.route}\n` +
      (f.repeated ? `Ошибок с прошлого оповещения: ${f.errors}\n` : "") +
      "Подробности — в логах воркера API. Следующее оповещение — не раньше чем через 30 минут.",
  },
  uz: {
    dailyDigest: (f) =>
      `Bayramm — ${formatDate(f.day)} uchun qisqa hisobot\n\n` +
      `Yangi soʻrovlar: ${f.today.requests} (mijozlar: ${f.today.clients})\n` +
      `Yetkazilmagan xabarlar: ${f.today.deadNotifications}\n\n` +
      "7 kunda:\n" +
      `Soʻrovlar: ${f.week.requests}\n` +
      `Maydon oʻz vaqtida javob berdi: ${answeredUz(f.week)}\n` +
      `Javob vaqti (mediana): ${formatMinutes(f.week.medianResponseMinutes, "uz")}\n` +
      `Kelishildi: ${f.week.agreed}\n\n` +
      `Hozir:\n${queuesUz(f.queues)}`,
    weeklyReport: (f) =>
      `Bayramm — hafta ${weekRange(f.weekStart)}\n\n` +
      `Soʻrovlar: ${f.metrics.requests} (mijozlar: ${f.metrics.clients})\n` +
      `Maydon oʻz vaqtida javob berdi: ${answeredUz(f.metrics)}\n` +
      `Javob vaqti: mediana ${formatMinutes(f.metrics.medianResponseMinutes, "uz")}, ` +
      `90% — ${formatMinutes(f.metrics.p90ResponseMinutes, "uz")} gacha\n` +
      `Kelishildi: ${f.metrics.agreed} (${formatRate(f.metrics.agreedRate, "uz")})\n` +
      `Javob muddati buzildi: ${f.metrics.slaBreaches}\n` +
      `Yetkazilmagan xabarlar: ${f.metrics.deadNotifications}\n\n` +
      `Hozir:\n${queuesUz(f.queues)}`,
    apiError: (f) =>
      `API server xatosi bilan javob berdi (5xx): ${f.route}\n` +
      (f.repeated ? `Oldingi ogohlantirishdan beri xatolar: ${f.errors}\n` : "") +
      "Tafsilotlar — API worker loglarida. Keyingi ogohlantirish — kamida 30 daqiqadan keyin.",
  },
};
