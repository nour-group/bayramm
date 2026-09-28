import { describe, expect, it } from "vitest";
import { verifyLoginWidget } from "./index";

// Токен выдуманный: подписываем им данные прямо в тесте
const BOT_TOKEN = "123:test-bot-token";
const AUTH_DATE = 1_790_000_000;
const DAY = 24 * 60 * 60;
// Через минуту после подписи
const now = () => (AUTH_DATE + 60) * 1000;
const at = (seconds: number) => () => seconds * 1000;

type Fields = Record<string, string>;

function baseFields(patch: Record<string, string | null> = {}): Fields {
  const merged: Record<string, string | null> = {
    id: "100000001",
    first_name: "Тест",
    last_name: "Ли + Ким",
    username: "test_user",
    photo_url: "https://t.me/i/userpic/320/test.jpg",
    auth_date: String(AUTH_DATE),
    ...patch,
  };
  return Object.fromEntries(
    Object.entries(merged).filter((pair): pair is [string, string] => pair[1] !== null),
  );
}

// Подпись по документации Telegram, написанная отдельно от пакета — на Web Crypto:
// secret_key = SHA256(bot_token), hash = hex(HMAC_SHA256(secret_key, data_check_string))
async function hashFor(fields: Fields, token = BOT_TOKEN): Promise<string> {
  const encoder = new TextEncoder();
  const secret = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const checkString = Object.keys(fields)
    .filter((k) => k !== "hash")
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(checkString)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function signed(fields: Fields, token = BOT_TOKEN): Promise<Fields> {
  return { ...fields, hash: await hashFor(fields, token) };
}

const EXPECTED_USER = {
  id: 100000001,
  firstName: "Тест",
  lastName: "Ли + Ким",
  username: "test_user",
  photoUrl: "https://t.me/i/userpic/320/test.jpg",
};

describe("verifyLoginWidget", () => {
  it("принимает эталон, посчитанный независимо (Python: hashlib + hmac)", async () => {
    const params = {
      ...baseFields(),
      hash: "a843daf3a27cccfd04ff9ecef4655e3c8a30fff3db36a3fb3327a46b7d5498c5",
    };
    expect(await verifyLoginWidget(params, BOT_TOKEN, { now })).toEqual({
      ok: true,
      data: { user: EXPECTED_USER, authDate: AUTH_DATE },
    });
  });

  it("принимает данные, подписанные в тесте", async () => {
    const result = await verifyLoginWidget(await signed(baseFields()), BOT_TOKEN, { now });
    expect(result).toEqual({ ok: true, data: { user: EXPECTED_USER, authDate: AUTH_DATE } });
  });

  it("id и auth_date числами — как в колбэке data-onauth", async () => {
    const fields = await signed(baseFields());
    const params = { ...fields, id: 100000001, auth_date: AUTH_DATE };
    expect((await verifyLoginWidget(params, BOT_TOKEN, { now })).ok).toBe(true);
  });

  it("query-строка редиректа data-auth-url", async () => {
    const fields = await signed(baseFields());
    const query = new URLSearchParams(fields).toString();
    expect(query).toContain("first_name=%D0%A2");
    const result = await verifyLoginWidget(new URLSearchParams(query), BOT_TOKEN, { now });
    expect(result).toEqual({ ok: true, data: { user: EXPECTED_USER, authDate: AUTH_DATE } });
  });

  it("не зависит от порядка полей", async () => {
    const fields = await signed(baseFields());
    const reversed = Object.fromEntries(Object.entries(fields).reverse());
    expect((await verifyLoginWidget(reversed, BOT_TOKEN, { now })).ok).toBe(true);
  });

  it("необязательные поля можно не присылать", async () => {
    const fields = await signed(baseFields({ last_name: null, username: null, photo_url: null }));
    expect(await verifyLoginWidget(fields, BOT_TOKEN, { now })).toEqual({
      ok: true,
      data: { user: { id: 100000001, firstName: "Тест" }, authDate: AUTH_DATE },
    });
  });

  it("неизвестные поля входят в строку проверки, но в результат не попадают", async () => {
    const fields = await signed(baseFields({ is_admin: "true" }));
    const result = await verifyLoginWidget(fields, BOT_TOKEN, { now });
    expect(result).toEqual({ ok: true, data: { user: EXPECTED_USER, authDate: AUTH_DATE } });
  });

  describe("подделка → bad_hash", () => {
    it.each([
      ["id", "100000002"],
      ["username", "someone_else"],
      ["auth_date", String(AUTH_DATE + 1)],
      ["first_name", "Другое"],
    ])("изменено поле %s", async (key, value) => {
      const fields = { ...(await signed(baseFields())), [key]: value };
      expect(await verifyLoginWidget(fields, BOT_TOKEN, { now })).toEqual({ ok: false, reason: "bad_hash" });
    });

    it("добавлено поле", async () => {
      const fields = { ...(await signed(baseFields())), is_admin: "true" };
      expect(await verifyLoginWidget(fields, BOT_TOKEN, { now })).toEqual({ ok: false, reason: "bad_hash" });
    });

    it("удалено поле", async () => {
      const { username: _drop, ...fields } = await signed(baseFields());
      expect(await verifyLoginWidget(fields, BOT_TOKEN, { now })).toEqual({ ok: false, reason: "bad_hash" });
    });

    it("подписано другим ботом", async () => {
      const fields = await signed(baseFields(), "456:other-bot-token");
      expect(await verifyLoginWidget(fields, BOT_TOKEN, { now })).toEqual({ ok: false, reason: "bad_hash" });
    });

    it("подписано по схеме Mini App (HMAC «WebAppData»), а не виджета", async () => {
      const encoder = new TextEncoder();
      const webAppKey = await crypto.subtle.importKey(
        "raw",
        encoder.encode("WebAppData"),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const secret = await crypto.subtle.sign("HMAC", webAppKey, encoder.encode(BOT_TOKEN));
      const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, [
        "sign",
      ]);
      const fields = baseFields();
      const checkString = Object.keys(fields)
        .sort()
        .map((k) => `${k}=${fields[k]}`)
        .join("\n");
      const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(checkString)));
      const hash = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
      expect(await verifyLoginWidget({ ...fields, hash }, BOT_TOKEN, { now })).toEqual({
        ok: false,
        reason: "bad_hash",
      });
    });

    it.each([
      ["не hex", "z".repeat(64)],
      ["заглавные буквы", "A".repeat(64)],
      ["короче 32 байт", "ab".repeat(31)],
      ["пустой", ""],
    ])("hash %s", async (_name, hash) => {
      expect(await verifyLoginWidget({ ...baseFields(), hash }, BOT_TOKEN, { now })).toEqual({
        ok: false,
        reason: "bad_hash",
      });
    });
  });

  it("без hash — missing_hash", async () => {
    expect(await verifyLoginWidget(baseFields(), BOT_TOKEN, { now })).toEqual({
      ok: false,
      reason: "missing_hash",
    });
    expect(await verifyLoginWidget({}, BOT_TOKEN, { now })).toEqual({ ok: false, reason: "missing_hash" });
  });

  describe("срок годности", () => {
    it("ровно сутки — ещё принимается", async () => {
      const fields = await signed(baseFields());
      expect((await verifyLoginWidget(fields, BOT_TOKEN, { now: at(AUTH_DATE + DAY) })).ok).toBe(true);
    });

    it("сутки и секунда — expired", async () => {
      const fields = await signed(baseFields());
      expect(await verifyLoginWidget(fields, BOT_TOKEN, { now: at(AUTH_DATE + DAY + 1) })).toEqual({
        ok: false,
        reason: "expired",
      });
    });

    it("maxAgeSeconds сужает окно", async () => {
      const fields = await signed(baseFields());
      const opts = { now: at(AUTH_DATE + 601), maxAgeSeconds: 600 };
      expect(await verifyLoginWidget(fields, BOT_TOKEN, opts)).toEqual({ ok: false, reason: "expired" });
      expect((await verifyLoginWidget(fields, BOT_TOKEN, { ...opts, now: at(AUTH_DATE + 600) })).ok).toBe(
        true,
      );
    });

    it("дата из будущего дальше 5 минут — expired", async () => {
      const fields = await signed(baseFields());
      expect((await verifyLoginWidget(fields, BOT_TOKEN, { now: at(AUTH_DATE - 300) })).ok).toBe(true);
      expect(await verifyLoginWidget(fields, BOT_TOKEN, { now: at(AUTH_DATE - 301) })).toEqual({
        ok: false,
        reason: "expired",
      });
    });

    it("без now сверяется с Date.now: подпись 2001 года просрочена", async () => {
      const fields = await signed(baseFields({ auth_date: "1000000000" }));
      expect(await verifyLoginWidget(fields, BOT_TOKEN)).toEqual({ ok: false, reason: "expired" });
    });
  });

  describe("malformed", () => {
    it.each([
      ["без auth_date", { auth_date: null }],
      ["auth_date не число", { auth_date: "soon" }],
      ["без id", { id: null }],
      ["id не число", { id: "abc" }],
      ["id с ведущим нулём", { id: "0100000001" }],
      ["id больше 2^53", { id: "9007199254740993" }],
      ["без first_name", { first_name: null }],
    ])("верная подпись, но %s", async (_name, patch) => {
      const fields = await signed(baseFields(patch));
      expect(await verifyLoginWidget(fields, BOT_TOKEN, { now })).toEqual({ ok: false, reason: "malformed" });
    });

    it.each([
      ["null", null],
      ["массив", [["id", "1"]]],
      ["строка", "id=1&hash=00"],
      ["вложенный объект", { ...baseFields(), user: { id: 1 } }],
      ["null в поле", { ...baseFields(), last_name: null }],
      ["дробное число", { ...baseFields(), id: 1.5 }],
      ["логическое значение", { ...baseFields(), is_bot: false }],
      ["имя поля с заглавной", { ...baseFields(), Id: "1" }],
      ["пустое имя поля", { ...baseFields(), "": "x" }],
      ["слишком много полей", Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`f${i}`, "x"]))],
      ["слишком длинные значения", { ...baseFields(), last_name: "x".repeat(5000) }],
    ])("%s — отказ до HMAC", async (_name, params) => {
      expect(await verifyLoginWidget(params as never, BOT_TOKEN, { now })).toEqual({
        ok: false,
        reason: "malformed",
      });
    });

    it("повтор ключа в query-строке", async () => {
      const fields = await signed(baseFields());
      const query = new URLSearchParams(fields);
      query.append("id", "100000002");
      expect(await verifyLoginWidget(query, BOT_TOKEN, { now })).toEqual({ ok: false, reason: "malformed" });
    });
  });

  describe("ошибки конфигурации — исключения", () => {
    it("пустой токен бота", async () => {
      await expect(verifyLoginWidget(baseFields(), "", { now })).rejects.toThrow("токен бота");
    });

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("maxAgeSeconds = %s", async (maxAgeSeconds) => {
      await expect(verifyLoginWidget(baseFields(), BOT_TOKEN, { maxAgeSeconds })).rejects.toThrow(RangeError);
    });
  });
});
