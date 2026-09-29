import { describe, expect, it } from "vitest";
import type { VendorActor } from "../db/actor";
import { ApiError } from "../errors";
import { fakeDb, type RecordedQuery } from "../testing/fake-db";
import { getCalendar, markBusy, markFree, parseDay } from "./calendar";
import { addDays, isIsoDate, monthRange, tashkentToday } from "./dates";

const ACTOR: VendorActor = {
  kind: "vendor_user",
  id: "aaaaaaaa-0000-0000-0000-000000000011",
  vendorId: "aaaaaaaa-0000-0000-0000-000000000001",
};
const LISTING_ID = "aaaaaaaa-0000-0000-0000-000000000101";
// 00:30 1 октября в Ташкенте — а в UTC ещё 30 сентября
const NOW = new Date("2026-09-30T19:30:00Z");

function catching(run: () => unknown): ApiError {
  try {
    run();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("ожидался отказ");
}

async function rejection(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("ожидался отказ");
}

const isListingCheck = (q: RecordedQuery) => q.sql.startsWith('select "id" from "app"."listings"');

describe("даты по Ташкенту", () => {
  it("сегодня — по UTC+5", () => {
    expect(tashkentToday(NOW)).toBe("2026-10-01");
    expect(tashkentToday(new Date("2026-09-30T18:59:59Z"))).toBe("2026-09-30");
  });

  it("настоящие даты и месяцы", () => {
    expect(isIsoDate("2026-02-28")).toBe(true);
    expect(isIsoDate("2028-02-29")).toBe(true);
    for (const bad of [
      "2026-02-29",
      "2026-02-30",
      "2026-13-01",
      "26-10-01",
      "2026-10-1",
      "1999-12-31",
      "x",
    ]) {
      expect(isIsoDate(bad), bad).toBe(false);
    }
    expect(monthRange("2026-02")).toEqual({ first: "2026-02-01", last: "2026-02-28" });
    expect(monthRange("2028-02")).toEqual({ first: "2028-02-01", last: "2028-02-29" });
    expect(monthRange("2026-12")).toEqual({ first: "2026-12-01", last: "2026-12-31" });
    expect(monthRange("2026-00")).toBeNull();
    expect(monthRange("2026-1")).toBeNull();
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("parseDay", () => {
  it("от сегодня (по Ташкенту) до двух лет вперёд", () => {
    expect(parseDay("2026-10-01", NOW)).toBe("2026-10-01");
    expect(parseDay("2028-09-30", NOW)).toBe("2028-09-30");
    for (const day of ["2026-09-30", "2028-10-01"]) {
      const err = catching(() => parseDay(day, NOW));
      expect([err.status, err.code], day).toEqual([422, "date_out_of_range"]);
    }
    const err = catching(() => parseDay("2026-10-32", NOW));
    expect([err.status, err.code]).toEqual([422, "invalid_input"]);
  });
});

describe("getCalendar", () => {
  it("только свой листинг: чужой (даже опубликованный) — 404", async () => {
    const fake = fakeDb(() => []);
    const err = await rejection(() => getCalendar(fake.db, ACTOR, LISTING_ID, "2026-10", NOW));
    expect(err.status).toBe(404);
    const check = fake.queries.find(isListingCheck);
    expect(check?.sql).toBe('select "id" from "app"."listings" where "id" = $1 and "vendor_id" = $2');
    expect(check?.parameters).toEqual([LISTING_ID, ACTOR.vendorId]);
    expect(fake.queries.some((q) => q.sql.includes("availability"))).toBe(false);
  });

  it("месяц по умолчанию — текущий по Ташкенту; занятые дни и дни открытых заявок", async () => {
    const fake = fakeDb((q) => {
      if (isListingCheck(q)) return [{ id: LISTING_ID }];
      if (q.sql.includes('"app"."availability"'))
        return [
          { day: "2026-10-05", source: "vendor", request_id: null },
          {
            day: "2026-10-07",
            source: "request_decline",
            request_id: "eeeeeeee-0000-0000-0000-0000000000a1",
          },
        ];
      if (q.sql.includes('"app"."requests"')) return [{ event_date: "2026-10-12" }];
      return [];
    });
    const calendar = await getCalendar(fake.db, ACTOR, LISTING_ID, undefined, NOW);
    expect(calendar).toEqual({
      listingId: LISTING_ID,
      month: "2026-10",
      today: "2026-10-01",
      maxDay: "2028-09-30",
      busy: [
        { day: "2026-10-05", source: "vendor", requestId: null },
        { day: "2026-10-07", source: "request_decline", requestId: "eeeeeeee-0000-0000-0000-0000000000a1" },
      ],
      requestDays: ["2026-10-12"],
    });
    const busy = fake.queries.find((q) => q.sql.includes('"app"."availability"'));
    expect(busy?.parameters).toEqual([LISTING_ID, "2026-10-01", "2026-10-31"]);
    const requests = fake.queries.find((q) => q.sql.includes('"app"."requests"'));
    expect(requests?.parameters).toEqual(
      expect.arrayContaining(["new", "viewed", "contacted", "deal", "2026-10-01", "2026-10-31"]),
    );
    expect(requests?.parameters).not.toContain("declined");
  });

  it("кривой месяц — 422 без запроса к базе", async () => {
    const fake = fakeDb(() => []);
    const err = await rejection(() => getCalendar(fake.db, ACTOR, LISTING_ID, "2026-13", NOW));
    expect([err.status, err.code]).toEqual([422, "invalid_input"]);
    expect(fake.queries).toEqual([]);
  });
});

describe("markBusy / markFree", () => {
  it("занять: source vendor, повтор не трогает уже занятый день", async () => {
    const fake = fakeDb((q) => {
      if (isListingCheck(q)) return [{ id: LISTING_ID }];
      if (q.sql.startsWith('select "day"')) return [{ day: "2026-10-05", source: "staff", request_id: null }];
      return [];
    });
    const day = await markBusy(fake.db, ACTOR, LISTING_ID, "2026-10-05");
    expect(day).toEqual({ day: "2026-10-05", source: "staff", requestId: null });
    const insert = fake.queries.find((q) => q.sql.startsWith("insert"));
    expect(insert?.sql).toContain('on conflict ("listing_id", "day") do nothing');
    expect(insert?.parameters).toEqual([LISTING_ID, "2026-10-05", "vendor"]);
  });

  it("освободить: удаление по листингу и дню; чужой листинг — 404 без удаления", async () => {
    const own = fakeDb((q) => (isListingCheck(q) ? [{ id: LISTING_ID }] : []));
    await markFree(own.db, ACTOR, LISTING_ID, "2026-10-05");
    const del = own.queries.find((q) => q.sql.startsWith("delete"));
    expect(del?.sql).toBe('delete from "app"."availability" where "listing_id" = $1 and "day" = $2');

    const foreign = fakeDb(() => []);
    expect((await rejection(() => markFree(foreign.db, ACTOR, LISTING_ID, "2026-10-05"))).status).toBe(404);
    expect(foreign.queries.some((q) => q.sql.startsWith("delete"))).toBe(false);
  });
});
