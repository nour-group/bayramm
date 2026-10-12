// Запросы на смену контактов витрины в панели без базы: кто что может, какие функции базы
// вызываются, что уходит в ответе (без номеров, пока не «Показать») и как переводятся отказы
// базы. Правила, журнал и чтение значений — pgTAP (supabase/tests/29_vendor_photos_contacts.test.sql),
// на настоящей базе — test/integration/staff-admin.test.ts

import { Hono } from "hono";
import { DatabaseError } from "pg";
import { describe, expect, it } from "vitest";
import { authenticate, requireStaff } from "../auth/session";
import type { StaffRole } from "../db/actor";
import type { AppEnv } from "../env";
import { handleError, type PgError } from "../errors";
import { sections } from "../routes/staff";
import { fakeDb, type RecordedQuery } from "../testing/fake-db";
import { makeEnv } from "../testing/worker";

const LISTING_ID = "bbbbbbbb-0000-4000-8000-000000000101";
const CHANGE_ID = "c0c0c0c0-0000-4000-8000-000000000001";
const SUBMITTED = new Date("2026-10-12T05:00:00Z");

function pgError(code: string): DatabaseError {
  const err = new DatabaseError("db error", 0, "error");
  Object.assign(err, { severity: "ERROR", code } satisfies Partial<PgError>);
  return err;
}

/** Панель под ролью; respond — ответ «базы» на запросы обработчика (сессию отдаёт сам) */
function appAs(role: StaffRole, respond: (q: RecordedQuery) => unknown[]) {
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
  const fake = fakeDb((q) => (q.sql.includes('from "app"."sessions"') ? [session] : respond(q)));
  const app = new Hono<AppEnv>();
  app.use(async (c, next) => {
    c.set("db", fake.db);
    await next();
  });
  app.use(authenticate, requireStaff());
  app.route("/", sections);
  app.onError(handleError);
  const request = (path: string, method = "GET", body?: unknown) =>
    app.request(
      path,
      {
        method,
        headers: {
          Authorization: `Bearer ${"t".repeat(43)}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      makeEnv(),
    );
  return { request, fake };
}

const exists = (q: RecordedQuery) => q.sql.startsWith('select "id" from "app"."listings"');
const pending = {
  change_id: CHANGE_ID,
  status: "pending",
  reason: null,
  submitted_at: SUBMITTED,
  decided_at: null,
  phone_changed: true,
  telegram_changed: false,
};
const fnCalls = (fake: ReturnType<typeof appAs>["fake"], name: string) =>
  fake.queries.filter((q) => q.sql.includes(name));

async function errorOf(res: Response) {
  const body = (await res.json()) as { error: { code: string; details?: string[] } };
  return { status: res.status, ...body.error };
}

describe("GET /staff/listings/:id/contact-change", () => {
  it("ждущий запрос — что меняется, без значений; решённый и отозванный — null; любая роль", async () => {
    for (const role of ["admin", "manager", "moderator"] as const) {
      const { request, fake } = appAs(role, (q) =>
        exists(q) ? [{ id: LISTING_ID }] : q.sql.includes("app.contact_change_state") ? [pending] : [],
      );
      const res = await request(`/listings/${LISTING_ID}/contact-change`);
      expect(res.status, role).toBe(200);
      expect(await res.json()).toEqual({
        change: {
          id: CHANGE_ID,
          submittedAt: SUBMITTED.toISOString(),
          phoneChanged: true,
          telegramChanged: false,
        },
      });
      // Значения не читаются: журнала доступа к ПДн нет
      expect(fnCalls(fake, "read_listing_contact")).toEqual([]);
    }
    for (const status of ["approved", "declined", "withdrawn"]) {
      const { request } = appAs("admin", (q) =>
        exists(q)
          ? [{ id: LISTING_ID }]
          : q.sql.includes("app.contact_change_state")
            ? [{ ...pending, status }]
            : [],
      );
      const res = await request(`/listings/${LISTING_ID}/contact-change`);
      expect(await res.json(), status).toEqual({ change: null });
    }
  });

  it("нет витрины — 404; кривой id — 404 без базы", async () => {
    const { request } = appAs("admin", () => []);
    expect((await request(`/listings/${LISTING_ID}/contact-change`)).status).toBe(404);
    const bad = appAs("admin", () => []);
    expect((await bad.request("/listings/not-an-id/contact-change")).status).toBe(404);
    expect(bad.fake.queries.filter((q) => q.sql.includes("listings") || q.sql.includes("contact"))).toEqual(
      [],
    );
  });
});

describe("POST /staff/listings/:id/contact-change/reveal", () => {
  const respond = (q: RecordedQuery) => {
    if (exists(q)) return [{ id: LISTING_ID }];
    if (q.sql.includes("pii.read_listing_contact_change"))
      return [{ phone: "+998000000555", telegram: "new_lola" }];
    if (q.sql.includes("pii.read_listing_contacts")) return [{ phone: "+998000000999", telegram: null }];
    return [];
  };

  it("значения запроса и нынешние контакты — модератору и администратору; причина идёт в журнал базы", async () => {
    for (const role of ["admin", "moderator"] as const) {
      const { request, fake } = appAs(role, respond);
      const res = await request(`/listings/${LISTING_ID}/contact-change/reveal`, "POST", {
        reason: "проверка номера",
      });
      expect(res.status, role).toBe(200);
      expect(await res.json()).toEqual({
        phone: "+998000000555",
        telegram: "new_lola",
        current: { phone: "+998000000999", telegram: null },
      });
      expect(fnCalls(fake, "pii.read_listing_contact_change")[0]?.parameters).toEqual([
        LISTING_ID,
        "проверка номера",
      ]);
    }
  });

  it("без причины — тоже можно (она необязательна); менеджеру — 403 и база не читается", async () => {
    const ok = appAs("moderator", respond);
    expect((await ok.request(`/listings/${LISTING_ID}/contact-change/reveal`, "POST")).status).toBe(200);
    expect(fnCalls(ok.fake, "pii.read_listing_contact_change")[0]?.parameters).toEqual([LISTING_ID, null]);
    const manager = appAs("manager", respond);
    const res = await manager.request(`/listings/${LISTING_ID}/contact-change/reveal`, "POST");
    expect(res.status).toBe(403);
    expect(fnCalls(manager.fake, "pii.read")).toEqual([]);
  });

  it("ждущего запроса нет — 409 contact_change_not_pending, нынешние контакты не читаются", async () => {
    const { request, fake } = appAs("admin", (q) => (exists(q) ? [{ id: LISTING_ID }] : []));
    const res = await request(`/listings/${LISTING_ID}/contact-change/reveal`, "POST");
    expect(await errorOf(res)).toMatchObject({ status: 409, code: "contact_change_not_pending" });
    expect(fnCalls(fake, "pii.read_listing_contacts")).toEqual([]);
  });
});

describe("POST /staff/listings/:id/contact-change/approve | decline", () => {
  const respond = (q: RecordedQuery) => (exists(q) ? [{ id: LISTING_ID }] : []);

  it("одобрить — функция базы, 200 { change: null }; только администратор и модератор", async () => {
    for (const role of ["admin", "moderator"] as const) {
      const { request, fake } = appAs(role, respond);
      const res = await request(`/listings/${LISTING_ID}/contact-change/approve`, "POST");
      expect(res.status, role).toBe(200);
      expect(await res.json()).toEqual({ change: null });
      expect(fnCalls(fake, "app.staff_approve_contact_change")[0]?.parameters).toEqual([LISTING_ID]);
      expect(fake.log.at(-1)).toBe("commit");
    }
    const manager = appAs("manager", respond);
    expect((await manager.request(`/listings/${LISTING_ID}/contact-change/approve`, "POST")).status).toBe(
      403,
    );
    expect(fnCalls(manager.fake, "app.staff_approve_contact_change")).toEqual([]);
  });

  it("отклонить — только с причиной, её видит партнёр; без причины и с пустой — 422 reason", async () => {
    const { request, fake } = appAs("moderator", respond);
    const res = await request(`/listings/${LISTING_ID}/contact-change/decline`, "POST", {
      reason: "  Номер не зала  ",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ change: null });
    expect(fnCalls(fake, "app.staff_decline_contact_change")[0]?.parameters).toEqual([
      LISTING_ID,
      "Номер не зала",
    ]);
    for (const body of [{}, { reason: "" }, { reason: "   " }, { reason: 5 }, { reason: "x".repeat(501) }]) {
      const bad = appAs("admin", respond);
      const out = await bad.request(`/listings/${LISTING_ID}/contact-change/decline`, "POST", body);
      expect(await errorOf(out), JSON.stringify(body)).toMatchObject({
        status: 422,
        code: "invalid_input",
        details: ["reason"],
      });
      expect(fnCalls(bad.fake, "app.staff_decline_contact_change")).toEqual([]);
    }
    const manager = appAs("manager", respond);
    const forbidden = await manager.request(`/listings/${LISTING_ID}/contact-change/decline`, "POST", {
      reason: "нет",
    });
    expect(forbidden.status).toBe(403);
  });

  it("решать нечего (BR037) — 409 contact_change_not_pending; нет витрины — 404", async () => {
    for (const action of ["approve", "decline"]) {
      const { request } = appAs("admin", (q) => {
        if (exists(q)) return [{ id: LISTING_ID }];
        throw pgError("BR037");
      });
      const res = await request(
        `/listings/${LISTING_ID}/contact-change/${action}`,
        "POST",
        action === "decline" ? { reason: "нет" } : undefined,
      );
      expect(await errorOf(res), action).toMatchObject({ status: 409, code: "contact_change_not_pending" });
    }
    const missing = appAs("admin", () => []);
    expect((await missing.request(`/listings/${LISTING_ID}/contact-change/approve`, "POST")).status).toBe(
      404,
    );
  });
});

describe("GET /staff/contact-changes", () => {
  const row = {
    change_id: CHANGE_ID,
    listing_id: LISTING_ID,
    listing_name: "Lola zali",
    listing_status: "active",
    category_code: "hall",
    vendor_id: "aaaaaaaa-0000-4000-8000-000000000001",
    vendor_code: "V101",
    submitted_at: SUBMITTED,
    phone_changed: true,
    telegram_changed: true,
    total: "3",
  };

  it("очередь ждущих: витрина, вендор, что меняется и сколько всего — без номеров; limit и offset — в функцию", async () => {
    const { request, fake } = appAs("moderator", (q) =>
      q.sql.includes("app.staff_contact_changes") ? [row] : [],
    );
    const res = await request("/contact-changes?limit=20&offset=40");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      total: 3,
      items: [
        {
          id: CHANGE_ID,
          submittedAt: SUBMITTED.toISOString(),
          phoneChanged: true,
          telegramChanged: true,
          listing: { id: LISTING_ID, name: "Lola zali", status: "active", categoryCode: "hall" },
          vendor: { id: "aaaaaaaa-0000-4000-8000-000000000001", code: "V101" },
        },
      ],
    });
    expect(fnCalls(fake, "app.staff_contact_changes")[0]?.parameters).toEqual([20, 40]);
    expect(JSON.stringify(await (await request("/contact-changes")).json())).not.toMatch(/\+998/);
  });

  it("пусто — total 0; менеджеру — 403", async () => {
    const empty = appAs("admin", () => []);
    expect(await (await empty.request("/contact-changes")).json()).toEqual({ total: 0, items: [] });
    const manager = appAs("manager", () => [row]);
    expect((await manager.request("/contact-changes")).status).toBe(403);
    expect(fnCalls(manager.fake, "app.staff_contact_changes")).toEqual([]);
  });
});
