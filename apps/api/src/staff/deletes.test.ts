// Удаление в панели без базы: какая функция базы вызывается, что отвечает маршрут, когда
// удаляются объекты фото и как переводятся отказы базы. Правила и каскад — pgTAP
// (supabase/tests/26_staff_deletes.test.sql), на настоящей базе — test/integration/staff-admin.test.ts

import { LISTING_PHOTOS_BUCKET } from "@bayramm/media";
import { Hono } from "hono";
import { DatabaseError } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticate, requireStaff } from "../auth/session";
import type { StaffRole } from "../db/actor";
import type { AppEnv } from "../env";
import { handleError, type PgError } from "../errors";
import { sections } from "../routes/staff";
import { fakeDb, type RecordedQuery } from "../testing/fake-db";
import { makeEnv } from "../testing/worker";

const LISTING_ID = "bbbbbbbb-0000-4000-8000-000000000101";
const VENDOR_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const STAFF_ID = "cccccccc-0000-4000-8000-000000000001";
const KEYS = [`listings/${LISTING_ID}/11111111-0000-4000-8000-000000000001.webp`];

function pgError(code: string, detail?: string): DatabaseError {
  const err = new DatabaseError("db error", 0, "error");
  Object.assign(err, { severity: "ERROR", code, detail } satisfies Partial<PgError>);
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
  const request = (path: string) =>
    app.request(
      path,
      { method: "DELETE", headers: { Authorization: `Bearer ${"t".repeat(43)}` } },
      makeEnv(),
    );
  return { request, fake };
}

/** Хранилище: запросы удаления объектов (fetch к Storage) */
function storage(response: () => Promise<Response> = async () => Response.json([{}])) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(response);
}

async function errorOf(res: Response) {
  const body = (await res.json()) as { error: { code: string; details?: string[] } };
  return { status: res.status, ...body.error };
}

afterEach(() => vi.restoreAllMocks());

describe("DELETE /staff/listings/:id", () => {
  it("база удаляет витрину и отдаёт ключи фото — объекты удаляются после фиксации; 204", async () => {
    const fetch = storage();
    const { request, fake } = appAs("manager", (q) =>
      q.sql.includes("app.staff_delete_listing") ? [{ keys: KEYS }] : [],
    );
    const res = await request(`/listings/${LISTING_ID}`);
    expect(res.status).toBe(204);
    const call = fake.queries.find((q) => q.sql.includes("app.staff_delete_listing"));
    expect(call?.parameters).toEqual([LISTING_ID]);
    // Сначала фиксация, потом хранилище
    expect(fake.log.slice(-1)).toEqual(["commit"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe(`http://127.0.0.1:54321/storage/v1/object/${LISTING_PHOTOS_BUCKET}`);
    expect(init?.method).toBe("DELETE");
    expect(JSON.parse(String(init?.body))).toEqual({ prefixes: KEYS });
  });

  it("фото не было — хранилище не трогаем", async () => {
    const fetch = storage();
    const { request } = appAs("admin", (q) =>
      q.sql.includes("app.staff_delete_listing") ? [{ keys: [] }] : [],
    );
    expect((await request(`/listings/${LISTING_ID}`)).status).toBe(204);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("хранилище не ответило — витрина всё равно удалена (объекты уберёт сверка)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    storage(async () => {
      throw new TypeError("network down");
    });
    const { request } = appAs("admin", (q) =>
      q.sql.includes("app.staff_delete_listing") ? [{ keys: KEYS }] : [],
    );
    expect((await request(`/listings/${LISTING_ID}`)).status).toBe(204);
  });

  it("есть заявки или опубликована — 409 listing_in_use с причиной; хранилище не трогаем", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = storage();
    for (const reason of ["requests", "published"]) {
      const { request, fake } = appAs("admin", (q) => {
        if (q.sql.includes("app.staff_delete_listing")) throw pgError("BR029", reason);
        return [];
      });
      const res = await request(`/listings/${LISTING_ID}`);
      expect(await errorOf(res)).toMatchObject({ status: 409, code: "listing_in_use", details: [reason] });
      expect(fake.log).toContain("rollback");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("нет такой витрины — 404; кривой id — 404 без удаления", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { request } = appAs("admin", (q) => {
      if (q.sql.includes("app.staff_delete_listing")) throw pgError("42501");
      return [];
    });
    expect((await request(`/listings/${LISTING_ID}`)).status).toBe(404);
    const bad = appAs("admin", () => []);
    expect((await bad.request("/listings/not-a-uuid")).status).toBe(404);
    expect(bad.fake.queries.some((q) => q.sql.includes("app.staff_delete_listing"))).toBe(false);
  });
});

describe("DELETE /staff/vendors/:id", () => {
  it("база удаляет вендора и отдаёт ключи фото всех витрин; 204", async () => {
    const fetch = storage();
    const { request, fake } = appAs("admin", (q) =>
      q.sql.includes("app.staff_delete_vendor") ? [{ keys: KEYS }] : [],
    );
    expect((await request(`/vendors/${VENDOR_ID}`)).status).toBe(204);
    expect(fake.queries.find((q) => q.sql.includes("app.staff_delete_vendor"))?.parameters).toEqual([
      VENDOR_ID,
    ]);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ prefixes: KEYS });
  });

  it("у витрины заявки или публикация — 409 vendor_in_use с причиной", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { request } = appAs("admin", (q) => {
      if (q.sql.includes("app.staff_delete_vendor")) throw pgError("BR030", "published");
      return [];
    });
    expect(await errorOf(await request(`/vendors/${VENDOR_ID}`))).toMatchObject({
      status: 409,
      code: "vendor_in_use",
      details: ["published"],
    });
  });
});

describe("DELETE /staff/team/:id", () => {
  const member = {
    id: STAFF_ID,
    role: "manager",
    active: true,
    tg_linked_at: null,
    created_at: new Date("2026-10-01T00:00:00Z"),
    display_name: "Pending",
    telegram_username: "pending_person",
    by_phone: false,
    accepted: false,
  };

  it("непринятое приглашение — функцией базы; ответ — команда без него", async () => {
    let revoked = false;
    const { request, fake } = appAs("admin", (q) => {
      if (q.sql.includes('from "app"."staff"') && q.sql.includes('"id" = $1')) return [{ id: STAFF_ID }];
      if (q.sql.includes("app.staff_revoke_invite")) {
        revoked = true;
        return [{}];
      }
      if (q.sql.includes('from "app"."staff" as "s"')) return revoked ? [] : [member];
      return [];
    });
    const res = await request(`/team/${STAFF_ID}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
    expect(fake.queries.find((q) => q.sql.includes("app.staff_revoke_invite"))?.parameters).toEqual([
      STAFF_ID,
    ]);
  });

  it("принятое — 409 staff_invite_accepted; нет такого — 404", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const accepted = appAs("admin", (q) => {
      if (q.sql.includes('from "app"."staff"') && q.sql.includes('"id" = $1')) return [{ id: STAFF_ID }];
      if (q.sql.includes("app.staff_revoke_invite")) throw pgError("BR033", "приглашение принято");
      return [];
    });
    expect(await errorOf(await accepted.request(`/team/${STAFF_ID}`))).toMatchObject({
      status: 409,
      code: "staff_invite_accepted",
    });
    const missing = appAs("admin", () => []);
    expect((await missing.request(`/team/${STAFF_ID}`)).status).toBe(404);
    expect(missing.fake.queries.some((q) => q.sql.includes("app.staff_revoke_invite"))).toBe(false);
  });
});
