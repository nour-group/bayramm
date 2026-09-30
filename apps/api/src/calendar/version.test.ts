import { describe, expect, it } from "vitest";
import { ApiError } from "../errors";
import { fakeDb } from "../testing/fake-db";
import { calendarEtag, calendarVersion, lockCalendar, versionFromIfMatch } from "./version";

function caught(run: () => unknown): ApiError {
  try {
    run();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("ожидался отказ");
}

describe("версия календаря из If-Match", () => {
  it("число, в кавычках и слабый ETag", () => {
    expect(versionFromIfMatch("12")).toBe(12);
    expect(versionFromIfMatch(' "0" ')).toBe(0);
    expect(versionFromIfMatch('W/"7"')).toBe(7);
    expect(calendarEtag(7)).toBe('"7"');
    expect(versionFromIfMatch(calendarEtag(41))).toBe(41);
  });

  it("нет заголовка — 428 version_required; не число — 422", () => {
    for (const missing of [undefined, "", "  "]) {
      const err = caught(() => versionFromIfMatch(missing));
      expect([err.status, err.code]).toEqual([428, "version_required"]);
    }
    for (const bad of ["*", "-1", "1.5", "abc", '"12', "99999999999"]) {
      const err = caught(() => versionFromIfMatch(bad));
      expect([err.status, err.code, err.details], bad).toEqual([422, "invalid_input", ["If-Match"]]);
    }
  });
});

describe("версия в базе", () => {
  it("строки нет — 0; блокировка — app.availability_lock с листингом и версией", async () => {
    const empty = fakeDb(() => []);
    await empty.db.transaction().execute(async (trx) => {
      expect(await calendarVersion(trx, "aaaaaaaa-0000-0000-0000-000000000101")).toBe(0);
      await lockCalendar(trx, "aaaaaaaa-0000-0000-0000-000000000101", 3);
    });
    const lock = empty.queries.find((q) => q.sql.includes("availability_lock"));
    expect(lock?.sql).toBe("select app.availability_lock($1::uuid, $2::int)");
    expect(lock?.parameters).toEqual(["aaaaaaaa-0000-0000-0000-000000000101", 3]);
  });
});
