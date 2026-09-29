import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../errors";
import { fakeDb, type RecordedQuery } from "../testing/fake-db";
import { initDataFor } from "../testing/init-data";
import { BOT_TOKEN } from "../testing/worker";
import { telegramIdHash } from "./crypto";
import { signInVendor, VENDOR_SESSION_TTL_SECONDS } from "./vendor";

const ENV = { TELEGRAM_BOT_TOKEN: BOT_TOKEN, ID_HASH_KEY: "unit-test-id-hash-key-0123456789abcdef" };
const TELEGRAM_ID = 555_000_111;
const USER_ID = "aaaaaaaa-0000-0000-0000-000000000011";
const VENDOR_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const EXPIRES = new Date("2026-10-03T20:00:00Z");

interface VendorUserRow {
  id: string;
  vendor_id: string;
  disabled_at: Date | null;
}

// Пользователь вендора — на поиск по псевдониму, срок — на вставку сессии
function dbWith(user: VendorUserRow | null) {
  return fakeDb((q: RecordedQuery) => {
    if (q.sql.startsWith('select "id", "vendor_id", "disabled_at" from "app"."vendor_users"')) {
      return user ? [user] : [];
    }
    if (q.sql.startsWith('insert into "app"."sessions"')) return [{ expires_at: EXPIRES }];
    return [];
  });
}

const linked: VendorUserRow = { id: USER_ID, vendor_id: VENDOR_ID, disabled_at: null };

async function initData(languageCode = "uz") {
  return initDataFor(
    { id: TELEGRAM_ID, first_name: "Vendor", language_code: languageCode },
    { botToken: BOT_TOKEN },
  );
}

async function rejection(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("ожидался отказ");
}

afterEach(() => vi.restoreAllMocks());

describe("signInVendor", () => {
  it("чужая подпись — 401 без запроса к базе", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = dbWith(linked);
    const bad = await initDataFor({ id: TELEGRAM_ID, first_name: "Vendor" }, { botToken: "999:other" });
    const err = await rejection(() => signInVendor(fake.db, ENV, bad));
    expect([err.status, err.code]).toEqual([401, "unauthorized"]);
    expect(fake.queries).toEqual([]);
  });

  it("ищет пользователя под system по HMAC Telegram ID, а не по самому ID", async () => {
    const fake = dbWith(linked);
    await signInVendor(fake.db, ENV, await initData());
    const [settings, lookup] = fake.queries;
    expect(settings?.parameters).toEqual(["system", "", ""]);
    expect(lookup?.sql).toContain('where "tg_user_hash" = $1');
    expect(lookup?.parameters).toEqual([await telegramIdHash(ENV.ID_HASH_KEY, TELEGRAM_ID)]);
    expect(JSON.stringify(fake.queries.map((q) => q.parameters))).not.toContain(String(TELEGRAM_ID));
  });

  it("Telegram не привязан — 403 vendor_not_linked, сессии нет", async () => {
    const fake = dbWith(null);
    const err = await rejection(async () => signInVendor(fake.db, ENV, await initData()));
    expect([err.status, err.code]).toEqual([403, "vendor_not_linked"]);
    expect(fake.log).toContain("rollback");
    expect(fake.queries.some((q) => q.sql.includes('"app"."sessions"'))).toBe(false);
  });

  it("пользователь отключён — 403 vendor_disabled, сессии нет", async () => {
    const fake = dbWith({ ...linked, disabled_at: new Date() });
    const err = await rejection(async () => signInVendor(fake.db, ENV, await initData()));
    expect([err.status, err.code]).toEqual([403, "vendor_disabled"]);
    expect(fake.queries.some((q) => q.sql.includes('"app"."sessions"'))).toBe(false);
  });

  it("выдаёт сессию tg_partner на 12 часов, отмечает вход; язык — только при первом входе", async () => {
    const fake = dbWith(linked);
    const session = await signInVendor(fake.db, ENV, await initData("ru-RU"));
    expect(session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session.expiresAt).toEqual(EXPIRES);
    expect(session.vendorUser).toEqual({ id: USER_ID, vendorId: VENDOR_ID });

    const update = fake.queries.find((q) => q.sql.startsWith('update "app"."vendor_users"'));
    expect(update?.sql).toContain('"last_login_at" = now()');
    expect(update?.sql).toContain("case when last_login_at is null then coalesce($1::app.locale, locale)");
    expect(update?.parameters).toEqual(["ru", USER_ID]);

    const insert = fake.queries.find((q) => q.sql.startsWith('insert into "app"."sessions"'));
    expect(insert?.parameters).toContain("tg_partner");
    expect(insert?.parameters).toContain(USER_ID);
    expect(insert?.parameters).toContain(VENDOR_SESSION_TTL_SECONDS);
    expect(VENDOR_SESSION_TTL_SECONDS).toBe(12 * 60 * 60);
    expect(JSON.stringify(insert?.parameters)).not.toContain(session.token);
    expect(fake.log.at(-1)).toBe("commit");
  });

  it("язык Telegram не ru/uz — язык кабинета не трогается", async () => {
    const fake = dbWith(linked);
    await signInVendor(fake.db, ENV, await initData("en"));
    const update = fake.queries.find((q) => q.sql.startsWith('update "app"."vendor_users"'));
    expect(update?.parameters).toEqual([null, USER_ID]);
  });
});
