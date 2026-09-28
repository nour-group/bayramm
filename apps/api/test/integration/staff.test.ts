// Вход сотрудников через виджет Telegram, сессии сотрудников и /staff на
// настоящем Postgres, ролью bayramm_api
import { createHash, randomInt } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signLoginWidget, type TestWidgetUser } from "../../src/testing/login-widget";
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
  tgIdHash,
} from "./helpers";

let admin: Client;

beforeAll(async () => {
  admin = await adminClient();
});

afterAll(async () => {
  await cleanupStaff(admin);
  await cleanup(admin);
  await admin.end();
});

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const TWELVE_HOURS_MS = 12 * 3600 * 1000;
const DENIED = { error: { code: "forbidden", message: "Access denied" } };

// Telegram ID — случайные на каждый прогон
function widgetUser(username?: string): TestWidgetUser {
  const user: TestWidgetUser = { id: 8_000_000_000 + randomInt(0, 999_999_999), first_name: "Staff" };
  if (username !== undefined) user.username = username;
  return user;
}

async function staffLogin(user: TestWidgetUser, authDate?: number): Promise<Response> {
  return postStaffLogin(await signLoginWidget(user, BOT_TOKEN, authDate));
}

async function staffToken(user: TestWidgetUser): Promise<string> {
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

describe("POST /auth/staff/telegram: приглашение по имени", () => {
  it("первый вход принимает приглашение, /staff/me отдаёт сотрудника", async () => {
    const username = newStaffUsername();
    const staffId = await inviteStaff(admin, { username, role: "moderator", displayName: "Test Moderator" });
    // Имя в Telegram может быть в другом регистре — приглашение хранится в нижнем
    const user = widgetUser(username.toUpperCase());

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

    // Сессия: via tg_staff, в базе только sha256 токена
    const { rows: sessions } = await admin.query<{ token_hash: Buffer; via: string }>(
      "select token_hash, via from app.sessions where staff_id = $1",
      [staffId],
    );
    expect(sessions).toEqual([
      { token_hash: createHash("sha256").update(body.token).digest(), via: "tg_staff" },
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
    const owner = widgetUser(username);
    await staffToken(owner);

    const intruder = widgetUser(username);
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
    const user = widgetUser(username);
    await staffToken(user);

    for (const renamed of [widgetUser(newStaffUsername()), widgetUser()]) {
      const token = await staffToken({ ...renamed, id: user.id });
      const me = (await (await call("/staff/me", bearer(token))).json()) as { id: string };
      expect(me.id).toBe(staffId);
    }
  });

  it("два человека одновременно принимают одно приглашение — выигрывает один", async () => {
    const username = newStaffUsername();
    const staffId = await inviteStaff(admin, { username });
    const [a, b] = [widgetUser(username), widgetUser(username)];
    const statuses = (await Promise.all([staffLogin(a), staffLogin(b)])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 403]);

    const bound = await binding(staffId);
    expect([tgIdHash(a.id), tgIdHash(b.id)]).toContainEqual(bound?.tg_id_hash);
  });

  it("два одновременных первых входа одного человека — одна привязка, входят оба", async () => {
    const username = newStaffUsername();
    const staffId = await inviteStaff(admin, { username });
    const user = widgetUser(username);
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
    const unknown = await staffLogin(widgetUser(newStaffUsername()));
    expect(unknown.status).toBe(403);
    expect(await unknown.json()).toEqual(DENIED);

    const username = newStaffUsername();
    const staffId = await inviteStaff(admin, { username, active: false });
    const disabled = await staffLogin(widgetUser(username));
    expect(disabled.status).toBe(403);
    expect(await disabled.json()).toEqual(DENIED);
    expect((await binding(staffId))?.tg_id_hash).toBeNull();

    const noName = await staffLogin(widgetUser());
    expect(noName.status).toBe(403);
    expect(await noName.json()).toEqual(DENIED);
  });

  it("отключённый сотрудник: вход — 403, его живые сессии — 401", async () => {
    const username = newStaffUsername();
    const staffId = await inviteStaff(admin, { username });
    const user = widgetUser(username);
    const token = await staffToken(user);
    expect((await call("/staff/me", bearer(token))).status).toBe(200);

    await admin.query("update app.staff set active = false where id = $1", [staffId]);
    const res = await staffLogin(user);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(DENIED);
    expect((await call("/staff/me", bearer(token))).status).toBe(401);
  });

  it("подпись чужого бота — 401, приглашение не принимается", async () => {
    const username = newStaffUsername();
    const staffId = await inviteStaff(admin, { username });
    const res = await postStaffLogin(await signLoginWidget(widgetUser(username), "999:someone-else"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "unauthorized", message: "Invalid Telegram login data" },
    });
    expect((await binding(staffId))?.tg_id_hash).toBeNull();
  });

  it("чужой id в подписанных данных — 401", async () => {
    const username = newStaffUsername();
    const staffId = await inviteStaff(admin, { username });
    const fields = await signLoginWidget(widgetUser(username), BOT_TOKEN);
    const res = await postStaffLogin({ ...fields, id: String(Number(fields.id) + 1) });
    expect(res.status).toBe(401);
    expect((await binding(staffId))?.tg_id_hash).toBeNull();
  });

  it("данные виджета старше 10 минут — 401", async () => {
    const username = newStaffUsername();
    const staffId = await inviteStaff(admin, { username });
    const elevenMinutesAgo = Math.floor(Date.now() / 1000) - 11 * 60;
    const res = await staffLogin(widgetUser(username), elevenMinutesAgo);
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
    const token = await staffToken(widgetUser(username));
    const res = await call("/me", bearer(token));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(DENIED);
  });

  it("без токена /staff/me — 401", async () => {
    expect((await call("/staff/me")).status).toBe(401);
    expect((await call("/staff/me", bearer("A".repeat(43)))).status).toBe(401);
  });

  it("просроченная сессия сотрудника — 401", async () => {
    const username = newStaffUsername();
    const staffId = await inviteStaff(admin, { username });
    const token = await staffToken(widgetUser(username));
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
    const user = widgetUser(username);
    const first = await staffToken(user);
    const second = await staffToken(user);

    expect((await call("/auth/logout", { method: "POST", ...bearer(first) })).status).toBe(204);
    expect((await call("/staff/me", bearer(first))).status).toBe(401);
    expect((await call("/staff/me", bearer(second))).status).toBe(200);
  });
});
