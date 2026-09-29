// Один аккаунт, вход откуда угодно — на настоящем Postgres, ролью bayramm_api:
// хаб входа (виджет, код из сообщения), одноразовые коды хаба с PKCE, сессия
// сотрудника по свежему доказательству, роли только своего аккаунта, добавление
// способов входа, лимиты кодов из сообщения.

import { createHash, createHmac, randomBytes, randomInt, randomUUID } from "node:crypto";
import type { AccountMe, SessionToken } from "@bayramm/shared/api/account";
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
  deleteAccounts,
  ID_HASH_KEY,
  inviteStaff,
  newStaffUsername,
  newTelegramUser,
} from "./helpers";

let admin: Client;
const run = randomBytes(3).toString("hex");
const vendorIds: string[] = [];
const phoneAccounts: string[] = [];

beforeAll(async () => {
  admin = await adminClient();
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  try {
    const { rows } = await admin.query<{ id: string }>(
      "select distinct account_id as id from app.vendor_users where vendor_id = any($1::uuid[]) and account_id is not null",
      [vendorIds],
    );
    await deleteAccounts(admin, [...rows.map((r) => r.id), ...phoneAccounts]);
    await admin.query("delete from app.vendor_users where vendor_id = any($1::uuid[])", [vendorIds]);
    await admin.query("delete from app.vendor_accounts where id = any($1::uuid[])", [vendorIds]);
    await cleanupStaff(admin);
    await cleanup(admin);
  } finally {
    await admin.end();
  }
});

// ── помощники ───────────────────────────────────────────────────────────────

const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});
const withToken = (token: string, body?: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
});

async function ok<T>(res: Promise<Response> | Response): Promise<T> {
  const r = await res;
  if (r.status !== 200) throw new Error(`ожидался 200, пришёл ${r.status}: ${await r.text()}`);
  return (await r.json()) as T;
}

async function errorOf(res: Promise<Response> | Response): Promise<{ status: number; code: string }> {
  const r = await res;
  const body = (await r.json()) as { error?: { code?: string } };
  return { status: r.status, code: body.error?.code ?? "" };
}

async function me(token: string): Promise<AccountMe & { id: string | null }> {
  return ok(call("/me", bearer(token)));
}

/** Хаб: вход виджетом Telegram на сайте */
async function widgetSignIn(user: TestTelegramUser): Promise<string> {
  const fields = await signLoginWidget(
    { id: user.id, first_name: user.first_name, ...(user.username ? { username: user.username } : {}) },
    BOT_TOKEN,
  );
  return (await ok<SessionToken>(call("/auth/widget", json({ widget: fields, locale: "ru" })))).token;
}

/** Mini App клиента */
async function webAppSignIn(user: TestTelegramUser): Promise<string> {
  const initData = await initDataFor(user, { botToken: BOT_TOKEN });
  return (await ok<SessionToken>(call("/auth/telegram", json({ initData })))).token;
}

const randomPhone = () => `+99800${String(randomInt(0, 9_999_999)).padStart(7, "0")}`;
const phoneHash = (phone: string) => createHmac("sha256", ID_HASH_KEY).update(phone).digest();
const randomIp = () => `10.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(1, 254)}`;

/** Код из сообщения: провайдер console пишет его в лог — берём оттуда */
async function sendCode(phone: string, ip?: string): Promise<string> {
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const res = await call("/auth/phone/send", json({ phone }, ip ? { "CF-Connecting-IP": ip } : {}));
  expect(res.status).toBe(200);
  const entry = log.mock.calls.find((c) => c[0] === "auth.otp: code (console provider)");
  log.mockRestore();
  const code = (entry?.[1] as { code?: string } | undefined)?.code;
  if (!code) throw new Error("код не попал в лог");
  return code;
}

/** «Прошла минута»: следующий код на этот номер можно просить сразу */
async function minutePassed(phone: string): Promise<void> {
  await admin.query(
    `update app.otp_codes set created_at = created_at - interval '61 seconds',
                              expires_at = expires_at - interval '61 seconds'
     where phone_hash = $1`,
    [phoneHash(phone)],
  );
}

async function phoneSignIn(phone: string): Promise<string> {
  const code = await sendCode(phone);
  const session = await ok<SessionToken>(call("/auth/phone/verify", json({ phone, code })));
  return session.token;
}

async function createVendor(phone: string): Promise<{ vendorId: string; userId: string }> {
  const vendorId = randomUUID();
  const userId = randomUUID();
  vendorIds.push(vendorId);
  await admin.query("insert into app.vendor_accounts (id, name) values ($1, $2)", [vendorId, `Acc ${run}`]);
  await admin.query("insert into app.vendor_users (id, vendor_id, phone_hash) values ($1, $2, $3)", [
    userId,
    vendorId,
    phoneHash(phone),
  ]);
  await admin.query("insert into pii.vendor_user_profiles (vendor_user_id, phone) values ($1, $2)", [
    userId,
    phone,
  ]);
  return { vendorId, userId };
}

// PKCE как в браузере
const b64url = (buf: Buffer) => buf.toString("base64url");
function pkce() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));
  return { verifier, challenge, state };
}

const VENDOR_ORIGIN = "http://localhost:5174";
const ADMIN_ORIGIN = "http://localhost:5175";

async function hubCode(token: string, app: "vendor" | "admin", p = pkce()) {
  const res = await call(
    "/auth/hub/code",
    withToken(token, { app, state: p.state, codeChallenge: p.challenge }),
  );
  return { res, p };
}

function codeOf(redirectUrl: string): string {
  return new URL(redirectUrl).searchParams.get("code") ?? "";
}

function exchange(app: "vendor" | "admin", code: string, verifier: string, state: string, origin: string) {
  return call("/auth/hub/exchange", json({ app, code, codeVerifier: verifier, state }, { Origin: origin }));
}

// ════════════════════════════════════════════════════════════════════════════

describe("GET /auth/methods", () => {
  it("вход по телефону включён только с провайдером; адреса приложений — из окружения", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // До Telegram в тестах не достучаться: имени бота нет, остальное — есть
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));
    const body = await ok<{ phone: boolean; apps: Record<string, string>; telegram: { bot: string | null } }>(
      call("/auth/methods"),
    );
    expect(body).toEqual({
      telegram: { bot: null, loginDomain: null },
      phone: true,
      apps: { web: "http://localhost:5173", vendor: VENDOR_ORIGIN, admin: ADMIN_ORIGIN },
    });
  });
});

describe("один человек — один аккаунт", () => {
  it("Mini App и виджет на сайте одного Telegram — один аккаунт и один клиент", async () => {
    const user = newTelegramUser({ username: `u_${run}_a` });
    const fromApp = await me(await webAppSignIn(user));
    const fromSite = await me(await widgetSignIn(user));
    expect(fromSite.account.id).toBe(fromApp.account.id);
    expect(fromSite.id).toBe(fromApp.id);
    expect(fromSite.identities.map((i) => i.kind)).toEqual(["telegram"]);
  });

  it("вход по телефону привязывает пользователей вендоров с этим номером; кабинет открывается", async () => {
    const phone = randomPhone();
    const { vendorId, userId } = await createVendor(phone);
    const token = await phoneSignIn(phone);
    const account = await me(token);
    phoneAccounts.push(account.account.id);
    expect(account.identities.map((i) => i.kind)).toEqual(["phone"]);
    expect(account.roles.vendors).toEqual([
      { vendorUserId: userId, vendorId, code: expect.any(String), name: `Acc ${run}`, role: "owner" },
    ]);
    // клиентом он стал — вход был на сайте клиента
    expect(account.roles.client).not.toBeNull();
    const vendorMe = await call("/vendor/me", bearer(token));
    expect(vendorMe.status).toBe(200);
  });
});

describe("роли — только своего аккаунта", () => {
  it("A не открывает кабинет вендора B и не получает сессию сотрудника", async () => {
    const phoneB = randomPhone();
    const b = await createVendor(phoneB);
    const tokenB = await phoneSignIn(phoneB);
    phoneAccounts.push((await me(tokenB)).account.id);
    const tokenA = await widgetSignIn(newTelegramUser());

    // заголовок с чужим вендором — отказ; без заголовка — A не партнёр
    expect(await errorOf(call("/vendor/me", bearer(tokenA)))).toEqual({
      status: 403,
      code: "vendor_not_linked",
    });
    const forged = await call("/vendor/me", {
      headers: { Authorization: `Bearer ${tokenA}`, "X-Bayramm-Vendor": b.vendorId },
    });
    expect(forged.status).toBe(403);
    // у A нет роли сотрудника
    expect(await errorOf(call("/auth/staff/elevate", withToken(tokenA)))).toEqual({
      status: 403,
      code: "forbidden",
    });
    // сессия B своим вендором работает
    expect((await call("/vendor/me", bearer(tokenB))).status).toBe(200);
  });
});

describe("сессия сотрудника — только по свежему доказательству", () => {
  it("хаб: вход виджетом принимает приглашение, повышение даёт сессию сотрудника", async () => {
    const username = newStaffUsername();
    const staffId = await inviteStaff(admin, { username, role: "manager" });
    const token = await widgetSignIn(newTelegramUser({ username }));
    expect((await me(token)).roles.staff).toEqual({ role: "manager" });

    const staff = await ok<SessionToken>(call("/auth/staff/elevate", withToken(token)));
    const staffMe = await ok<{ id: string; role: string }>(call("/staff/me", bearer(staff.token)));
    expect(staffMe).toMatchObject({ id: staffId, role: "manager" });
    // сессия аккаунта в панель не пускает
    expect((await call("/staff/me", bearer(token))).status).toBe(403);
    // повышение — в журнале, без ПДн
    const { rows } = await admin.query<{ detail: { via: string; role: string } }>(
      "select detail from app.audit_log where action = 'staff.elevate' and object_id = $1",
      [staffId],
    );
    expect(rows.at(-1)?.detail).toMatchObject({ via: "tg_widget", role: "manager" });
  });

  it("доказательство старше 12 часов — 401 reauth_required, и код хаба для панели не выдаётся", async () => {
    const username = newStaffUsername();
    await inviteStaff(admin, { username });
    const token = await widgetSignIn(newTelegramUser({ username }));
    await admin.query(
      "update app.sessions set proof_at = now() - interval '13 hours' where token_hash = $1",
      [createHash("sha256").update(token).digest()],
    );
    expect(await errorOf(call("/auth/staff/elevate", withToken(token)))).toEqual({
      status: 401,
      code: "reauth_required",
    });
    const { res } = await hubCode(token, "admin");
    expect(await errorOf(res)).toEqual({ status: 401, code: "reauth_required" });
    // кабинету — можно: сессии сотрудника из него не получить
    expect((await hubCode(token, "vendor")).res.status).toBe(200);
  });

  it("панель как Mini App: initData приглашённого — сразу сессия сотрудника; не сотрудник — 403 без аккаунта", async () => {
    const username = newStaffUsername();
    await inviteStaff(admin, { username, role: "moderator" });
    const staffUser = newTelegramUser({ username });
    const initData = await initDataFor(staffUser, { botToken: BOT_TOKEN });
    const staff = await ok<SessionToken>(call("/auth/staff/webapp", json({ initData })));
    expect((await call("/staff/me", bearer(staff.token))).status).toBe(200);

    const stranger = newTelegramUser();
    const denied = await call(
      "/auth/staff/webapp",
      json({ initData: await initDataFor(stranger, { botToken: BOT_TOKEN }) }),
    );
    expect(denied.status).toBe(403);
    const { rows } = await admin.query(
      "select 1 from app.account_identities where kind = 'telegram' and value_hash = $1",
      [createHmac("sha256", ID_HASH_KEY).update(String(stranger.id)).digest()],
    );
    expect(rows).toHaveLength(0);
  });
});

describe("хаб входа: одноразовый код + PKCE", () => {
  it("код меняется на сессию кабинета один раз, с origin кабинета", async () => {
    const phone = randomPhone();
    await createVendor(phone);
    const hub = await phoneSignIn(phone);
    phoneAccounts.push((await me(hub)).account.id);

    const { res, p } = await hubCode(hub, "vendor");
    const { redirectUrl } = await ok<{ redirectUrl: string }>(res);
    const url = new URL(redirectUrl);
    expect(url.origin + url.pathname).toBe(`${VENDOR_ORIGIN}/auth/callback`);
    expect(url.searchParams.get("state")).toBe(p.state);
    const code = codeOf(redirectUrl);

    const session = await ok<SessionToken>(exchange("vendor", code, p.verifier, p.state, VENDOR_ORIGIN));
    expect((await call("/vendor/me", bearer(session.token))).status).toBe(200);
    const cabinetMe = await me(session.token);
    expect(cabinetMe.session).toEqual({ kind: "account", app: "vendor" });
    expect(cabinetMe.account.id).toBe((await me(hub)).account.id);

    // повтор — отказ
    expect(await errorOf(exchange("vendor", code, p.verifier, p.state, VENDOR_ORIGIN))).toEqual({
      status: 400,
      code: "invalid_code",
    });
  });

  it("чужой origin, другой verifier, state или приложение — 400, и код сгорает", async () => {
    const hub = await widgetSignIn(newTelegramUser());
    const cases: [string, (code: string, p: ReturnType<typeof pkce>) => Promise<Response>][] = [
      ["origin", (code, p) => exchange("vendor", code, p.verifier, p.state, "https://evil.example")],
      [
        "без origin",
        (code, p) =>
          call("/auth/hub/exchange", json({ app: "vendor", code, codeVerifier: p.verifier, state: p.state })),
      ],
      ["verifier", (code, p) => exchange("vendor", code, b64url(randomBytes(32)), p.state, VENDOR_ORIGIN)],
      ["state", (code, p) => exchange("vendor", code, p.verifier, b64url(randomBytes(16)), VENDOR_ORIGIN)],
      ["приложение", (code, p) => exchange("admin", code, p.verifier, p.state, ADMIN_ORIGIN)],
    ];
    for (const [name, attempt] of cases) {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { res, p } = await hubCode(hub, "vendor");
      const code = codeOf((await ok<{ redirectUrl: string }>(res)).redirectUrl);
      expect(await errorOf(attempt(code, p)), name).toEqual({ status: 400, code: "invalid_code" });
      // верная попытка после неверной — тоже отказ: код погашен
      expect((await exchange("vendor", code, p.verifier, p.state, VENDOR_ORIGIN)).status, name).toBe(400);
    }
  });

  it("истёкший код (старше 60 секунд) — 400", async () => {
    const hub = await widgetSignIn(newTelegramUser());
    const { res, p } = await hubCode(hub, "vendor");
    const code = codeOf((await ok<{ redirectUrl: string }>(res)).redirectUrl);
    await admin.query(
      `update app.hub_codes set created_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute'
       where code_hash = $1`,
      [createHash("sha256").update(code).digest()],
    );
    expect(await errorOf(exchange("vendor", code, p.verifier, p.state, VENDOR_ORIGIN))).toEqual({
      status: 400,
      code: "invalid_code",
    });
  });

  it("в базе — только хэши кода и state", async () => {
    const hub = await widgetSignIn(newTelegramUser());
    const { res, p } = await hubCode(hub, "vendor");
    const code = codeOf((await ok<{ redirectUrl: string }>(res)).redirectUrl);
    const { rows } = await admin.query<{ row: string }>(
      "select to_jsonb(h)::text as row from app.hub_codes h where code_hash = $1",
      [createHash("sha256").update(code).digest()],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.row).not.toContain(code);
    expect(rows[0]?.row).not.toContain(p.state);
  });

  it("панель: код → сессия аккаунта → повышение до сотрудника", async () => {
    const username = newStaffUsername();
    await inviteStaff(admin, { username, role: "admin" });
    const hub = await widgetSignIn(newTelegramUser({ username }));
    const { res, p } = await hubCode(hub, "admin");
    const code = codeOf((await ok<{ redirectUrl: string }>(res)).redirectUrl);
    const account = await ok<SessionToken>(exchange("admin", code, p.verifier, p.state, ADMIN_ORIGIN));
    const staff = await ok<SessionToken>(call("/auth/staff/elevate", withToken(account.token)));
    expect((await call("/staff/me", bearer(staff.token))).status).toBe(200);
  });
});

describe("код из сообщения: лимиты", () => {
  it("второй код раньше минуты — 429 otp_too_soon с Retry-After", async () => {
    const phone = randomPhone();
    await sendCode(phone);
    const res = await call("/auth/phone/send", json({ phone }));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("otp_too_soon");
  });

  it("пять неверных попыток — код сгорает; верный после этого не принимается", async () => {
    const phone = randomPhone();
    const code = await sendCode(phone);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let left = 4; left >= 1; left--) {
      const res = await call("/auth/phone/verify", json({ phone, code: wrong }));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "otp_invalid" }, attemptsLeft: String(left) });
    }
    expect(await errorOf(call("/auth/phone/verify", json({ phone, code: wrong })))).toEqual({
      status: 400,
      code: "otp_attempts",
    });
    expect(await errorOf(call("/auth/phone/verify", json({ phone, code })))).toEqual({
      status: 400,
      code: "otp_attempts",
    });
  });

  it("три кода за 10 минут на номер и три с одного IP — дальше 429 otp_limit", async () => {
    const phone = randomPhone();
    const ip = randomIp();
    for (let n = 0; n < 3; n++) {
      await sendCode(phone, ip);
      await minutePassed(phone);
    }
    expect(
      await errorOf(call("/auth/phone/send", json({ phone }, { "CF-Connecting-IP": randomIp() }))),
    ).toEqual({
      status: 429,
      code: "otp_limit",
    });
    expect(
      await errorOf(call("/auth/phone/send", json({ phone: randomPhone() }, { "CF-Connecting-IP": ip }))),
    ).toEqual({ status: 429, code: "otp_limit" });
  });

  it("без провайдера вход по телефону выключен — 503", async () => {
    const { makeEnv } = await import("./helpers");
    const { default: app } = await import("../../src/index");
    const ctx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext;
    const env = { ...makeEnv(), OTP_PROVIDER: "off" } as unknown as Env;
    const res = await app.request("/auth/phone/send", json({ phone: randomPhone() }), env, ctx);
    expect(res.status).toBe(503);
    // console-провайдер вне local — тоже выключен
    const staging = { ...makeEnv(), APP_ENV: "staging" } as unknown as Env;
    expect((await app.request("/auth/phone/send", json({ phone: randomPhone() }), staging, ctx)).status).toBe(
      503,
    );
  });

  it("в базе кода нет — только HMAC", async () => {
    const phone = randomPhone();
    const code = await sendCode(phone);
    const { rows } = await admin.query<{ code_hash: Buffer }>(
      "select code_hash from app.otp_codes where phone_hash = $1",
      [phoneHash(phone)],
    );
    expect(rows[0]?.code_hash).toEqual(
      createHmac("sha256", ID_HASH_KEY).update(`otp:${phone}:${code}`).digest(),
    );
  });
});

describe("способы входа в профиле", () => {
  it("Telegram-аккаунт добавляет телефон; номер другого аккаунта — 409 identity_taken", async () => {
    const token = await widgetSignIn(newTelegramUser());
    const phone = randomPhone();
    const code = await sendCode(phone);
    const linked = await ok<AccountMe>(call("/me/identities/phone", withToken(token, { phone, code })));
    expect(linked.identities.map((i) => i.kind).sort()).toEqual(["phone", "telegram"]);

    const other = randomPhone();
    phoneAccounts.push((await me(await phoneSignIn(other))).account.id);
    await minutePassed(other);
    const code2 = await sendCode(other);
    const second = await widgetSignIn(newTelegramUser());
    expect(
      await errorOf(call("/me/identities/phone", withToken(second, { phone: other, code: code2 }))),
    ).toEqual({
      status: 409,
      code: "identity_taken",
    });
    // второй телефон тому же аккаунту — 409 identity_kind_taken
    const third = randomPhone();
    const code3 = await sendCode(third);
    expect(
      await errorOf(call("/me/identities/phone", withToken(token, { phone: third, code: code3 }))),
    ).toEqual({
      status: 409,
      code: "identity_kind_taken",
    });
  });

  it("телефонный аккаунт добавляет Telegram из виджета; чужой Telegram — 409", async () => {
    const token = await phoneSignIn(randomPhone());
    phoneAccounts.push((await me(token)).account.id);
    const tg = newTelegramUser({ username: `link_${run}` });
    const widget = await signLoginWidget(
      { id: tg.id, first_name: "Linked", username: tg.username },
      BOT_TOKEN,
    );
    const linked = await ok<AccountMe>(call("/me/identities/telegram", withToken(token, { widget })));
    expect(linked.identities.map((i) => i.kind).sort()).toEqual(["phone", "telegram"]);
    expect(linked.profile.firstName).toBe("Linked");

    const busy = newTelegramUser();
    await widgetSignIn(busy);
    const other = await phoneSignIn(randomPhone());
    phoneAccounts.push((await me(other)).account.id);
    const busyWidget = await signLoginWidget({ id: busy.id, first_name: "Busy" }, BOT_TOKEN);
    expect(await errorOf(call("/me/identities/telegram", withToken(other, { widget: busyWidget })))).toEqual({
      status: 409,
      code: "identity_taken",
    });
  });

  it("старый вход (больше 12 часов) — добавить способ нельзя", async () => {
    const token = await widgetSignIn(newTelegramUser());
    await admin.query(
      "update app.sessions set proof_at = now() - interval '13 hours' where token_hash = $1",
      [createHash("sha256").update(token).digest()],
    );
    const phone = randomPhone();
    const code = await sendCode(phone);
    expect(await errorOf(call("/me/identities/phone", withToken(token, { phone, code })))).toEqual({
      status: 401,
      code: "reauth_required",
    });
  });
});

describe("удаление аккаунта — для всех ролей", () => {
  it("партнёр удаляет аккаунт: членство отвязано, вход тем же номером — снова партнёр", async () => {
    const phone = randomPhone();
    const { userId } = await createVendor(phone);
    const token = await phoneSignIn(phone);
    const accountId = (await me(token)).account.id;
    phoneAccounts.push(accountId);
    expect((await call("/me", { method: "DELETE", ...bearer(token) })).status).toBe(204);
    expect((await call("/vendor/me", bearer(token))).status).toBe(401);
    const { rows } = await admin.query<{ account_id: string | null }>(
      "select account_id from app.vendor_users where id = $1",
      [userId],
    );
    expect(rows[0]?.account_id).toBeNull();

    await minutePassed(phone);
    const again = await phoneSignIn(phone);
    const restored = await me(again);
    expect(restored.account.id).toBe(accountId);
    expect(restored.roles.vendors.map((v) => v.vendorUserId)).toEqual([userId]);
  });
});
