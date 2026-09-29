import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type RecordedQuery } from "../testing/fake-db";
import {
  DEFAULT_SLA_CONFIG,
  isQuiet,
  notQuietFrom,
  parseSlaConfig,
  type SlaConfig,
  type SlaRequest,
  slaStep,
  sweepSla,
  tashkentMinutes,
} from "./sla";

// Время по Ташкенту (UTC+5) → момент
const tashkent = (date: string, time: string) => new Date(`${date}T${time}:00+05:00`);
const HOUR = 3_600_000;

function request(createdAt: Date, slaStage = 0, slaHours = 12): SlaRequest {
  return { createdAt, slaDueAt: new Date(createdAt.getTime() + slaHours * HOUR), slaStage };
}

const cfg = DEFAULT_SLA_CONFIG;

describe("время по Ташкенту и тихие часы", () => {
  it("UTC+5 без летнего времени", () => {
    expect(tashkentMinutes(new Date("2026-10-01T19:00:00Z"))).toBe(0);
    expect(tashkentMinutes(new Date("2026-07-01T03:30:00Z"))).toBe(8 * 60 + 30);
    expect(tashkentMinutes(new Date("2026-01-01T03:30:00Z"))).toBe(8 * 60 + 30);
  });

  it("22:00–08:00 — тихо; границы: 22:00 уже тихо, 08:00 уже можно", () => {
    expect(isQuiet(tashkent("2026-10-01", "21:59"), cfg)).toBe(false);
    expect(isQuiet(tashkent("2026-10-01", "22:00"), cfg)).toBe(true);
    expect(isQuiet(tashkent("2026-10-02", "03:00"), cfg)).toBe(true);
    expect(isQuiet(tashkent("2026-10-02", "07:59"), cfg)).toBe(true);
    expect(isQuiet(tashkent("2026-10-02", "08:00"), cfg)).toBe(false);
    expect(isQuiet(tashkent("2026-10-02", "12:00"), cfg)).toBe(false);
  });

  it("конец тихих часов — ближайшие 08:00 по Ташкенту; днём — тот же момент", () => {
    expect(notQuietFrom(new Date("2026-10-01T18:30:45Z"), cfg)).toEqual(tashkent("2026-10-02", "08:00"));
    expect(notQuietFrom(tashkent("2026-10-02", "03:00"), cfg)).toEqual(tashkent("2026-10-02", "08:00"));
    const day = tashkent("2026-10-02", "12:34");
    expect(notQuietFrom(day, cfg)).toBe(day);
  });

  it("тихие часы днём (from < to) и без тихих часов (from = to)", () => {
    const lunch: SlaConfig = { ...cfg, quietFrom: 13 * 60, quietTo: 14 * 60 };
    expect(isQuiet(tashkent("2026-10-02", "13:30"), lunch)).toBe(true);
    expect(isQuiet(tashkent("2026-10-02", "23:30"), lunch)).toBe(false);
    expect(notQuietFrom(tashkent("2026-10-02", "13:30"), lunch)).toEqual(tashkent("2026-10-02", "14:00"));
    const never: SlaConfig = { ...cfg, quietFrom: 0, quietTo: 0 };
    expect(isQuiet(tashkent("2026-10-02", "03:00"), never)).toBe(false);
  });
});

describe("slaStep: этапы", () => {
  const created = tashkent("2026-10-01", "10:00");

  it("днём: 4 ч — этап 1, 8 ч — этап 2, 12 ч — просрочка", () => {
    expect(slaStep(request(created), tashkent("2026-10-01", "13:59"), cfg)).toBeNull();
    expect(slaStep(request(created), tashkent("2026-10-01", "14:00"), cfg)).toEqual({
      stage: 1,
      clientAt: null,
    });
    expect(slaStep(request(created, 1), tashkent("2026-10-01", "15:00"), cfg)).toBeNull();
    expect(slaStep(request(created, 1), tashkent("2026-10-01", "18:00"), cfg)).toEqual({
      stage: 2,
      clientAt: null,
    });
    expect(slaStep(request(created, 2), tashkent("2026-10-01", "21:59"), cfg)).toBeNull();
  });

  it("просрочка ночью фиксируется вовремя, а клиенту — с 08:00", () => {
    expect(slaStep(request(created, 2), tashkent("2026-10-01", "22:00"), cfg)).toEqual({
      stage: 3,
      clientAt: tashkent("2026-10-02", "08:00"),
    });
  });

  it("просрочка днём — клиенту сразу", () => {
    const now = tashkent("2026-10-02", "09:00");
    expect(slaStep(request(tashkent("2026-10-01", "21:00"), 2), now, cfg)).toEqual({
      stage: 3,
      clientAt: now,
    });
  });

  it("заявка вечером: ночные напоминания ждут утра, утром — одно (этап 2), а не два", () => {
    const evening = request(tashkent("2026-10-01", "21:00"));
    expect(slaStep(evening, tashkent("2026-10-02", "01:00"), cfg)).toBeNull();
    expect(slaStep(evening, tashkent("2026-10-02", "05:00"), cfg)).toBeNull();
    expect(slaStep(evening, tashkent("2026-10-02", "07:59"), cfg)).toBeNull();
    expect(slaStep(evening, tashkent("2026-10-02", "08:00"), cfg)).toEqual({ stage: 2, clientAt: null });
  });

  it("просрочка важнее напоминания; после этапа 3 — ничего", () => {
    const now = tashkent("2026-10-01", "22:30");
    expect(slaStep(request(created, 0), now, cfg)?.stage).toBe(3);
    expect(slaStep(request(created, 3), now, cfg)).toBeNull();
  });

  it("SLA короче напоминаний — только просрочка", () => {
    const short = request(created, 0, 3);
    expect(slaStep(short, tashkent("2026-10-01", "13:00"), cfg)?.stage).toBe(3);
  });

  it("без напоминаний в настройках — только просрочка", () => {
    const none: SlaConfig = { ...cfg, reminderHours: [] };
    expect(slaStep(request(created), tashkent("2026-10-01", "20:00"), none)).toBeNull();
    expect(slaStep(request(created), tashkent("2026-10-01", "22:00"), none)?.stage).toBe(3);
  });
});

describe("parseSlaConfig", () => {
  it("значения из app.settings", () => {
    expect(
      parseSlaConfig({ sla_reminder_hours: [8, 4], quiet_hours: { from: "23:00", to: "07:30" } }),
    ).toEqual({ reminderHours: [4, 8], quietFrom: 23 * 60, quietTo: 7 * 60 + 30 });
  });

  it("не больше двух напоминаний (этапы 1 и 2), только целые часы 1–72", () => {
    expect(parseSlaConfig({ sla_reminder_hours: [2, 0, 1.5, "3", 100, 6, 9] }).reminderHours).toEqual([2, 6]);
  });

  it("нет настроек или они кривые — значения по умолчанию", () => {
    expect(parseSlaConfig({})).toEqual(DEFAULT_SLA_CONFIG);
    expect(
      parseSlaConfig({ sla_reminder_hours: "4,8", quiet_hours: { from: "25:00", to: "08:00" } }),
    ).toEqual(DEFAULT_SLA_CONFIG);
    expect(parseSlaConfig({ quiet_hours: ["22:00", "08:00"] })).toEqual(DEFAULT_SLA_CONFIG);
  });
});

describe("sweepSla", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const row = (id: number, createdAt: Date, slaStage: number) => ({
    id: `00000000-0000-4000-8000-00000000000${id}`,
    created_at: createdAt,
    sla_due_at: new Date(createdAt.getTime() + 12 * HOUR),
    sla_stage: slaStage,
  });
  const created = tashkent("2026-10-01", "10:00");
  const candidates = [row(1, created, 0), row(2, created, 1)];

  function db(rows = candidates, advance: (q: RecordedQuery) => unknown[] = () => [{ advanced: true }]) {
    return fakeDb((q) => {
      if (q.sql.includes('from "app"."settings"')) {
        return [
          { key: "sla_reminder_hours", value: [4, 8] },
          { key: "quiet_hours", value: { from: "22:00", to: "08:00" } },
        ];
      }
      if (q.sql.includes('from "app"."requests"')) return rows;
      if (q.sql.includes("app.sla_advance")) return advance(q);
      return [];
    });
  }

  it("днём: сдвигает подошедшие этапы, каждый — отдельной транзакцией под system", async () => {
    const fake = db();
    const report = await sweepSla(fake.db, tashkent("2026-10-01", "14:30"));
    expect(report).toEqual({ checked: 2, advanced: 1, waiting: 1, failed: 0 });
    const advances = fake.queries.filter((q) => q.sql.includes("app.sla_advance"));
    expect(advances.map((q) => q.parameters)).toEqual([[candidates[0]?.id, 1, null]]);
    // Отбор: без ответа, этап меньше 3, просрочка или первое напоминание подошли
    const select = fake.queries.find((q) => q.sql.includes('from "app"."requests"'));
    expect(select?.sql).toContain('"first_response_at" is null');
    expect(select?.parameters).toEqual(
      expect.arrayContaining([
        "new",
        "viewed",
        3,
        2,
        new Date(tashkent("2026-10-01", "14:30").getTime() - 4 * HOUR),
      ]),
    );
  });

  it("ночью напоминания ждут утра", async () => {
    const fake = db([row(3, tashkent("2026-10-01", "21:00"), 0)]);
    const report = await sweepSla(fake.db, tashkent("2026-10-02", "02:00"));
    expect(report).toEqual({ checked: 1, advanced: 0, waiting: 1, failed: 0 });
    expect(fake.queries.some((q) => q.sql.includes("app.sla_advance"))).toBe(false);
  });

  it("ночью просрочка — вовремя, клиенту — к 08:00", async () => {
    const fake = db();
    const report = await sweepSla(fake.db, tashkent("2026-10-02", "02:00"));
    expect(report.advanced).toBe(2);
    const params = fake.queries.filter((q) => q.sql.includes("app.sla_advance")).map((q) => q.parameters);
    expect(params).toEqual([
      [candidates[0]?.id, 3, tashkent("2026-10-02", "08:00")],
      [candidates[1]?.id, 3, tashkent("2026-10-02", "08:00")],
    ]);
  });

  it("ошибка одной заявки не мешает остальным; этап уже сдвинут — не считается", async () => {
    let n = 0;
    const fake = db(candidates, () => {
      n++;
      if (n === 1) throw Object.assign(new Error("boom"), { code: "40001", severity: "ERROR" });
      return [{ advanced: false }];
    });
    const report = await sweepSla(fake.db, tashkent("2026-10-01", "18:30"));
    expect(report).toEqual({ checked: 2, advanced: 0, waiting: 0, failed: 1 });
    expect(fake.log).toContain("rollback");
  });
});
