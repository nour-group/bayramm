// Вход клиента, сессии и /me на настоящем Postgres, ролью bayramm_api
import { createHash } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initDataFields, initDataFor, signInitData } from "../../src/testing/init-data";
import {
  accountOfClient,
  adminClient,
  BOT_TOKEN,
  bearer,
  call,
  cleanup,
  loginToken,
  newTelegramUser,
  postLogin,
  tgIdHash,
} from "./helpers";

let admin: Client;

beforeAll(async () => {
  admin = await adminClient();
});

afterAll(async () => {
  await cleanup(admin);
  await admin.end();
});

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

interface Me {
  id: string | null;
  locale: string;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  canMessage: boolean;
  account: { id: string };
  roles: { client: { id: string; blocked: boolean } | null };
}

async function me(token: string): Promise<Me> {
  const res = await call("/me", bearer(token));
  expect(res.status).toBe(200);
  return (await res.json()) as Me;
}

/** Сессии аккаунта клиента */
async function sessionsOf(clientId: string | undefined) {
  const { rows } = await admin.query<{ id: string; revoked_at: Date | null }>(
    "select s.id, s.revoked_at from app.sessions s join app.clients c on c.account_id = s.account_id where c.id = $1",
    [clientId],
  );
  return rows;
}

async function clientIdOf(telegramId: number): Promise<string | undefined> {
  const { rows } = await admin.query<{ id: string }>("select id from app.clients where tg_id_hash = $1", [
    tgIdHash(telegramId),
  ]);
  return rows[0]?.id;
}

describe("/health", () => {
  it("видит базу ролью API", async () => {
    const res = await call("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, db: "ok" });
  });
});

describe("POST /auth/telegram → GET /me", () => {
  it("валидная initData даёт сессию, по ней /me отдаёт свой профиль", async () => {
    const user = newTelegramUser({
      first_name: "Азиз",
      last_name: "Тестов",
      username: "aziz_test",
      language_code: "ru",
      allows_write_to_pm: true,
    });
    const res = await postLogin(await initDataFor(user, { botToken: BOT_TOKEN }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expiresAt: string };
    expect(body.token).toMatch(TOKEN_RE);
    const ttl = Date.parse(body.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(7 * 24 * 3600 * 1000 - 60_000);
    expect(ttl).toBeLessThanOrEqual(7 * 24 * 3600 * 1000);

    const clientId = await clientIdOf(user.id);
    const profile = await me(body.token);
    expect(profile).toMatchObject({
      id: clientId,
      locale: "ru",
      firstName: "Азиз",
      lastName: "Тестов",
      username: "aziz_test",
      canMessage: true,
      notifications: false,
      account: { id: await accountOfClient(admin, clientId ?? "") },
      identities: [{ kind: "telegram" }],
      roles: {
        client: { id: clientId, locale: "ru", canMessage: true, blocked: false },
        vendors: [],
        staff: null,
      },
      session: { kind: "account", app: "web" },
    });
  });

  it("в базе — только sha256 токена; в app нет Telegram ID, только HMAC", async () => {
    const user = newTelegramUser({ first_name: "Hash" });
    const token = await loginToken(user);
    const clientId = await clientIdOf(user.id);
    expect(clientId).toBeDefined();

    const sessions = await admin.query<{ token_hash: Buffer; via: string; app: string; row: string }>(
      `select s.token_hash, s.via, s.app, to_jsonb(s)::text as row
       from app.sessions s join app.clients c on c.account_id = s.account_id where c.id = $1`,
      [clientId],
    );
    expect(sessions.rows).toHaveLength(1);
    const [session] = sessions.rows;
    expect(session?.token_hash).toEqual(createHash("sha256").update(token).digest());
    expect(session?.via).toBe("tg_webapp");
    expect(session?.app).toBe("web");
    expect(session?.row).not.toContain(token);
    expect(session?.row).not.toContain(Buffer.from(token).toString("hex"));

    const client = await admin.query<{ tg_id_hash: Buffer; row: string }>(
      "select tg_id_hash, to_jsonb(c)::text as row from app.clients c where id = $1",
      [clientId],
    );
    expect(client.rows[0]?.tg_id_hash).toEqual(tgIdHash(user.id));
    expect(client.rows[0]?.row).not.toContain(String(user.id));

    const profile = await admin.query<{ telegram_id: string }>(
      "select telegram_id from pii.client_profiles where client_id = $1",
      [clientId],
    );
    expect(profile.rows[0]?.telegram_id).toBe(String(user.id));
  });

  it("повторный вход — тот же клиент: имя обновляется, выбранный язык — нет", async () => {
    const user = newTelegramUser({ first_name: "Old", language_code: "uz" });
    const first = await me(await loginToken(user));
    const second = await me(
      await loginToken({ ...user, first_name: "New", username: "renamed_user", language_code: "ru" }),
    );
    expect(second.id).toBe(first.id);
    expect(second.firstName).toBe("New");
    expect(second.username).toBe("renamed_user");
    expect(second.locale).toBe("uz");
    expect(await sessionsOf(first.id ?? undefined)).toHaveLength(2);
  });

  it("язык не ru/uz — умолчание базы; писать боту без разрешения нельзя", async () => {
    const profile = await me(await loginToken(newTelegramUser({ language_code: "en" })));
    expect(profile.locale).toBe("uz");
    expect(profile.canMessage).toBe(false);
  });

  it("разрешение писать боту вход только включает, но не снимает", async () => {
    const user = newTelegramUser();
    expect((await me(await loginToken(user))).canMessage).toBe(false);
    expect((await me(await loginToken({ ...user, allows_write_to_pm: true }))).canMessage).toBe(true);
    expect((await me(await loginToken({ ...user, allows_write_to_pm: false }))).canMessage).toBe(true);
  });

  it("два первых входа одновременно — один клиент", async () => {
    const user = newTelegramUser();
    const [x, y] = await Promise.all([loginToken(user), loginToken(user)]);
    expect((await me(x)).id).toBe((await me(y)).id);
  });

  it("после удаления аккаунта старая сессия не работает, новый вход возвращает аккаунт", async () => {
    const user = newTelegramUser({ first_name: "Before" });
    const oldToken = await loginToken(user);
    const clientId = await clientIdOf(user.id);
    const accountId = await accountOfClient(admin, clientId ?? "");
    expect((await call("/me", { method: "DELETE", ...bearer(oldToken) })).status).toBe(204);
    expect((await call("/me", bearer(oldToken))).status).toBe(401);
    const { rows } = await admin.query("select 1 from pii.account_profiles where account_id = $1", [
      accountId,
    ]);
    expect(rows).toHaveLength(0);

    const profile = await me(await loginToken({ ...user, first_name: "After" }));
    expect(profile.id).toBe(clientId);
    expect(profile.account.id).toBe(accountId);
    expect(profile.firstName).toBe("After");
  });
});

describe("отказы во входе", () => {
  it("подпись чужого бота — 401, клиент не создаётся", async () => {
    const user = newTelegramUser();
    const res = await postLogin(await initDataFor(user, { botToken: "999:someone-else" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "unauthorized", message: "Invalid Telegram init data" },
    });
    expect(await clientIdOf(user.id)).toBeUndefined();
  });

  it("чужой id в подписанных данных — 401", async () => {
    const victim = newTelegramUser();
    const attacker = newTelegramUser();
    const signed = await initDataFor(attacker, { botToken: BOT_TOKEN });
    const forged = signed.replace(
      encodeURIComponent(`"id":${attacker.id}`),
      encodeURIComponent(`"id":${victim.id}`),
    );
    expect(forged).not.toBe(signed);
    expect((await postLogin(forged)).status).toBe(401);
    expect(await clientIdOf(victim.id)).toBeUndefined();
  });

  it("устаревшая initData — 401", async () => {
    const user = newTelegramUser();
    const twoHoursAgo = Math.floor(Date.now() / 1000) - 2 * 3600;
    const res = await postLogin(await signInitData(initDataFields(user, twoHoursAgo), BOT_TOKEN));
    expect(res.status).toBe(401);
    expect(await clientIdOf(user.id)).toBeUndefined();
  });

  it("заблокированный клиент — 403: новая сессия не создаётся, старая не работает", async () => {
    const user = newTelegramUser();
    const oldToken = await loginToken(user);
    const clientId = await clientIdOf(user.id);
    await admin.query("update app.clients set blocked_at = now(), blocked_reason = 'test' where id = $1", [
      clientId,
    ]);

    const res = await postLogin(
      await initDataFor({ ...user, first_name: "Changed" }, { botToken: BOT_TOKEN }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "client_blocked", message: "Account is blocked" } });

    // Транзакция входа откатилась: ни новой сессии, ни правок профиля
    expect(await sessionsOf(clientId)).toHaveLength(1);
    const profile = await admin.query<{ first_name: string }>(
      "select first_name from pii.client_profiles where client_id = $1",
      [clientId],
    );
    expect(profile.rows[0]?.first_name).toBe("Test");

    // Старая сессия — аккаунта: он видит, что заблокирован, но клиентские маршруты закрыты
    expect((await me(oldToken)).roles.client?.blocked).toBe(true);
    const requestsRes = await call("/requests", bearer(oldToken));
    expect(requestsRes.status).toBe(403);
    expect(((await requestsRes.json()) as { error: { code: string } }).error.code).toBe("client_blocked");
    // Права на свои данные остаются: выгрузка — да
    expect((await call("/me/export", bearer(oldToken))).status).toBe(200);
  });
});

describe("сессии", () => {
  it("POST /auth/logout отзывает сессию", async () => {
    const user = newTelegramUser();
    const token = await loginToken(user);
    const res = await call("/auth/logout", { method: "POST", ...bearer(token) });
    expect(res.status).toBe(204);

    expect((await call("/me", bearer(token))).status).toBe(401);
    expect((await call("/auth/logout", { method: "POST", ...bearer(token) })).status).toBe(401);
    const rows = await sessionsOf(await clientIdOf(user.id));
    expect(rows[0]?.revoked_at).toBeInstanceOf(Date);
  });

  it("выход не трогает другие сессии того же клиента", async () => {
    const user = newTelegramUser();
    const first = await loginToken(user);
    const second = await loginToken(user);
    expect((await call("/auth/logout", { method: "POST", ...bearer(first) })).status).toBe(204);
    expect((await call("/me", bearer(second))).status).toBe(200);
  });

  it("просроченная сессия — 401", async () => {
    const user = newTelegramUser();
    const token = await loginToken(user);
    await admin.query(
      `update app.sessions s set created_at = now() - interval '2 days', expires_at = now() - interval '1 day'
       from app.clients c where c.account_id = s.account_id and c.id = $1`,
      [await clientIdOf(user.id)],
    );
    expect((await call("/me", bearer(token))).status).toBe(401);
  });

  it("неизвестный или кривой токен — 401, без токена — 401", async () => {
    expect((await call("/me", bearer("A".repeat(43)))).status).toBe(401);
    expect((await call("/me", bearer("not-a-token"))).status).toBe(401);
    expect((await call("/me")).status).toBe(401);
  });
});
