import { describe, expect, it } from "vitest";
import type { VendorActor } from "../db/actor";
import { ApiError } from "../errors";
import { fakeDb, type RecordedQuery } from "../testing/fake-db";
import {
  applyBatch,
  getCalendar,
  markBusy,
  markFree,
  parseBatch,
  parseDay,
  parsePart,
  setDaySessions,
} from "./calendar";
import { addDays, isIsoDate, monthRange, tashkentToday } from "./dates";

const ACTOR: VendorActor = {
  kind: "vendor_user",
  id: "aaaaaaaa-0000-0000-0000-000000000011",
  vendorId: "aaaaaaaa-0000-0000-0000-000000000001",
  role: "owner",
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

const isListingCheck = (q: RecordedQuery) => q.sql.startsWith('select "l"."id", "l"."category_code"');
/** Своя витрина: режим занятости категории, заказов одновременно и время работы */
const own = (mode = "parts", capacity = 1, over: Record<string, unknown> = {}) => [
  {
    id: LISTING_ID,
    category_code: mode === "lead" ? "cake" : "hall",
    parallel_capacity: capacity,
    part_mode: "parts",
    day_parts: "{morning,day,evening}",
    part_windows: null,
    availability_mode: mode,
    ...over,
  },
];
const isDeals = (q: RecordedQuery) => q.sql.includes("enum_range");
const isVersion = (q: RecordedQuery) => q.sql.includes('"app"."availability_versions"');
const isLock = (q: RecordedQuery) => q.sql.includes("app.availability_lock");

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
    expect(check?.sql).toContain('where "l"."id" = $1 and "l"."vendor_id" = $2');
    expect(check?.parameters).toEqual([LISTING_ID, ACTOR.vendorId]);
    expect(fake.queries.some((q) => q.sql.includes('"app"."availability'))).toBe(false);
  });

  it("месяц по умолчанию — текущий по Ташкенту; занятые дни, заявки дня и время работы", async () => {
    const fake = fakeDb((q) => {
      if (isListingCheck(q)) return own();
      if (isVersion(q)) return [{ version: 7 }];
      if (q.sql.includes('"app"."availability"'))
        return [
          { day: "2026-10-05", source: "vendor", request_id: null },
          {
            day: "2026-10-07",
            source: "request_decline",
            request_id: "eeeeeeee-0000-0000-0000-0000000000a1",
          },
        ];
      if (q.sql.includes('from "app"."requests"'))
        return [
          {
            id: "eeeeeeee-0000-0000-0000-0000000000b1",
            public_no: "1050",
            event_date: "2026-10-12",
            day_parts: "{morning,evening}",
            status: "new",
          },
        ];
      return [];
    });
    const calendar = await getCalendar(fake.db, ACTOR, LISTING_ID, undefined, NOW);
    expect(calendar).toEqual({
      listingId: LISTING_ID,
      mode: "parts",
      parallelCapacity: 1,
      sessions: {
        mode: "parts",
        parts: ["morning", "day", "evening"],
        windows: {
          morning: { from: "06:00", to: "11:00" },
          day: { from: "12:00", to: "17:00" },
          evening: { from: "18:00", to: "24:00" },
        },
        custom: null,
        parallelCapacity: 1,
      },
      parts: [],
      bookings: [],
      month: "2026-10",
      today: "2026-10-01",
      maxDay: "2028-09-30",
      busy: [
        { day: "2026-10-05", source: "vendor", requestId: null },
        { day: "2026-10-07", source: "request_decline", requestId: "eeeeeeee-0000-0000-0000-0000000000a1" },
      ],
      requestDays: ["2026-10-12"],
      requests: [
        {
          id: "eeeeeeee-0000-0000-0000-0000000000b1",
          publicNo: 1050,
          day: "2026-10-12",
          parts: ["morning", "evening"],
          status: "new",
        },
      ],
      version: 7,
    });
    const busy = fake.queries.find((q) => q.sql.includes('"app"."availability"'));
    expect(busy?.parameters).toEqual([LISTING_ID, "2026-10-01", "2026-10-31"]);
    const requests = fake.queries.find((q) => q.sql.includes('from "app"."requests"'));
    expect(requests?.parameters).toEqual(
      expect.arrayContaining(["new", "viewed", "contacted", "deal", "2026-10-01", "2026-10-31"]),
    );
    expect(requests?.parameters).not.toContain("declined");
  });

  it("срок заказа (lead): календаря по частям нет — ни частей, ни заявок дня", async () => {
    const fake = fakeDb((q) => (isListingCheck(q) ? own("lead") : []));
    const calendar = await getCalendar(fake.db, ACTOR, LISTING_ID, "2026-10", NOW);
    expect(calendar).toMatchObject({ mode: "lead", parts: [], bookings: [], requests: [] });
    expect(fake.queries.some((q) => q.sql.includes("availability_parts") || isDeals(q))).toBe(false);
  });

  it("занятые части дня и договорённости по ним (весь день — в каждой части), заказов одновременно", async () => {
    const fake = fakeDb((q) => {
      if (isListingCheck(q)) return own("parts", 2);
      if (isVersion(q)) return [{ version: 3 }];
      if (q.sql.includes('"app"."availability_parts"'))
        return [{ day: "2026-10-05", part: "morning", source: "vendor", request_id: null }];
      if (isDeals(q)) return [{ day: "2026-10-05", part: "evening", count: 2 }];
      return [];
    });
    const calendar = await getCalendar(fake.db, ACTOR, LISTING_ID, "2026-10", NOW);
    expect(calendar).toMatchObject({
      mode: "parts",
      parallelCapacity: 2,
      parts: [{ day: "2026-10-05", part: "morning", source: "vendor", requestId: null }],
      bookings: [{ day: "2026-10-05", part: "evening", count: 2 }],
    });
    const deals = fake.queries.find(isDeals);
    expect(deals?.sql).toContain("cardinality(r.day_parts) = 0");
    expect(deals?.parameters).toEqual([false, LISTING_ID, "2026-10-01", "2026-10-31"]);

    // одно мероприятие в день — каждая договорённость во всех частях
    const whole = fakeDb((q) => (isListingCheck(q) ? own("parts", 1, { part_mode: "whole" }) : []));
    await getCalendar(whole.db, ACTOR, LISTING_ID, "2026-10", NOW);
    expect(whole.queries.find(isDeals)?.parameters[0]).toBe(true);
  });

  it("кривой месяц — 422 без запроса к базе", async () => {
    const fake = fakeDb(() => []);
    const err = await rejection(() => getCalendar(fake.db, ACTOR, LISTING_ID, "2026-13", NOW));
    expect([err.status, err.code]).toEqual([422, "invalid_input"]);
    expect(fake.queries).toEqual([]);
  });
});

describe("markBusy / markFree", () => {
  it("занять: source vendor, повтор не трогает уже занятый день; сначала — сверка версии", async () => {
    const fake = fakeDb((q) => {
      if (isListingCheck(q)) return own();
      if (isVersion(q)) return [{ version: 4 }];
      if (q.sql.startsWith('select "day"')) return [{ day: "2026-10-05", source: "staff", request_id: null }];
      return [];
    });
    const change = await markBusy(fake.db, ACTOR, LISTING_ID, "2026-10-05", 3);
    expect(change).toEqual({
      day: "2026-10-05",
      part: null,
      busy: { day: "2026-10-05", source: "staff", requestId: null },
      version: 4,
    });
    const lock = fake.queries.findIndex(isLock);
    const insert = fake.queries.findIndex((q) => q.sql.startsWith("insert"));
    expect(fake.queries[lock]?.parameters).toEqual([LISTING_ID, 3]);
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(insert);
    expect(fake.queries[insert]?.sql).toContain('on conflict ("listing_id", "day") do nothing');
    expect(fake.queries[insert]?.parameters).toEqual([LISTING_ID, "2026-10-05", "vendor"]);
  });

  it("освободить: удаление по листингу и дню; чужой листинг — 404 без удаления", async () => {
    const mine = fakeDb((q) => (isListingCheck(q) ? own() : isVersion(q) ? [{ version: 9 }] : []));
    expect(await markFree(mine.db, ACTOR, LISTING_ID, "2026-10-05", 8)).toEqual({
      day: "2026-10-05",
      part: null,
      busy: null,
      version: 9,
    });
    const del = mine.queries.find((q) => q.sql.startsWith("delete"));
    expect(del?.sql).toBe('delete from "app"."availability" where "listing_id" = $1 and "day" = $2');
    expect(mine.queries.findIndex(isLock)).toBeLessThan(
      mine.queries.findIndex((q) => q.sql.startsWith("delete")),
    );

    const foreign = fakeDb(() => []);
    expect((await rejection(() => markFree(foreign.db, ACTOR, LISTING_ID, "2026-10-05", 8))).status).toBe(
      404,
    );
    expect(foreign.queries.some((q) => q.sql.startsWith("delete") || isLock(q))).toBe(false);
  });

  it("часть дня: рабочая часть — отметка в availability_parts; иначе — 422 [part]", async () => {
    const parts = fakeDb((q) => {
      if (isListingCheck(q)) return own("parts", 2);
      if (isVersion(q)) return [{ version: 5 }];
      if (q.sql.startsWith('select "day", "part"'))
        return [{ day: "2026-10-05", part: "evening", source: "vendor", request_id: null }];
      return [];
    });
    expect(await markBusy(parts.db, ACTOR, LISTING_ID, "2026-10-05", 4, "evening")).toEqual({
      day: "2026-10-05",
      part: "evening",
      busy: { day: "2026-10-05", part: "evening", source: "vendor", requestId: null },
      version: 5,
    });
    const insert = parts.queries.find((q) => q.sql.startsWith("insert"));
    expect(insert?.sql).toContain('insert into "app"."availability_parts"');
    expect(insert?.sql).toContain('on conflict ("listing_id", "day", "part") do nothing');

    for (const listing of [
      own("lead"),
      own("parts", 1, { part_mode: "whole" }),
      own("parts", 1, { day_parts: "{morning,day}" }),
    ]) {
      const fake = fakeDb((q) => (isListingCheck(q) ? listing : []));
      const err = await rejection(() => markBusy(fake.db, ACTOR, LISTING_ID, "2026-10-05", 4, "evening"));
      expect([err.status, err.code, err.details]).toEqual([422, "invalid_input", ["part"]]);
      expect(fake.queries.some((q) => isLock(q) || q.sql.startsWith("insert"))).toBe(false);
    }
  });

  it("часть дня из адреса: утро, день, вечер; другое — 422 [part]", () => {
    expect(parsePart(undefined)).toBeNull();
    expect(parsePart("")).toBeNull();
    expect(parsePart("day")).toBe("day");
    expect(catching(() => parsePart("night"))).toMatchObject({ status: 422, details: ["part"] });
  });
});

describe("несколько дней сразу", () => {
  it("разбор: дни и части от сегодня до горизонта, без повторов, не «закрыть» и «открыть» сразу", () => {
    expect(
      parseBatch(
        {
          busyParts: [
            { day: "2026-10-03", part: "evening" },
            { day: "2026-10-03", part: "evening" },
            { day: "2026-10-10", part: "evening" },
          ],
          free: ["2026-10-04"],
        },
        NOW,
      ),
    ).toEqual({
      busy: [],
      free: ["2026-10-04"],
      busyParts: [
        { day: "2026-10-03", part: "evening" },
        { day: "2026-10-10", part: "evening" },
      ],
      freeParts: [],
    });
    expect(catching(() => parseBatch({}, NOW))).toMatchObject({ status: 422, code: "invalid_input" });
    expect(catching(() => parseBatch({ busy: ["2026-09-30"] }, NOW))).toMatchObject({
      status: 422,
      code: "date_out_of_range",
      details: ["busy"],
    });
    expect(catching(() => parseBatch({ busy: ["2026-10-04"], free: ["2026-10-04"] }, NOW))).toMatchObject({
      details: ["free"],
    });
    expect(
      catching(() => parseBatch({ busyParts: [{ day: "2026-10-04", part: "night" }] }, NOW)),
    ).toMatchObject({ details: ["busyParts"] });
    expect(
      catching(() => parseBatch({ busy: Array.from({ length: 401 }, () => "2026-10-04") }, NOW)),
    ).toMatchObject({ details: ["busy"] });
  });

  it("одной правкой от версии: отметки вендора; «открыть» не снимает отметок менеджера", async () => {
    const fake = fakeDb((q) => {
      if (isListingCheck(q)) return own("parts", 1, { day_parts: "{morning,evening}" });
      if (isVersion(q)) return [{ version: 12 }];
      if (q.sql.includes("select count(*)::int as n from app.availability_parts")) return [{ n: 1 }];
      return [];
    });
    const result = await applyBatch(
      fake.db,
      ACTOR,
      LISTING_ID,
      {
        busy: [],
        free: [],
        busyParts: [
          { day: "2026-10-03", part: "evening" },
          { day: "2026-10-10", part: "evening" },
        ],
        freeParts: [{ day: "2026-10-17", part: "evening" }],
      },
      11,
    );
    expect(result).toMatchObject({ from: "2026-10-03", to: "2026-10-17", skipped: 1, version: 12 });
    const lock = fake.queries.findIndex(isLock);
    expect(fake.queries[lock]?.parameters).toEqual([LISTING_ID, 11]);
    const insert = fake.queries.find((q) => q.sql.startsWith('insert into "app"."availability_parts"'));
    expect(insert?.parameters).toEqual([
      LISTING_ID,
      "2026-10-03",
      "evening",
      "vendor",
      LISTING_ID,
      "2026-10-10",
      "evening",
      "vendor",
    ]);
    const del = fake.queries.find((q) => q.sql.includes("delete from app.availability_parts"));
    expect(del?.sql).toContain("a.source <> 'staff'");
    expect(del?.parameters).toEqual([LISTING_ID, ["2026-10-17/evening"]]);
  });

  it("часть, в которой витрина не работает, — 422 до правки", async () => {
    const fake = fakeDb((q) =>
      isListingCheck(q) ? own("parts", 1, { day_parts: "{morning,evening}" }) : [],
    );
    const err = await rejection(() =>
      applyBatch(
        fake.db,
        ACTOR,
        LISTING_ID,
        { busy: [], free: [], busyParts: [{ day: "2026-10-03", part: "day" }], freeParts: [] },
        1,
      ),
    );
    expect([err.status, err.details]).toEqual([422, ["busyParts"]]);
    expect(fake.queries.some(isLock)).toBe(false);
  });
});

describe("время работы", () => {
  const body = { mode: "parts", parts: ["morning", "evening"], windows: null, parallelCapacity: 2 };
  const isSave = (q: RecordedQuery) => q.sql.includes("app.listing_set_day_sessions");

  it("владелец: проверка по категории и сохранение от версии календаря", async () => {
    const fake = fakeDb((q) => {
      if (isListingCheck(q)) return own();
      if (isSave(q)) return [{ version: 9 }];
      return [];
    });
    const change = await setDaySessions(
      fake.db,
      ACTOR,
      LISTING_ID,
      { ...body, windows: { evening: { from: "17:30", to: "24:00" }, day: { from: "12:00", to: "15:00" } } },
      8,
      NOW,
    );
    expect(change.version).toBe(9);
    expect(change.sessions).toMatchObject({
      mode: "parts",
      parts: ["morning", "evening"],
      custom: { evening: { from: "17:30", to: "24:00" } },
      parallelCapacity: 2,
    });
    // своё окно нерабочей части (день) не сохраняется
    expect(fake.queries.find(isSave)?.parameters).toEqual([
      LISTING_ID,
      "parts",
      ["morning", "evening"],
      JSON.stringify({ evening: { from: "17:30", to: "24:00" } }),
      2,
      8,
    ]);
  });

  it("часть с будущими заявками не убрать — 409 part_in_use с числом заявок", async () => {
    const fake = fakeDb((q) => {
      if (isListingCheck(q)) return own();
      if (q.sql.includes("unnest(r.day_parts)")) return [{ part: "day", count: 2 }];
      return [];
    });
    const err = await rejection(() => setDaySessions(fake.db, ACTOR, LISTING_ID, body, 8, NOW));
    expect(err.toBody()).toEqual({
      inUse: [{ part: "day", count: 2 }],
      error: { code: "part_in_use", message: "This part of the day has upcoming requests", details: ["day"] },
    });
    expect(err.status).toBe(409);
    expect(fake.queries.find((q) => q.sql.includes("unnest(r.day_parts)"))?.parameters).toEqual([
      LISTING_ID,
      "2026-10-01",
      ["day"],
    ]);
    expect(fake.queries.some(isSave)).toBe(false);
  });

  it("на одно мероприятие в день — без проверки заявок; ошибки полей — 422", async () => {
    const fake = fakeDb((q) => (isListingCheck(q) ? own() : isSave(q) ? [{ version: 2 }] : []));
    await setDaySessions(fake.db, ACTOR, LISTING_ID, { ...body, mode: "whole" }, 1, NOW);
    expect(fake.queries.some((q) => q.sql.includes("unnest(r.day_parts)"))).toBe(false);
    const bad = fakeDb((q) => (isListingCheck(q) ? own() : []));
    const err = await rejection(() =>
      setDaySessions(bad.db, ACTOR, LISTING_ID, { ...body, parts: [], parallelCapacity: 0 }, 1, NOW),
    );
    expect([err.status, err.code, err.details]).toEqual([
      422,
      "invalid_input",
      ["parts", "parallelCapacity"],
    ]);
  });

  it("сотрудник площадки — 403 vendor_owner_required без запросов; срок заказа — 404", async () => {
    const fake = fakeDb((q) => (isListingCheck(q) ? own() : []));
    const err = await rejection(() =>
      setDaySessions(fake.db, { ...ACTOR, role: "member" }, LISTING_ID, body, 1, NOW),
    );
    expect([err.status, err.code]).toEqual([403, "vendor_owner_required"]);
    expect(fake.queries).toEqual([]);
    const lead = fakeDb((q) => (isListingCheck(q) ? own("lead") : []));
    expect((await rejection(() => setDaySessions(lead.db, ACTOR, LISTING_ID, body, 1, NOW))).status).toBe(
      404,
    );
  });
});
