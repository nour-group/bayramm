// Метрики в панели без базы: разбор параметров, перевод строк функций app.metrics_* в контракт
// (numeric из pg — строка, даты — Date), 404 на чужого вендора. Сами определения — pgTAP
// (supabase/tests/17_launch_metrics.test.sql, категории — 21_services_only_category_metrics.test.sql)
import type {
  CategoryMetricsList,
  MetricsOverview,
  VendorMetricsList,
  VendorResponseStats,
} from "@bayramm/shared/api/staff";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticate, requireStaff } from "../auth/session";
import type { StaffRole } from "../db/actor";
import type { AppEnv } from "../env";
import { handleError } from "../errors";
import { sections } from "../routes/staff";
import { fakeDb, type RecordedQuery } from "../testing/fake-db";
import { makeEnv } from "../testing/worker";
import { categoryParam, intParam } from "./metrics";

const VENDOR_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const LISTING_ID = "bbbbbbbb-0000-4000-8000-000000000001";

const PERIOD_ROW = {
  requests: 7,
  clients: 2,
  measurable: 6,
  answered_in_time: 3,
  answered_rate: "50.0",
  responded: 4,
  median_response_minutes: 330,
  p90_response_minutes: 696,
  agreed: 2,
  agreed_rate: "28.6",
  sla_breaches: 2,
  dead_notifications: 2,
};
const RESPONSE_ROW = {
  requests: 7,
  measurable: 5,
  answered_in_time: 3,
  answered_rate: "60.0",
  responded: 4,
  median_response_minutes: 210,
  sla_breaches: 1,
  agreed: 1,
  last_request_at: new Date("2026-09-30T05:00:00Z"),
};

function appAs(role: StaffRole, vendorFound = true) {
  const accountId = "acacacac-0000-0000-0000-000000000001";
  const session = {
    sessionId: "11111111-0000-0000-0000-000000000001",
    accountId,
    app: "admin",
    via: "staff_elevation",
    proofAt: new Date(),
    accountDisabledAt: null,
    accountDeletedAt: null,
    clientId: null,
    clientBlocked: null,
    clientDeleted: null,
    staffId: "00000000-0000-0000-0000-00000000a001",
    staffRole: role,
    staffActive: true,
    staffAccountId: accountId,
  };
  const fake = fakeDb((q: RecordedQuery) => {
    if (q.sql.includes('from "app"."sessions"')) return [session];
    if (q.sql.includes("app.setting_int('sla_hours')")) return [{ hours: 12 }];
    if (q.sql.includes("app.metrics_weekly"))
      return [
        {
          week_start: "2026-09-28",
          week_label: "2026-W40",
          partial: true,
          ...PERIOD_ROW,
          answered_rate: null,
        },
        { week_start: "2026-09-21", week_label: "2026-W39", partial: false, ...PERIOD_ROW },
      ];
    if (q.sql.includes("app.metrics_ops_now"))
      return [
        {
          awaiting: 3,
          overdue: 1,
          dead_total: 3,
          listings_review: 0,
          revisions_pending: 0,
          photos_pending: 1,
          services_pending: 2,
        },
      ];
    if (q.sql.includes("app.metrics_vendors"))
      return vendorFound
        ? [
            {
              vendor_id: VENDOR_ID,
              vendor_code: "V101",
              vendor_name: null,
              active_listings: 1,
              categories: ["hall", "car"],
              ...RESPONSE_ROW,
            },
          ]
        : [];
    if (q.sql.includes("app.metrics_listings"))
      return [
        {
          listing_id: LISTING_ID,
          listing_name: "Test Hall",
          listing_status: "active",
          category_code: "hall",
          ...RESPONSE_ROW,
        },
      ];
    if (q.sql.includes("app.metrics_categories"))
      return [
        {
          category_code: "hall",
          active_listings: 4,
          active_vendors: 3,
          clients: 6,
          p90_response_minutes: 700,
          agreed_rate: "14.3",
          ...RESPONSE_ROW,
        },
      ];
    return [];
  });
  const app = new Hono<AppEnv>();
  app.use(async (c, next) => {
    c.set("db", fake.db);
    await next();
  });
  app.use(authenticate, requireStaff());
  app.route("/", sections);
  app.onError(handleError);
  return { app, fake };
}

const get = (app: Hono<AppEnv>, path: string) =>
  app.request(path, { headers: { Authorization: `Bearer ${"t".repeat(43)}` } }, makeEnv());

afterEach(() => vi.restoreAllMocks());

describe("intParam", () => {
  it("нет — по умолчанию; целое в границах; иначе 422 с именем параметра", () => {
    expect(intParam(undefined, "weeks", 8, 52)).toBe(8);
    expect(intParam("", "weeks", 8, 52)).toBe(8);
    expect(intParam("12", "weeks", 8, 52)).toBe(12);
    for (const raw of ["0", "53", "-1", "1.5", "abc", "1e2", " 8"]) {
      expect(() => intParam(raw, "weeks", 8, 52), raw).toThrowError(
        expect.objectContaining({ status: 422, code: "invalid_input", details: ["weeks"] }),
      );
    }
  });
});

describe("categoryParam", () => {
  it("нет — все категории; код из конфигурации; иначе 422 category", () => {
    expect(categoryParam(undefined)).toBeNull();
    expect(categoryParam("")).toBeNull();
    expect(categoryParam("car")).toBe("car");
    for (const raw of ["nope", "HALL", "hall;drop"]) {
      expect(() => categoryParam(raw), raw).toThrowError(
        expect.objectContaining({ status: 422, code: "invalid_input", details: ["category"] }),
      );
    }
  });
});

describe("GET /metrics", () => {
  it("модератор видит недели и очереди; доли — числа, пусто — null", async () => {
    const { app, fake } = appAs("moderator");
    const res = await get(app, "/metrics?weeks=2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as MetricsOverview;
    expect(body.slaHours).toBe(12);
    expect(body.category).toBeNull();
    expect(body.weeks[0]).toMatchObject({ weekLabel: "2026-W40", partial: true, answeredRate: null });
    expect(body.weeks[1]).toMatchObject({
      weekStart: "2026-09-21",
      requests: 7,
      answeredRate: 50,
      medianResponseMinutes: 330,
      p90ResponseMinutes: 696,
      agreedRate: 28.6,
      slaBreaches: 2,
    });
    expect(body.queues).toEqual({
      awaiting: 3,
      overdue: 1,
      deadTotal: 3,
      listingsReview: 0,
      revisionsPending: 0,
      photosPending: 1,
      servicesPending: 2,
    });
    expect(fake.queries.find((q) => q.sql.includes("app.metrics_weekly"))?.parameters).toEqual([2, null]);
    // под актором сотрудника, не системы
    expect(fake.queries.some((q) => q.parameters[0] === "staff")).toBe(true);
  });

  it("категория — фильтр недель, очереди — все", async () => {
    const { app, fake } = appAs("moderator");
    const body = (await (await get(app, "/metrics?category=car")).json()) as MetricsOverview;
    expect(body.category).toBe("car");
    expect(fake.queries.find((q) => q.sql.includes("app.metrics_weekly"))?.parameters).toEqual([8, "car"]);
    expect(fake.queries.find((q) => q.sql.includes("app.metrics_ops_now"))?.parameters).toEqual([]);
  });

  it("неверный weeks или category — 422 до базы", async () => {
    const { app, fake } = appAs("admin");
    expect((await get(app, "/metrics?weeks=100")).status).toBe(422);
    expect((await get(app, "/metrics?category=nope")).status).toBe(422);
    expect(fake.queries.some((q) => q.sql.includes("app.metrics_"))).toBe(false);
  });
});

describe("GET /metrics/categories", () => {
  it("сводка по категориям за 30 дней по умолчанию", async () => {
    const { app, fake } = appAs("manager");
    const body = (await (await get(app, "/metrics/categories")).json()) as CategoryMetricsList;
    expect(body.days).toBe(30);
    expect(body.items).toEqual([
      {
        categoryCode: "hall",
        activeListings: 4,
        activeVendors: 3,
        clients: 6,
        p90ResponseMinutes: 700,
        agreedRate: 14.3,
        requests: 7,
        measurable: 5,
        answeredInTime: 3,
        answeredRate: 60,
        responded: 4,
        medianResponseMinutes: 210,
        slaBreaches: 1,
        agreed: 1,
        lastRequestAt: "2026-09-30T05:00:00.000Z",
      },
    ]);
    expect(fake.queries.find((q) => q.sql.includes("app.metrics_categories"))?.parameters).toEqual([30]);
    expect((await get(app, "/metrics/categories?days=0")).status).toBe(422);
  });
});

describe("GET /metrics/vendors", () => {
  it("по вендорам за 30 дней по умолчанию; последняя заявка — ISO", async () => {
    const { app, fake } = appAs("manager");
    const body = (await (await get(app, "/metrics/vendors")).json()) as VendorMetricsList;
    expect(body.days).toBe(30);
    expect(body.category).toBeNull();
    expect(body.items[0]).toEqual({
      vendor: { id: VENDOR_ID, code: "V101", name: null },
      activeListings: 1,
      categories: ["hall", "car"],
      requests: 7,
      measurable: 5,
      answeredInTime: 3,
      answeredRate: 60,
      responded: 4,
      medianResponseMinutes: 210,
      slaBreaches: 1,
      agreed: 1,
      lastRequestAt: "2026-09-30T05:00:00.000Z",
    });
    expect(fake.queries.find((q) => q.sql.includes("app.metrics_vendors"))?.parameters).toEqual([
      30,
      null,
      null,
    ]);
  });

  it("с категорией — только её заявки и витрины", async () => {
    const { app, fake } = appAs("manager");
    const body = (await (
      await get(app, "/metrics/vendors?days=7&category=hall")
    ).json()) as VendorMetricsList;
    expect(body.category).toBe("hall");
    expect(fake.queries.find((q) => q.sql.includes("app.metrics_vendors"))?.parameters).toEqual([
      7,
      null,
      "hall",
    ]);
  });

  it("вендор и его площадки; нет вендора — 404", async () => {
    const found = appAs("admin");
    const body = (await (
      await get(found.app, `/metrics/vendors/${VENDOR_ID}?days=7`)
    ).json()) as VendorResponseStats;
    expect(body.days).toBe(7);
    expect(body.vendor.vendor.id).toBe(VENDOR_ID);
    expect(body.listings).toEqual([
      expect.objectContaining({
        listing: { id: LISTING_ID, name: "Test Hall", status: "active", categoryCode: "hall" },
        requests: 7,
      }),
    ]);
    expect(found.fake.queries.find((q) => q.sql.includes("app.metrics_vendors"))?.parameters).toEqual([
      7,
      VENDOR_ID,
      null,
    ]);
    const missing = appAs("admin", false);
    expect((await get(missing.app, `/metrics/vendors/${VENDOR_ID}`)).status).toBe(404);
    expect((await get(missing.app, "/metrics/vendors/not-a-uuid")).status).toBe(404);
  });
});
