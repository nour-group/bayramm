import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../env";
import { handleError } from "../errors";
import { type FakeDb, fakeDb, type RecordedQuery } from "../testing/fake-db";
import { generateToken, hashToken } from "./crypto";
import {
  accountOf,
  authenticate,
  requireClient,
  requireSession,
  requireStaff,
  requireVendor,
  staffOf,
  vendorOf,
} from "./session";
import { chooseMembership } from "./vendor";

const SESSION_ID = "11111111-0000-0000-0000-000000000001";
const ACCOUNT_ID = "acacacac-0000-0000-0000-000000000001";
const OTHER_ACCOUNT = "acacacac-0000-0000-0000-000000000002";
const CLIENT_ID = "cccccccc-0000-0000-0000-000000000001";
const STAFF_ID = "00000000-0000-0000-0000-00000000a001";
const VENDOR_USER_ID = "aaaaaaaa-0000-0000-0000-000000000011";
const VENDOR_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const VENDOR_USER_B = "bbbbbbbb-0000-0000-0000-000000000011";
const VENDOR_B = "bbbbbbbb-0000-0000-0000-000000000001";
const PROOF_AT = new Date("2026-09-29T10:00:00Z");

interface SessionRow {
  sessionId: string;
  accountId: string;
  app: string;
  via: string;
  proofAt: Date;
  accountDisabledAt: Date | null;
  accountDeletedAt: Date | null;
  staffId: string | null;
  staffRole: "admin" | "manager" | "moderator" | null;
  staffActive: boolean | null;
  staffAccountId: string | null;
  clientId: string | null;
  clientBlocked: boolean | null;
  clientDeleted: boolean | null;
}

interface MembershipRow {
  id: string;
  vendor_id: string;
  role: string;
  disabled_at: Date | null;
}

const accountSession = (patch: Partial<SessionRow> = {}): SessionRow => ({
  sessionId: SESSION_ID,
  accountId: ACCOUNT_ID,
  app: "web",
  via: "tg_webapp",
  proofAt: PROOF_AT,
  accountDisabledAt: null,
  accountDeletedAt: null,
  staffId: null,
  staffRole: null,
  staffActive: null,
  staffAccountId: null,
  clientId: null,
  clientBlocked: null,
  clientDeleted: null,
  ...patch,
});

const clientSession = (patch: Partial<SessionRow> = {}): SessionRow =>
  accountSession({ clientId: CLIENT_ID, clientBlocked: false, clientDeleted: false, ...patch });

const staffSession = (patch: Partial<SessionRow> = {}): SessionRow =>
  accountSession({
    app: "admin",
    via: "staff_elevation",
    staffId: STAFF_ID,
    staffRole: "moderator",
    staffActive: true,
    staffAccountId: ACCOUNT_ID,
    ...patch,
  });

const membership = (id: string, vendorId: string, disabled = false, role = "owner"): MembershipRow => ({
  id,
  vendor_id: vendorId,
  role,
  disabled_at: disabled ? new Date() : null,
});

// База отдаёт строку сессии на запрос к app.sessions, членства — на запрос к app.vendor_users
function dbWith(row: SessionRow | null, memberships: MembershipRow[] = []): FakeDb {
  return fakeDb((q: RecordedQuery) => {
    if (q.sql.includes('from "app"."sessions"')) return row ? [row] : [];
    if (q.sql.includes('from "app"."vendor_users"')) return memberships;
    return [];
  });
}

function appWith(fake: FakeDb) {
  const app = new Hono<AppEnv>();
  app.use(async (c, next) => {
    c.set("db", fake.db);
    await next();
  });
  app.use(authenticate);
  app.get("/whoami", (c) =>
    c.json({ actor: c.var.actor, sessionId: c.var.sessionId, kind: c.var.session?.kind }),
  );
  app.get("/private", (c) => c.json(requireClient(c)));
  app.get("/own-data", (c) => c.json(requireClient(c, { allowBlocked: true })));
  app.get("/account", (c) => c.json(accountOf(c)));
  app.post("/logout", (c) => c.json({ sessionId: requireSession(c).session.id }));
  app.get("/staff", requireStaff(), (c) => c.json(staffOf(c)));
  app.get("/staff/admin", requireStaff("admin"), (c) => c.json(staffOf(c)));
  app.get("/staff/content", requireStaff("admin", "moderator"), (c) => c.json(staffOf(c)));
  app.get("/unguarded", (c) => c.json(staffOf(c)));
  app.get("/vendor", requireVendor, (c) => c.json(vendorOf(c)));
  app.get("/vendor/unguarded", (c) => c.json(vendorOf(c)));
  app.onError(handleError);
  return app;
}

const bearer = (token: string, extra: Record<string, string> = {}) => ({
  headers: { Authorization: `Bearer ${token}`, ...extra },
});

async function get(
  row: SessionRow | null,
  path: string,
  memberships: MembershipRow[] = [],
  headers: Record<string, string> = {},
) {
  return appWith(dbWith(row, memberships)).request(path, bearer(generateToken(), headers));
}

afterEach(() => vi.restoreAllMocks());

describe("authenticate", () => {
  it("без заголовка — гость, в базу не ходит", async () => {
    const fake = dbWith(null);
    const res = await appWith(fake).request("/whoami");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ actor: { kind: "guest" }, sessionId: null });
    expect(fake.queries).toEqual([]);
  });

  it("кривой заголовок — 401 без запроса к базе", async () => {
    const fake = dbWith(null);
    for (const header of ["Basic abc", "Bearer short", `Bearer ${generateToken()}!`]) {
      const res = await appWith(fake).request("/whoami", { headers: { Authorization: header } });
      expect(res.status, header).toBe(401);
      expect(await res.json()).toEqual({
        error: { code: "unauthorized", message: "Authentication required" },
      });
    }
    expect(fake.queries).toEqual([]);
  });

  it("ищет сессию под system и по хэшу токена, а не по самому токену", async () => {
    const fake = dbWith(null);
    const token = generateToken();
    const res = await appWith(fake).request("/whoami", bearer(token));
    expect(res.status).toBe(401);

    const [settings, lookup] = fake.queries;
    expect(settings?.parameters).toEqual(["system", "", ""]);
    expect(lookup?.sql).toContain('"s"."revoked_at" is null');
    expect(lookup?.sql).toContain('"s"."expires_at" > now()');
    expect(lookup?.parameters).toContainEqual(await hashToken(token));
    expect(JSON.stringify(lookup?.parameters)).not.toContain(token);
  });

  it("сессия аккаунта — актор account, роль выводит маршрут", async () => {
    const res = await get(clientSession(), "/whoami");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      actor: { kind: "account", id: ACCOUNT_ID },
      sessionId: SESSION_ID,
      kind: "account",
    });
  });

  it("аккаунт отключён или удалён — 401", async () => {
    expect((await get(clientSession({ accountDisabledAt: new Date() }), "/whoami")).status).toBe(401);
    expect((await get(clientSession({ accountDeletedAt: new Date() }), "/whoami")).status).toBe(401);
  });

  it("сессия сотрудника — актор staff с ролью", async () => {
    const res = await get(staffSession({ staffRole: "manager" }), "/whoami");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      actor: { kind: "staff", id: STAFF_ID, role: "manager" },
      sessionId: SESSION_ID,
      kind: "staff",
    });
  });

  it("сотрудник отключён — его сессия 401", async () => {
    expect((await get(staffSession({ staffActive: false }), "/whoami")).status).toBe(401);
  });

  it("роль сотрудника чужого аккаунта (сотрудника отвязали) — 401", async () => {
    expect((await get(staffSession({ staffAccountId: OTHER_ACCOUNT }), "/whoami")).status).toBe(401);
    expect((await get(staffSession({ staffAccountId: null }), "/whoami")).status).toBe(401);
  });
});

describe("requireClient", () => {
  it("гостю — 401", async () => {
    const res = await appWith(dbWith(null)).request("/private");
    expect(res.status).toBe(401);
  });

  it("аккаунту с ролью клиента — актор клиента и сессия", async () => {
    const res = await get(clientSession(), "/private");
    expect(await res.json()).toEqual({ actor: { kind: "client", id: CLIENT_ID }, sessionId: SESSION_ID });
  });

  it("клиент заблокирован — 403 client_blocked", async () => {
    const res = await get(clientSession({ clientBlocked: true }), "/private");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "client_blocked", message: "Account is blocked" } });
  });

  it("allowBlocked (права на свои данные) — заблокированному тоже актор клиента", async () => {
    const res = await get(clientSession({ clientBlocked: true }), "/own-data");
    expect(await res.json()).toEqual({ actor: { kind: "client", id: CLIENT_ID }, sessionId: SESSION_ID });
  });

  it("аккаунт без роли клиента или с удалённой — 403", async () => {
    expect((await get(accountSession(), "/private")).status).toBe(403);
    expect((await get(clientSession({ clientDeleted: true }), "/private")).status).toBe(403);
  });

  it("сессии сотрудника — 403, даже если у аккаунта есть клиент", async () => {
    const res = await get(
      staffSession({ clientId: CLIENT_ID, clientBlocked: false, clientDeleted: false }),
      "/private",
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "forbidden", message: "Access denied" } });
  });
});

describe("requireSession и accountOf", () => {
  it("гостю — 401; сессии аккаунта и сотрудника — их сессия", async () => {
    expect((await appWith(dbWith(null)).request("/logout", { method: "POST" })).status).toBe(401);
    for (const row of [clientSession(), staffSession()]) {
      const res = await appWith(dbWith(row)).request("/logout", {
        method: "POST",
        ...bearer(generateToken()),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { sessionId: string }).sessionId).toBe(SESSION_ID);
    }
  });

  it("свой аккаунт — и из сессии сотрудника", async () => {
    expect(await (await get(staffSession(), "/account")).json()).toEqual({ kind: "account", id: ACCOUNT_ID });
    expect(await (await get(clientSession(), "/account")).json()).toEqual({
      kind: "account",
      id: ACCOUNT_ID,
    });
  });
});

describe("requireStaff", () => {
  it("гостю — 401, сессии аккаунта — 403", async () => {
    const guest = await appWith(dbWith(null)).request("/staff");
    expect(guest.status).toBe(401);
    const client = await get(clientSession(), "/staff");
    expect(client.status).toBe(403);
    expect(await client.json()).toEqual({ error: { code: "forbidden", message: "Access denied" } });
  });

  it("без ролей — любой действующий сотрудник", async () => {
    for (const role of ["admin", "manager", "moderator"] as const) {
      const res = await get(staffSession({ staffRole: role }), "/staff");
      expect(res.status, role).toBe(200);
      expect(await res.json()).toEqual({ kind: "staff", id: STAFF_ID, role });
    }
  });

  it("с ролями — только перечисленные; роли не наследуются", async () => {
    expect((await get(staffSession({ staffRole: "admin" }), "/staff/admin")).status).toBe(200);
    expect((await get(staffSession({ staffRole: "manager" }), "/staff/admin")).status).toBe(403);
    expect((await get(staffSession({ staffRole: "moderator" }), "/staff/admin")).status).toBe(403);
    expect((await get(staffSession({ staffRole: "moderator" }), "/staff/content")).status).toBe(200);
    expect((await get(staffSession({ staffRole: "manager" }), "/staff/content")).status).toBe(403);
  });

  it("staffOf без сессии сотрудника — 401, а не чужой актор", async () => {
    expect((await get(clientSession(), "/unguarded")).status).toBe(401);
  });
});

describe("requireVendor", () => {
  it("гостю — 401, сессии сотрудника — 403", async () => {
    expect((await appWith(dbWith(null)).request("/vendor")).status).toBe(401);
    const res = await get(staffSession(), "/vendor", [membership(VENDOR_USER_ID, VENDOR_ID)]);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "forbidden", message: "Access denied" } });
  });

  it("аккаунт не партнёр — 403 vendor_not_linked; доступ отключён — 403 vendor_disabled", async () => {
    const none = await get(clientSession(), "/vendor", []);
    expect(none.status).toBe(403);
    expect(((await none.json()) as { error: { code: string } }).error.code).toBe("vendor_not_linked");
    const off = await get(clientSession(), "/vendor", [membership(VENDOR_USER_ID, VENDOR_ID, true)]);
    expect(((await off.json()) as { error: { code: string } }).error.code).toBe("vendor_disabled");
  });

  it("одно членство — его пользователь вендора; членства ищутся по аккаунту сессии", async () => {
    const fake = dbWith(accountSession({ app: "vendor" }), [membership(VENDOR_USER_ID, VENDOR_ID)]);
    const res = await appWith(fake).request("/vendor", bearer(generateToken()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      kind: "vendor_user",
      id: VENDOR_USER_ID,
      vendorId: VENDOR_ID,
      role: "owner",
    });
    const lookup = fake.queries.find((q) => q.sql.includes('from "app"."vendor_users"'));
    expect(lookup?.parameters).toContain(ACCOUNT_ID);
  });

  it("несколько вендоров: без заголовка — 409, с заголовком — выбранный, чужой — 403", async () => {
    const both = [membership(VENDOR_USER_ID, VENDOR_ID), membership(VENDOR_USER_B, VENDOR_B)];
    const choose = await get(accountSession(), "/vendor", both);
    expect(choose.status).toBe(409);
    expect(((await choose.json()) as { error: { code: string } }).error.code).toBe("vendor_choice_required");

    const b = await get(accountSession(), "/vendor", both, { "X-Bayramm-Vendor": VENDOR_B.toUpperCase() });
    expect(await b.json()).toEqual({
      kind: "vendor_user",
      id: VENDOR_USER_B,
      vendorId: VENDOR_B,
      role: "owner",
    });

    const foreign = await get(accountSession(), "/vendor", both, {
      "X-Bayramm-Vendor": "dddddddd-0000-0000-0000-000000000001",
    });
    expect(foreign.status).toBe(403);
    expect((await get(accountSession(), "/vendor", both, { "X-Bayramm-Vendor": "1 or 1=1" })).status).toBe(
      403,
    );
  });

  it("vendorOf без кабинета — 401, а не чужой актор", async () => {
    expect((await get(staffSession(), "/vendor/unguarded")).status).toBe(401);
  });
});

describe("chooseMembership", () => {
  it("отключённое членство не выбирается даже заголовком", () => {
    const list = [
      { vendorUserId: VENDOR_USER_ID, vendorId: VENDOR_ID, role: "owner" as const, disabled: true },
      { vendorUserId: VENDOR_USER_B, vendorId: VENDOR_B, role: "member" as const, disabled: false },
    ];
    expect(chooseMembership(list, undefined)).toEqual({
      kind: "vendor_user",
      id: VENDOR_USER_B,
      vendorId: VENDOR_B,
      role: "member",
    });
    expect(() => chooseMembership(list, VENDOR_ID)).toThrow(expect.objectContaining({ status: 403 }));
  });
});
