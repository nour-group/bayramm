import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../env";
import { handleError } from "../errors";
import { type FakeDb, fakeDb, type RecordedQuery } from "../testing/fake-db";
import { generateToken, hashToken } from "./crypto";
import { authenticate, requireClient } from "./session";

const SESSION_ID = "11111111-0000-0000-0000-000000000001";
const CLIENT_ID = "cccccccc-0000-0000-0000-000000000001";

interface SessionRow {
  sessionId: string;
  clientId: string;
  blocked_at: Date | null;
  deleted_at: Date | null;
}

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
  app.onError(handleError);
  return app;
}

const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

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

  it("живая сессия — актор client", async () => {
    const fake = dbWithSession({
      sessionId: SESSION_ID,
      clientId: CLIENT_ID,
      blocked_at: null,
      deleted_at: null,
    });
    const res = await appWith(fake).request("/whoami", bearer(generateToken()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ actor: { kind: "client", id: CLIENT_ID }, sessionId: SESSION_ID });
  });

  it("клиент заблокирован — 403 client_blocked", async () => {
    const fake = dbWithSession({
      sessionId: SESSION_ID,
      clientId: CLIENT_ID,
      blocked_at: new Date(),
      deleted_at: null,
    });
    const res = await appWith(fake).request("/whoami", bearer(generateToken()));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "client_blocked", message: "Account is blocked" } });
  });

  it("аккаунт удалён — 401", async () => {
    const fake = dbWithSession({
      sessionId: SESSION_ID,
      clientId: CLIENT_ID,
      blocked_at: null,
      deleted_at: new Date(),
    });
    const res = await appWith(fake).request("/whoami", bearer(generateToken()));
    expect(res.status).toBe(401);
  });
});

describe("requireClient", () => {
  it("гостю — 401", async () => {
    const res = await appWith(dbWithSession(null)).request("/private");
    expect(res.status).toBe(401);
  });

  it("клиенту — актор и сессия", async () => {
    const fake = dbWithSession({
      sessionId: SESSION_ID,
      clientId: CLIENT_ID,
      blocked_at: null,
      deleted_at: null,
    });
    const res = await appWith(fake).request("/private", bearer(generateToken()));
    expect(await res.json()).toEqual({ actor: { kind: "client", id: CLIENT_ID }, sessionId: SESSION_ID });
  });
});
