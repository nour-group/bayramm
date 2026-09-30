// Вход сотрудников (панель как Mini App: initData из кнопки бота), сессии сотрудников и
// /staff на настоящем Postgres, ролью bayramm_api. Хаб входа с повышением сессии —
// accounts.test.ts; устаревший виджет на домене панели — один тест в конце
import { createHash } from "node:crypto";
import type { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initDataFor, type TestTelegramUser } from "../../src/testing/init-data";
import { signLoginWidget } from "../../src/testing/login-widget";
import {
  adminClient,
  BOT_TOKEN,
  bearer,
  call,
  cleanup,
  cleanupStaff,
  inviteStaff,
  loginToken,
  newStaffUsername,
  newTelegramUser,
  postStaffLogin,
  staffTelegramUser,
  tgIdHash,
} from "./helpers";

let admin: Client;

beforeAll(async () => {
  admin = await adminClient();
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await cleanupStaff(admin);
  await cleanup(admin);
  await admin.end();
});

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const TWELVE_HOURS_MS = 12 * 3600 * 1000;
const DENIED = { error: { code: "forbidden", message: "Access denied" } };

async function staffLogin(user: TestTelegramUser, authDate?: number): Promise<Response> {
  return postStaffLogin(await initDataFor(user, { botToken: BOT_TOKEN, authDate }));
}

async function staffToken(user: TestTelegramUser): Promise<string> {
  const res = await staffLogin(user);
  if (res.status !== 200) throw new Error(`вход сотрудника не удался: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { token: string }).token;
}

async function binding(staffId: string) {
  const { rows } = await admin.query<{ tg_id_hash: Buffer | null; telegram_id: string | null }>(
    `select s.tg_id_hash, p.telegram_id from app.staff s join pii.staff_profiles p on p.staff_id = s.id
     where s.id = $1`,
    [staffId],
  );
  return rows[0];
}

describe("POST /auth/staff/webapp: приглашение по имени", () => {
  it("первый вход принимает приглашение, /staff/me отдаёт сотрудника", async () => {
    const username = newStaffUsername();
    const staffId = await inviteStaff(admin, { username, role: "moderator", displayName: "Test Moderator" });
    // Имя в Telegram может быть в другом регистре — приглашение хранится в нижнем
    const user = staffTelegramUser(username.toUpperCase());

    const res = await staffLogin(user);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expiresAt: string };
    expect(body.token).toMatch(TOKEN_RE);
    const ttl = Date.parse(body.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(TWELVE_HOURS_MS - 60_000);
    expect(ttl).toBeLessThanOrEqual(TWELVE_HOURS_MS);

    const me = await call("/staff/me", bearer(body.token));
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      id: staffId,
      role: "moderator",
      displayName: "Test Moderator",
      username,
      // Права роли — для панели; проверяет их сервер на каждом запросе
      permissions: expect.arrayContaining(["catalog.read", "listings.publish"]),
    });

    // Привязка: в app — только HMAC, Telegram ID — в pii
    const bound = await binding(staffId);
    expect(bound?.tg_id_hash).toEqual(tgIdHash(user.id));
    expect(bound?.telegram_id).toBe(String(user.id));
    const { rows: staffRows } = await admin.query<{ row: string }>(
      "select to_jsonb(s)::text as row from app.staff s where id = $1",
      [staffId],
    );
    expect(staffRows[0]?.row).not.toContain(String(user.id));

    // Сессия сотрудника по свежему доказательству, в базе только sha256 токена
    const { rows: sessions } = await admin.query<{ token_hash: Buffer; via: string; app: string }>(
      "select token_hash, via, app from app.sessions where staff_id = $1",
      [staffId],
    );
    expect(sessions).toEqual([
      { token_hash: createHash("sha256").update(body.token).digest(), via: "staff_elevation", app: "admin" },
    ]);

    // Привязка — в журнале, без имени и Telegram ID
    const { rows: audit } = await admin.query<{ actor_kind: string; detail: unknown; row: string }>(
      `select actor_kind, detail, to_jsonb(a)::text as row from app.audit_log a
       where action = 'staff.telegram_claim' and object_id = $1`,
      [staffId],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor_kind).toBe("system");
    expect(audit[0]?.detail).toEqual({ role: "moderator" });
    expect(audit[0]?.row).not.toContain(String(user.id));
    expect(audit[0]?.row).not.toContain(username);
  });

  it("принятое приглашение: другой аккаунт с тем же именем — 403, привязка не меняется", async () => {
    const username = newStaffUsername();
    const staffId = await inviteStaff(admin, { username });
    const owner = staffTelegramUser(username);
    await staffToken(owner);

    const intruder = staffTelegramUser(username);
    const res = await staffLogin(intruder);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(DENIED);

    expect((await binding(staffId))?.tg_id_hash).toEqual(tgIdHash(owner.id));
    const { rows } = await admin.query("select 1 from app.sessions where staff_id = $1", [staffId]);
    expect(rows).toHaveLength(1);
  });

  it("привязанный сотрудник входит по id и после смены имени, и без имени", async () => {
    const username = newStaffUsername();
    const staffId = await inviteStaff(admin, { username });
    const user = staffTelegramUser(username);
    await staffToken(user);

    for (const renamed of [staffTelegramUser(newStaffUsername()), staffTelegramUser()]) {
      const token = await staffToken({ ...renamed, id: user.id });
      const me = (await (await call("/staff/me", bearer(token))).json()) as { id: string };
      expect(me.id).toBe(staffId);
    }
  });

  it("два человека одновременно принимают одно приглашение — выигрывает один", async () => {
    const username = newStaffUsername();
    const staffId = await inviteStaff(admin, { username });
    const [a, b] = [staffTelegramUser(username), staffTelegramUser(username)];
    const statuses = (await Promise.all([staffLogin(a), staffLogin(b)])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 403]);

    const bound = await binding(staffId);
    expect([tgIdHash(a.id), tgIdHash(b.id)]).toContainEqual(bound?.tg_id_hash);
  });

  it("два одновременных первых входа одного человека — одна привязка, входят оба", async () => {
    const username = newStaffUsername();
    const staffId = await inviteStaff(admin, { username });
    const user = staffTelegramUser(username);
    const statuses = (await Promise.all([staffLogin(user), staffLogin(user)])).map((r) => r.status);
    expect(statuses).toEqual([200, 200]);
    const { rows } = await admin.query(
      "select 1 from app.audit_log where action = 'staff.telegram_claim' and object_id = $1",
      [staffId],
    );
    expect(rows).toHaveLength(1);
  });
});

describe("отказы во входе сотрудника", () => {
  it("неизвестное имя, отключённое приглашение — тот же 403", async () => {
    const unknown = await staffLogin(staffTelegramUser(newStaffUsername()));
    expect(unknown.status).toBe(403);
    expect(await unknown.json()).toEqual(DENIED);

    const username = newStaffUsername();
    const staffId = await inviteStaff(admin, { username, active: false });
    const disabled = await staffLogin(staffTelegramUser(username));
    expect(disabled.status).toBe(403);
    expect(await disabled.json()).toEqual(DENIED);
    expect((await binding(staffId))?.tg_id_hash).toBeNull();

    const noName = await staffLogin(staffTelegramUser());
    expect(noName.status).toBe(403);
    expect(await noName.json()).toEqual(DENIED);
  });

  it("отключённый сотрудник: вход — 403, его живые сессии — 401", async () => {
    const username = newStaffUsername();
    const staffId = await inviteStaff(admin, { username });
    const user = staffTelegramUser(username);
    const token = await staffToken(user);
    expect((await call("/staff/me", bearer(token))).status).toBe(200);

    await admin.query("update app.staff set active = false where id = $1", [staffId]);
    const res = await staffLogin(user);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(DENIED);
    expect((await call("/staff/me", bearer(token))).status).toBe(401);
  });

  it("подпись чужого бота — 401, приглашение не принимается", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const username = newStaffUsername();
    const staffId = await inviteStaff(admin, { username });
    const res = await postStaffLogin(
      await initDataFor(staffTelegramUser(username), { botToken: "999:someone-else" }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "unauthorized", message: "Invalid Telegram init data" },
    });
    expect((await binding(staffId))?.tg_id_hash).toBeNull();
  });

  it("чужой id в подписанных данных — 401", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const username = newStaffUsername();
    const staffId = await inviteStaff(admin, { username });
    const user = staffTelegramUser(username);
    const params = new URLSearchParams(await initDataFor(user, { botToken: BOT_TOKEN }));
    params.set("user", JSON.stringify({ ...user, id: user.id + 1 }));
    const res = await postStaffLogin(params.toString());
    expect(res.status).toBe(401);
    expect((await binding(staffId))?.tg_id_hash).toBeNull();
  });

  it("initData старше часа — 401", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const username = newStaffUsername();
    const staffId = await inviteStaff(admin, { username });
    const overAnHourAgo = Math.floor(Date.now() / 1000) - 61 * 60;
    const res = await staffLogin(staffTelegramUser(username), overAnHourAgo);
    expect(res.status).toBe(401);
    expect((await binding(staffId))?.tg_id_hash).toBeNull();
  });
});

describe("сессии сотрудников и границы маршрутов", () => {
  it("клиентская сессия не открывает панель оператора — 403", async () => {
    const clientToken = await loginToken(newTelegramUser());
    const res = await call("/staff/me", bearer(clientToken));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(DENIED);
  });

  it("сессия сотрудника не открывает клиентские маршруты — 403", async () => {
    const username = newStaffUsername();
    await inviteStaff(admin, { username });
    const token = await staffToken(staffTelegramUser(username));
    const res = await call("/requests", bearer(token));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(DENIED);
    // свой аккаунт и роли — видит: так панель узнаёт, есть ли у него кабинет партнёра
    const me = await call("/me", bearer(token));
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      roles: { staff: { role: "moderator" } },
      session: { kind: "staff" },
    });
  });

  it("без токена /staff/me — 401", async () => {
    expect((await call("/staff/me")).status).toBe(401);
    expect((await call("/staff/me", bearer("A".repeat(43)))).status).toBe(401);
  });

  it("просроченная сессия сотрудника — 401", async () => {
    const username = newStaffUsername();
    const staffId = await inviteStaff(admin, { username });
    const token = await staffToken(staffTelegramUser(username));
    await admin.query(
      `update app.sessions set created_at = now() - interval '13 hours', expires_at = now() - interval '1 hour'
       where staff_id = $1`,
      [staffId],
    );
    expect((await call("/staff/me", bearer(token))).status).toBe(401);
  });

  it("выход сотрудника отзывает только его сессию", async () => {
    const username = newStaffUsername();
    await inviteStaff(admin, { username });
    const user = staffTelegramUser(username);
    const first = await staffToken(user);
    const second = await staffToken(user);

    expect((await call("/auth/logout", { method: "POST", ...bearer(first) })).status).toBe(204);
    expect((await call("/staff/me", bearer(first))).status).toBe(401);
    expect((await call("/staff/me", bearer(second))).status).toBe(200);
  });
});

describe("устаревший вход панели виджетом Telegram", () => {
  it("POST /auth/staff/telegram для старых сборок работает так же и пишет в лог", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const username = newStaffUsername();
    const staffId = await inviteStaff(admin, { username, role: "manager" });
    const user = staffTelegramUser(username);
    const res = await call("/auth/staff/telegram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(await signLoginWidget(user, BOT_TOKEN)),
    });
    expect(res.status).toBe(200);
    const token = ((await res.json()) as { token: string }).token;
    const me = (await (await call("/staff/me", bearer(token))).json()) as { id: string; role: string };
    expect(me).toMatchObject({ id: staffId, role: "manager" });
    expect((await binding(staffId))?.tg_id_hash).toEqual(tgIdHash(user.id));
    expect(warn).toHaveBeenCalledWith("auth.legacy: deprecated endpoint used", {
      path: "/auth/staff/telegram",
    });
    warn.mockRestore();
  });
});
