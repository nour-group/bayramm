import { describe, expect, it, vi } from "vitest";
import { type ObjectSweeper, StorageError } from "../storage/supabase";
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

  it("за базой — сверка фото с хранилищем: только в запуск, который провёл обслуживание", async () => {
    const storage: ObjectSweeper = {
      list: vi.fn(async () => ({ objects: [], cursor: null })),
      removeMany: vi.fn(async () => 0),
    };
    const photos = vi.fn(() => storage);
    const ran = fakeDb((q) => (q.sql.includes("run_daily_maintenance") ? [row] : []));
    const result = await dailyMaintenance(ran.db, { photos, now: new Date("2026-09-30T21:05:00Z") });
    expect(photos).toHaveBeenCalledTimes(1);
    expect(result.photos).toEqual({
      purgedRows: 0,
      purgedObjects: 0,
      scannedObjects: 0,
      orphanObjects: 0,
      complete: true,
    });

    const repeat = fakeDb((q) => (q.sql.includes("run_daily_maintenance") ? [{ ...row, ran: false }] : []));
    const skipped = await dailyMaintenance(repeat.db, { photos });
    expect(photos).toHaveBeenCalledTimes(1);
    expect(skipped.photos).toBeUndefined();
  });

  it("сверка фото не удалась — обслуживание базы сделано, в лог — причина без ключей", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const storage: ObjectSweeper = {
      list: async () => {
        throw new StorageError("unavailable", 503, "storage list: 503");
      },
      removeMany: async () => 0,
    };
    const fake = fakeDb((q) => (q.sql.includes("run_daily_maintenance") ? [row] : []));
    const result = await dailyMaintenance(fake.db, { photos: () => storage });
    expect(result).toMatchObject({ ran: true, expiredRequests: 3, photos: null });
    expect(error).toHaveBeenCalledWith("maintenance: photo storage sweep failed", "storage unavailable 503");
    error.mockRestore();
  });

  it("функция не вернула строку — ошибка, а не пустой результат", async () => {
    const fake = fakeDb(() => []);
    await expect(dailyMaintenance(fake.db)).rejects.toThrow(/run_daily_maintenance/);
  });
});
