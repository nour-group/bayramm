import { describe, expect, it } from "vitest";
import { fakeDb } from "../testing/fake-db";
import { DAILY_MAINTENANCE_UTC_HOUR, dailyMaintenance, isDailyMaintenanceTick } from "./index";

describe("isDailyMaintenanceTick", () => {
  it("окно — час с 21:00 UTC (02:00 по Ташкенту)", () => {
    expect(DAILY_MAINTENANCE_UTC_HOUR).toBe(21);
    expect(isDailyMaintenanceTick(Date.parse("2026-09-29T21:00:00Z"))).toBe(true);
    expect(isDailyMaintenanceTick(Date.parse("2026-09-29T21:59:00Z"))).toBe(true);
    expect(isDailyMaintenanceTick(Date.parse("2026-09-29T20:59:00Z"))).toBe(false);
    expect(isDailyMaintenanceTick(Date.parse("2026-09-29T22:00:00Z"))).toBe(false);
    // полдень по Ташкенту — не окно
    expect(isDailyMaintenanceTick(Date.parse("2026-09-29T07:00:00Z"))).toBe(false);
  });
});

describe("dailyMaintenance", () => {
  const row = {
    ran: true,
    run_day: "2026-09-30",
    expired_requests: 3,
    purged_request_contacts: 2,
    deleted_otp_codes: 5,
    deleted_sessions: 1,
  };

  it("одна транзакция под актором system: вызов app.run_daily_maintenance()", async () => {
    const fake = fakeDb((q) => (q.sql.includes("run_daily_maintenance") ? [row] : []));
    const result = await dailyMaintenance(fake.db);

    expect(fake.log[0]).toBe("begin");
    expect(fake.log.at(-1)).toBe("commit");
    const [settings, call] = fake.queries;
    expect(settings?.parameters).toEqual(["system", "", ""]);
    expect(call?.sql).toBe("select * from app.run_daily_maintenance()");
    expect(result).toEqual({
      ran: true,
      day: "2026-09-30",
      expiredRequests: 3,
      purgedRequestContacts: 2,
      deletedOtpCodes: 5,
      deletedSessions: 1,
    });
  });

  it("повтор в тот же день — ran: false", async () => {
    const fake = fakeDb((q) =>
      q.sql.includes("run_daily_maintenance")
        ? [{ ...row, ran: false, expired_requests: 0, purged_request_contacts: 0 }]
        : [],
    );
    expect((await dailyMaintenance(fake.db)).ran).toBe(false);
  });

  it("функция не вернула строку — ошибка, а не пустой результат", async () => {
    const fake = fakeDb(() => []);
    await expect(dailyMaintenance(fake.db)).rejects.toThrow(/run_daily_maintenance/);
  });
});
