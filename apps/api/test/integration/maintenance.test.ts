// Ежедневное обслуживание на настоящем Postgres ролью bayramm_api: права и
// «один раз в день». Что именно делают шаги — pgTAP 12_platform_hardening
import { describe, expect, it } from "vitest";
import { runDailyMaintenance } from "../../src/maintenance";
import { makeEnv } from "./helpers";

describe("runDailyMaintenance", () => {
  it("роль API запускает обслуживание; второй запуск в тот же день ничего не делает", async () => {
    const first = await runDailyMaintenance(makeEnv());
    expect(first.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const count of [
      first.expiredRequests,
      first.purgedRequestContacts,
      first.deletedOtpCodes,
      first.deletedSessions,
    ]) {
      expect(count).toBeGreaterThanOrEqual(0);
    }

    const second = await runDailyMaintenance(makeEnv());
    expect(second).toEqual({
      ran: false,
      day: first.day,
      expiredRequests: 0,
      purgedRequestContacts: 0,
      deletedOtpCodes: 0,
      deletedSessions: 0,
    });
  });
});
