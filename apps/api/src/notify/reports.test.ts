// Отчёты команде и оповещение об ошибках API без базы и без Telegram: тексты, окно cron и
// сборка сообщения из строки outbox (fakeDb отдаёт метрики, клиент Telegram подменён)
import { hasNonCanonicalApostrophe, LANGS, normalizeUz } from "@bayramm/shared";
import type { OpsQueues, PeriodMetrics } from "@bayramm/shared/api/staff";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotApiMethods, TelegramClient } from "../telegram/client";
import { fakeDb, type RecordedQuery } from "../testing/fake-db";
import { dispatchOutbox } from "./outbox";
import type { OutboxRow } from "./render";
import {
  addDays,
  type DigestFacts,
  formatMinutes,
  formatRate,
  isDay,
  isOpsReportTick,
  REPORT_TEXTS,
  type WeeklyFacts,
} from "./reports";

const STAFF_ID = "00000000-0000-4000-8000-00000000a001";
const URLS = {
  webAppUrl: "https://app.example",
  vendorAppUrl: "https://vendor.example",
  adminAppUrl: "https://admin.example",
};

const PERIOD: PeriodMetrics = {
  requests: 12,
  clients: 9,
  measurable: 8,
  answeredInTime: 5,
  answeredRate: 62.5,
  responded: 7,
  medianResponseMinutes: 85,
  p90ResponseMinutes: 600,
  agreed: 2,
  agreedRate: 16.7,
  slaBreaches: 3,
  deadNotifications: 1,
};
const QUEUES: OpsQueues = {
  awaiting: 4,
  overdue: 1,
  deadTotal: 6,
  listingsReview: 2,
  revisionsPending: 1,
  photosPending: 0,
  servicesPending: 3,
};
const DIGEST: DigestFacts = { day: "2026-09-29", today: PERIOD, week: PERIOD, queues: QUEUES };
const WEEKLY: WeeklyFacts = { weekStart: "2026-09-21", metrics: PERIOD, queues: QUEUES };

function rendered(lang: "ru" | "uz"): string[] {
  const t = REPORT_TEXTS[lang];
  const empty: PeriodMetrics = {
    ...PERIOD,
    answeredRate: null,
    medianResponseMinutes: null,
    p90ResponseMinutes: null,
    agreedRate: null,
  };
  return [
    t.dailyDigest(DIGEST),
    t.dailyDigest({ ...DIGEST, today: empty, week: empty }),
    t.weeklyReport(WEEKLY),
    t.apiError({ route: "GET /staff/requests/:id", errors: 1, repeated: false }),
    t.apiError({ route: "POST /requests", errors: 7, repeated: true }),
  ];
}

describe("тексты отчётов", () => {
  it("правила продукта: заявка, не бронь", () => {
    for (const lang of LANGS) for (const text of rendered(lang)) expect(text).not.toMatch(/брон|bron/i);
  });

  it("узбекский: только ʻ и ʼ, в нормальной форме", () => {
    for (const text of rendered("uz")) {
      expect(hasNonCanonicalApostrophe(text), text).toBe(false);
      expect(normalizeUz(text)).toBe(text);
    }
  });

  it("сводка: день, новые заявки, доля ответов в срок за 7 дней, медиана, очереди", () => {
    const ru = REPORT_TEXTS.ru.dailyDigest(DIGEST);
    for (const part of [
      "сводка за 29.09.2026",
      "Новых заявок: 12 (клиентов: 9)",
      "в срок: 62,5% (5 из 8)",
      "Медиана ответа: 1 ч 25 мин",
      "срок вышел: 1",
      "карточек 2, правок 1, услуг 3, фото 0",
    ])
      expect(ru).toContain(part);
    const uz = REPORT_TEXTS.uz.dailyDigest(DIGEST);
    for (const part of [
      "29.09.2026",
      "Yangi soʻrovlar: 12",
      "62.5% (8 tadan 5 tasi)",
      "1 soat 25 daqiqa",
      "xizmatlar 3, foto 0",
    ])
      expect(uz).toContain(part);
  });

  it("неделя: диапазон дат, медиана и 90%, договорились, нарушения срока", () => {
    const ru = REPORT_TEXTS.ru.weeklyReport(WEEKLY);
    for (const part of [
      "неделя 21.09.2026–27.09.2026",
      "медиана 1 ч 25 мин, 90% — до 10 ч",
      "Договорились: 2 (16,7%)",
      "Срок ответа сорван: 3 раза",
    ])
      expect(ru).toContain(part);
  });

  it("ошибка API: маршрут; число — только если оповещение не первое; без подробностей", () => {
    const first = REPORT_TEXTS.ru.apiError({ route: "GET /staff/requests/:id", errors: 1, repeated: false });
    expect(first).toContain("GET /staff/requests/:id");
    expect(first).not.toContain("прошлого оповещения");
    const next = REPORT_TEXTS.ru.apiError({ route: "POST /requests", errors: 7, repeated: true });
    expect(next).toContain("Ошибок с прошлого оповещения: 7");
  });

  it("числа: проценты, минуты, прочерк", () => {
    expect(formatRate(50, "ru")).toBe("50%");
    expect(formatRate(28.6, "ru")).toBe("28,6%");
    expect(formatRate(28.6, "uz")).toBe("28.6%");
    expect(formatRate(null, "ru")).toBe("—");
    expect(formatMinutes(0, "ru")).toBe("0 мин");
    expect(formatMinutes(120, "ru")).toBe("2 ч");
    expect(formatMinutes(125, "uz")).toBe("2 soat 5 daqiqa");
    expect(formatMinutes(null, "uz")).toBe("—");
  });

  it("дни: сдвиг через границу месяца, проверка формата", () => {
    expect(addDays("2026-10-01", -1)).toBe("2026-09-30");
    expect(addDays("2026-09-29", -6)).toBe("2026-09-23");
    expect(isDay("2026-09-29")).toBe(true);
    expect(isDay("2026-13-40")).toBe(false);
    expect(isDay("29.09.2026")).toBe(false);
    expect(isDay(null)).toBe(false);
  });

  it("окно cron — 04:00–04:59 UTC (09:00 по Ташкенту)", () => {
    expect(isOpsReportTick(Date.parse("2026-09-30T03:59:00Z"))).toBe(false);
    expect(isOpsReportTick(Date.parse("2026-09-30T04:00:00Z"))).toBe(true);
    expect(isOpsReportTick(Date.parse("2026-09-30T04:59:00Z"))).toBe(true);
    expect(isOpsReportTick(Date.parse("2026-09-30T05:00:00Z"))).toBe(false);
  });
});

// ── сборка из outbox ───────────────────────────────────────────────────────

const PERIOD_ROW = {
  requests: 12,
  clients: 9,
  measurable: 8,
  answered_in_time: 5,
  answered_rate: "62.5",
  responded: 7,
  median_response_minutes: 85,
  p90_response_minutes: 600,
  agreed: 2,
  agreed_rate: "16.7",
  sla_breaches: 3,
  dead_notifications: 1,
};
const QUEUES_ROW = {
  awaiting: 4,
  overdue: 1,
  dead_total: 6,
  listings_review: 2,
  revisions_pending: 1,
  photos_pending: 0,
  services_pending: 0,
};

const reportRow = (patch: Partial<OutboxRow>): OutboxRow => ({
  id: "0b0b0b0b-0000-4000-8000-000000000001",
  kind: "ops.daily_digest",
  channel: "telegram",
  recipient_kind: "staff",
  recipient_id: STAFF_ID,
  request_id: null,
  payload: { day: "2026-09-29" },
  attempts: 1,
  ...patch,
});

function world(row: OutboxRow, staff: Record<string, unknown> | null) {
  return fakeDb((q: RecordedQuery) => {
    if (q.sql.includes("skip locked")) return [row];
    if (q.sql.includes('from "app"."staff"')) return staff ? [staff] : [];
    if (q.sql.includes("app.metrics_period")) return [PERIOD_ROW];
    if (q.sql.includes("app.metrics_ops_now")) return [QUEUES_ROW];
    return [];
  });
}

async function send(row: OutboxRow, staff: Record<string, unknown> | null) {
  const fake = world(row, staff);
  const calls: BotApiMethods["sendMessage"]["params"][] = [];
  const telegram: TelegramClient = {
    call: (async (_method: string, params: BotApiMethods["sendMessage"]["params"]) => {
      calls.push(params);
      return { message_id: 1 };
    }) as TelegramClient["call"],
  };
  const report = await dispatchOutbox({ db: fake.db, telegram, urls: URLS });
  return { fake, calls, report };
}

const ADMIN = { active: true, role: "admin", telegram_chat_id: "9001", locale: "uz" };

beforeEach(() => {
  for (const level of ["info", "warn", "error"] as const)
    vi.spyOn(console, level).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("отчёты из outbox", () => {
  it("сводка: на языке аккаунта администратора; числа — из функций метрик за день и 7 дней", async () => {
    const { fake, calls, report } = await send(reportRow({}), ADMIN);
    expect(report.sent).toBe(1);
    expect(calls[0]?.chat_id).toBe(9001);
    expect(calls[0]?.text).toContain("29.09.2026 uchun qisqa hisobot");
    const periods = fake.queries.filter((q) => q.sql.includes("app.metrics_period"));
    expect(periods.map((q) => q.parameters)).toEqual([
      ["2026-09-29", "2026-09-29", 1],
      ["2026-09-23", "2026-09-23", 7],
    ]);
    // язык — из аккаунта сотрудника (клиент, партнёр, сам аккаунт)
    expect(fake.queries.find((q) => q.sql.includes('from "app"."staff"'))?.sql).toContain("app.accounts");
  });

  it("без сохранённого языка — по-русски", async () => {
    const { calls } = await send(reportRow({}), { ...ADMIN, locale: null });
    expect(calls[0]?.text).toContain("сводка за 29.09.2026");
  });

  it("недельный отчёт — семь дней с понедельника", async () => {
    const { fake, calls } = await send(
      reportRow({ kind: "ops.weekly_report", payload: { week: "2026-09-21" } }),
      { ...ADMIN, locale: "ru" },
    );
    expect(calls[0]?.text).toContain("неделя 21.09.2026–27.09.2026");
    expect(fake.queries.find((q) => q.sql.includes("app.metrics_period"))?.parameters).toEqual([
      "2026-09-21",
      "2026-09-21",
      7,
    ]);
  });

  it("ошибка API: маршрут и счётчик из payload", async () => {
    const { calls } = await send(
      reportRow({
        kind: "ops.api_error",
        payload: { route: "GET /staff/metrics", errors: 4, since: "2026-09-30T10:00:00+00:00" },
      }),
      { ...ADMIN, locale: "ru" },
    );
    expect(calls[0]?.text).toContain("GET /staff/metrics");
    expect(calls[0]?.text).toContain("Ошибок с прошлого оповещения: 4");
  });

  it.each([
    ["сводка без дня", { kind: "ops.daily_digest", payload: {} }],
    ["день не дата", { kind: "ops.daily_digest", payload: { day: "вчера" } }],
    ["маршрут с пробелами", { kind: "ops.api_error", payload: { route: "GET /a b", errors: 1 } }],
    ["счётчик не число", { kind: "ops.api_error", payload: { route: "GET /a", errors: "1" } }],
  ])("испорченный payload (%s) — dead без отправки", async (_label, patch) => {
    const { calls, report } = await send(reportRow(patch as Partial<OutboxRow>), ADMIN);
    expect(calls).toEqual([]);
    expect(report.dead).toBe(1);
  });

  it("отчёт — только администратору: менеджеру не отправляется", async () => {
    const { calls, report } = await send(reportRow({}), { ...ADMIN, role: "manager" });
    expect(calls).toEqual([]);
    expect(report.dead).toBe(1);
  });
});
