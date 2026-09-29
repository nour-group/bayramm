import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../env";
import { handleError } from "../errors";
import { type FakeDb, fakeDb, type RecordedQuery } from "../testing/fake-db";
import { generateToken, hashToken } from "./crypto";
import {
  authenticate,
  requireClient,
  requireSession,
  requireStaff,
  requireVendor,
  staffOf,
  vendorOf,
} from "./session";

const SESSION_ID = "11111111-0000-0000-0000-000000000001";
const CLIENT_ID = "cccccccc-0000-0000-0000-000000000001";
const STAFF_ID = "00000000-0000-0000-0000-00000000a001";
const VENDOR_USER_ID = "aaaaaaaa-0000-0000-0000-000000000011";
const VENDOR_ID = "aaaaaaaa-0000-0000-0000-000000000001";

interface SessionRow {
  sessionId: string;
  via: string;
  clientId: string | null;
  blocked_at: Date | null;
  deleted_at: Date | null;
  staffId: string | null;
  staffRole: "admin" | "manager" | "moderator" | null;
  staffActive: boolean | null;
  vendorUserId: string | null;
  vendorId: string | null;
  vendorDisabledAt: Date | null;
  vendorLinked: boolean | null;
}

const noSubject: SessionRow = {
  sessionId: SESSION_ID,
  via: "tg_client",
  clientId: null,
  blocked_at: null,
  deleted_at: null,
  staffId: null,
  staffRole: null,
  staffActive: null,
  vendorUserId: null,
  vendorId: null,
  vendorDisabledAt: null,
  vendorLinked: null,
};

const clientSession = (patch: Partial<SessionRow> = {}): SessionRow => ({
  ...noSubject,
  clientId: CLIENT_ID,
  ...patch,
});

const staffSession = (patch: Partial<SessionRow> = {}): SessionRow => ({
  ...noSubject,
  via: "tg_staff",
  staffId: STAFF_ID,
  staffRole: "moderator",
  staffActive: true,
  ...patch,
});

const vendorSession = (patch: Partial<SessionRow> = {}): SessionRow => ({
  ...noSubject,
  via: "tg_partner",
  vendorUserId: VENDOR_USER_ID,
  vendorId: VENDOR_ID,
  vendorLinked: true,
  ...patch,
});

// База отдаёт строку сессии на запрос к app.sessions, на остальное — пусто
function dbWithSession(row: SessionRow | null): FakeDb {
  return fakeDb((q: RecordedQuery) => (q.sql.includes('from "app"."sessions"') && row ? [row] : []));
}

function appWith(fake: FakeDb) {
  const app = new Hono<AppEnv>();
  app.use(async (c, next) => {
    c.set("db", fake.db);
    await next();
  });
  app.use(authenticate);
  app.get("/whoami", (c) => c.json({ actor: c.var.actor, sessionId: c.var.sessionId }));
  app.get("/private", (c) => c.json(requireClient(c)));
  app.post("/logout", (c) => c.json(requireSession(c)));
  app.get("/staff", requireStaff(), (c) => c.json(staffOf(c)));
  app.get("/staff/admin", requireStaff("admin"), (c) => c.json(staffOf(c)));
  app.get("/staff/content", requireStaff("admin", "moderator"), (c) => c.json(staffOf(c)));
  app.get("/unguarded", (c) => c.json(staffOf(c)));
  app.get("/vendor", requireVendor, (c) => c.json(vendorOf(c)));
  app.get("/vendor/unguarded", (c) => c.json(vendorOf(c)));
  app.onError(handleError);
  return app;
}

const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

async function get(row: SessionRow | null, path: string) {
  return appWith(dbWithSession(row)).request(path, bearer(generateToken()));
}

afterEach(() => vi.restoreAllMocks());

describe("authenticate", () => {
  it("без заголовка — гость, в базу не ходит", async () => {
    const fake = dbWithSession(null);
    const res = await appWith(fake).request("/whoami");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ actor: { kind: "guest" }, sessionId: null });
    expect(fake.queries).toEqual([]);
  });

  it("кривой заголовок — 401 без запроса к базе", async () => {
    const fake = dbWithSession(null);
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
    const fake = dbWithSession(null);
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

  it("живая сессия клиента — актор client", async () => {
    const res = await get(clientSession(), "/whoami");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ actor: { kind: "client", id: CLIENT_ID }, sessionId: SESSION_ID });
  });

  it("клиент заблокирован — 403 client_blocked", async () => {
    const res = await get(clientSession({ blocked_at: new Date() }), "/whoami");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "client_blocked", message: "Account is blocked" } });
  });

  it("аккаунт удалён — 401", async () => {
    expect((await get(clientSession({ deleted_at: new Date() }), "/whoami")).status).toBe(401);
  });

  it("живая сессия сотрудника — актор staff с ролью", async () => {
    const res = await get(staffSession({ staffRole: "manager" }), "/whoami");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      actor: { kind: "staff", id: STAFF_ID, role: "manager" },
      sessionId: SESSION_ID,
    });
  });

  it("сотрудник отключён — его сессия 401", async () => {
    expect((await get(staffSession({ staffActive: false }), "/whoami")).status).toBe(401);
  });

  it("живая сессия кабинета — актор vendor_user с вендором", async () => {
    const res = await get(vendorSession(), "/whoami");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      actor: { kind: "vendor_user", id: VENDOR_USER_ID, vendorId: VENDOR_ID },
      sessionId: SESSION_ID,
    });
  });

  it("пользователь вендора отключён — его сессия 401", async () => {
    expect((await get(vendorSession({ vendorDisabledAt: new Date() }), "/whoami")).status).toBe(401);
  });

  it("вход был по Telegram, а привязку сняли — 401", async () => {
    expect((await get(vendorSession({ vendorLinked: false }), "/whoami")).status).toBe(401);
  });

  it("сессия без субъекта — 401", async () => {
    expect((await get(noSubject, "/whoami")).status).toBe(401);
  });
});

describe("requireClient", () => {
  it("гостю — 401", async () => {
    const res = await appWith(dbWithSession(null)).request("/private");
    expect(res.status).toBe(401);
  });

  it("клиенту — актор и сессия", async () => {
    const res = await get(clientSession(), "/private");
    expect(await res.json()).toEqual({ actor: { kind: "client", id: CLIENT_ID }, sessionId: SESSION_ID });
  });

  it("сотруднику — 403", async () => {
    const res = await get(staffSession(), "/private");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "forbidden", message: "Access denied" } });
  });
});

describe("requireSession", () => {
  it("гостю — 401; клиенту, сотруднику и вендору — их сессия", async () => {
    expect((await appWith(dbWithSession(null)).request("/logout", { method: "POST" })).status).toBe(401);
    for (const row of [clientSession(), staffSession(), vendorSession()]) {
      const res = await appWith(dbWithSession(row)).request("/logout", {
        method: "POST",
        ...bearer(generateToken()),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { sessionId: string }).sessionId).toBe(SESSION_ID);
    }
  });
});

describe("requireStaff", () => {
  it("гостю — 401, клиенту — 403", async () => {
    const guest = await appWith(dbWithSession(null)).request("/staff");
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
  it("гостю — 401, клиенту и сотруднику — 403", async () => {
    expect((await appWith(dbWithSession(null)).request("/vendor")).status).toBe(401);
    for (const row of [clientSession(), staffSession()]) {
      const res = await get(row, "/vendor");
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: { code: "forbidden", message: "Access denied" } });
    }
  });

  it("пользователю вендора — его актор", async () => {
    const res = await get(vendorSession(), "/vendor");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: "vendor_user", id: VENDOR_USER_ID, vendorId: VENDOR_ID });
  });

  it("vendorOf без сессии кабинета — 401, а не чужой актор", async () => {
    expect((await get(staffSession(), "/vendor/unguarded")).status).toBe(401);
  });
});
