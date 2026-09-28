import { describe, expect, it } from "vitest";
import { verifyInitData, verifyInitDataSignature } from "./index";

// Токен выдуманный: подписываем им initData прямо в тесте
const BOT_TOKEN = "123:test-bot-token";
const AUTH_DATE = 1_790_000_000;
const DAY = 24 * 60 * 60;
// Через минуту после подписи
const now = () => (AUTH_DATE + 60) * 1000;
const at = (seconds: number) => () => seconds * 1000;

const USER = { id: 100000001, first_name: "Тест", username: "test_user", allows_write_to_pm: true };

type Pairs = [string, string][];

function basePairs(patch: Record<string, string | null> = {}): Pairs {
  const base: Record<string, string> = {
    query_id: "AAE-test-query-id",
    user: JSON.stringify(USER),
    auth_date: String(AUTH_DATE),
    chat_type: "private",
    chat_instance: "-1234567890123456789",
    start_param: "vendor_toyxona-1",
    signature: "fake-signature_value",
  };
  const merged: Record<string, string | null> = { ...base, ...patch };
  return Object.entries(merged).filter((pair): pair is [string, string] => pair[1] !== null);
}

// Подпись по документации Telegram, написанная отдельно от пакета — на Web Crypto
async function hmac(key: BufferSource, message: string) {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message)));
}

function hex(bytes: Uint8Array) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function checkString(pairs: Pairs, excluded: string[]) {
  return pairs
    .filter(([key]) => !excluded.includes(key))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

async function hashFor(pairs: Pairs, token = BOT_TOKEN, excluded = ["hash"]) {
  const secretKey = await hmac(new TextEncoder().encode("WebAppData"), token);
  return hex(await hmac(secretKey, checkString(pairs, excluded)));
}

async function signed(pairs: Pairs, token = BOT_TOKEN) {
  return new URLSearchParams([...pairs, ["hash", await hashFor(pairs, token)]]).toString();
}

describe("verifyInitData", () => {
  it("принимает эталон, посчитанный независимо (Python, алгоритм aiogram)", async () => {
    // Кириллица, «+» внутри значения, экранированные слэши в JSON, поле signature
    const initData =
      "query_id=AAE-test-query-id&user=%7B%22id%22%3A100000001%2C%22first_name%22%3A%22%D0%A2%D0%B5%D1%81%D1%82%22%2C%22last_name%22%3A%22%D0%9B%D0%B8%20%2B%20%D0%9A%D0%B8%D0%BC%22%2C%22username%22%3A%22test_user%22%2C%22language_code%22%3A%22ru%22%2C%22allows_write_to_pm%22%3Atrue%2C%22photo_url%22%3A%22https%3A%5C%2F%5C%2Ft.me%5C%2Fi%5C%2Fuserpic%5C%2F320%5C%2Ftest.svg%22%7D&chat_instance=-1234567890123456789&chat_type=private&start_param=vendor_toyxona-1&auth_date=1790000000&signature=fake-signature_value&hash=2d42811ceb0c943cce03de1a7d4707aaca621e1fcc073bf229e724c4650373d3";

    const result = await verifyInitData(initData, BOT_TOKEN, { now });

    expect(result).toEqual({
      ok: true,
      data: {
        user: {
          id: 100000001,
          firstName: "Тест",
          lastName: "Ли + Ким",
          username: "test_user",
          languageCode: "ru",
          allowsWriteToPm: true,
          photoUrl: "https://t.me/i/userpic/320/test.svg",
        },
        authDate: AUTH_DATE,
        startParam: "vendor_toyxona-1",
        queryId: "AAE-test-query-id",
        chatType: "private",
        chatInstance: "-1234567890123456789",
      },
    });
  });

  it("принимает initData, подписанную в тесте", async () => {
    const result = await verifyInitData(await signed(basePairs()), BOT_TOKEN, { now });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.user).toEqual({
      id: 100000001,
      firstName: "Тест",
      username: "test_user",
      allowsWriteToPm: true,
    });
    expect(result.data.authDate).toBe(AUTH_DATE);
  });

  it("не зависит от порядка полей", async () => {
    const pairs = basePairs();
    const hash = await hashFor(pairs);
    const reversed = new URLSearchParams([["hash", hash], ...[...pairs].reverse()]).toString();
    const middle = new URLSearchParams([...pairs.slice(0, 3), ["hash", hash], ...pairs.slice(3)]).toString();

    expect((await verifyInitData(reversed, BOT_TOKEN, { now })).ok).toBe(true);
    expect((await verifyInitData(middle, BOT_TOKEN, { now })).ok).toBe(true);
  });

  it("не требует необязательных полей", async () => {
    const pairs = basePairs({ query_id: null, chat_type: null, chat_instance: null, start_param: null });
    const result = await verifyInitData(await signed(pairs), BOT_TOKEN, { now });

    expect(result).toEqual({
      ok: true,
      data: {
        user: { id: 100000001, firstName: "Тест", username: "test_user", allowsWriteToPm: true },
        authDate: AUTH_DATE,
      },
    });
  });

  describe("подделка → bad_hash", () => {
    it.each([
      ["user", JSON.stringify({ ...USER, id: 100000002 })],
      ["auth_date", String(AUTH_DATE + 1)],
      ["start_param", "vendor_other"],
      ["query_id", "AAE-other"],
    ])("изменено поле %s", async (key, value) => {
      const params = new URLSearchParams(await signed(basePairs()));
      params.set(key, value);

      expect(await verifyInitData(params.toString(), BOT_TOKEN, { now })).toEqual({
        ok: false,
        reason: "bad_hash",
      });
    });

    it("добавлено поле", async () => {
      const initData = `${await signed(basePairs())}&is_admin=true`;
      expect(await verifyInitData(initData, BOT_TOKEN, { now })).toEqual({ ok: false, reason: "bad_hash" });
    });

    it("удалено поле", async () => {
      const params = new URLSearchParams(await signed(basePairs()));
      params.delete("chat_type");
      expect(await verifyInitData(params.toString(), BOT_TOKEN, { now })).toEqual({
        ok: false,
        reason: "bad_hash",
      });
    });

    it("подписано другим ботом", async () => {
      const initData = await signed(basePairs(), "456:other-bot-token");
      expect(await verifyInitData(initData, BOT_TOKEN, { now })).toEqual({ ok: false, reason: "bad_hash" });
    });

    it.each([
      ["не hex", "z".repeat(64)],
      ["заглавные буквы", "A".repeat(64)],
      ["короче 32 байт", "ab".repeat(31)],
      ["пустой", ""],
    ])("hash %s", async (_name, hash) => {
      const initData = new URLSearchParams([...basePairs(), ["hash", hash]]).toString();
      expect(await verifyInitData(initData, BOT_TOKEN, { now })).toEqual({ ok: false, reason: "bad_hash" });
    });
  });

  describe("поле signature входит в строку проверки hash", () => {
    // Telegram считает hash по всем полям, кроме hash. signature исключается только
    // при проверке Ed25519 (verifyInitDataSignature), не здесь.
    it("изменённая signature ломает hash", async () => {
      const params = new URLSearchParams(await signed(basePairs()));
      params.set("signature", "another-signature");
      expect(await verifyInitData(params.toString(), BOT_TOKEN, { now })).toEqual({
        ok: false,
        reason: "bad_hash",
      });
    });

    it("hash, посчитанный без signature, не принимается", async () => {
      const pairs = basePairs();
      const hash = await hashFor(pairs, BOT_TOKEN, ["hash", "signature"]);
      const initData = new URLSearchParams([...pairs, ["hash", hash]]).toString();
      expect(await verifyInitData(initData, BOT_TOKEN, { now })).toEqual({ ok: false, reason: "bad_hash" });
    });

    it("без signature initData тоже валидна (старые клиенты)", async () => {
      const initData = await signed(basePairs({ signature: null }));
      expect((await verifyInitData(initData, BOT_TOKEN, { now })).ok).toBe(true);
    });
  });

  it.each([
    ["без hash", "auth_date=1790000000&user=%7B%7D"],
    ["пустая строка", ""],
  ])("missing_hash: %s", async (_name, initData) => {
    expect(await verifyInitData(initData, BOT_TOKEN, { now })).toEqual({ ok: false, reason: "missing_hash" });
  });

  describe("срок годности", () => {
    it("ровно сутки — ещё принимается", async () => {
      const initData = await signed(basePairs());
      expect((await verifyInitData(initData, BOT_TOKEN, { now: at(AUTH_DATE + DAY) })).ok).toBe(true);
    });

    it("сутки и секунда — expired", async () => {
      const initData = await signed(basePairs());
      expect(await verifyInitData(initData, BOT_TOKEN, { now: at(AUTH_DATE + DAY + 1) })).toEqual({
        ok: false,
        reason: "expired",
      });
    });

    it("maxAgeSeconds сужает окно", async () => {
      const initData = await signed(basePairs());
      const opts = { now: at(AUTH_DATE + 3601), maxAgeSeconds: 3600 };
      expect(await verifyInitData(initData, BOT_TOKEN, opts)).toEqual({ ok: false, reason: "expired" });
    });

    it("дата из будущего в пределах 5 минут — расхождение часов, принимается", async () => {
      const initData = await signed(basePairs());
      expect((await verifyInitData(initData, BOT_TOKEN, { now: at(AUTH_DATE - 300) })).ok).toBe(true);
    });

    it("дата из будущего дальше 5 минут — expired", async () => {
      const initData = await signed(basePairs());
      expect(await verifyInitData(initData, BOT_TOKEN, { now: at(AUTH_DATE - 301) })).toEqual({
        ok: false,
        reason: "expired",
      });
    });

    it("без now сверяется с Date.now: подпись 2001 года просрочена", async () => {
      const initData = await signed(basePairs({ auth_date: "1000000000" }));
      expect(await verifyInitData(initData, BOT_TOKEN)).toEqual({ ok: false, reason: "expired" });
    });
  });

  describe("malformed", () => {
    it.each([
      ["не JSON", "{id:1"],
      ["пустая строка", ""],
      ["массив", "[1,2]"],
      ["null", "null"],
      ["без id", JSON.stringify({ first_name: "Тест" })],
      ["id строкой", JSON.stringify({ id: "100000001", first_name: "Тест" })],
      ["id дробный", JSON.stringify({ id: 1.5, first_name: "Тест" })],
      ["id отрицательный", JSON.stringify({ id: -1, first_name: "Тест" })],
      ["без first_name", JSON.stringify({ id: 100000001 })],
    ])("user: %s", async (_name, user) => {
      const initData = await signed(basePairs({ user }));
      expect(await verifyInitData(initData, BOT_TOKEN, { now })).toEqual({ ok: false, reason: "malformed" });
    });

    it.each([
      ["нет", null],
      ["не число", "yesterday"],
      ["с минусом", "-1790000000"],
      ["с ведущим нулём", "01790000000"],
    ])("auth_date: %s", async (_name, authDate) => {
      const initData = await signed(basePairs({ auth_date: authDate }));
      expect(await verifyInitData(initData, BOT_TOKEN, { now })).toEqual({ ok: false, reason: "malformed" });
    });

    it("повтор ключа — даже если подпись сошлась бы на первом значении", async () => {
      const initData = `${await signed(basePairs())}&user=${encodeURIComponent(JSON.stringify({ id: 1, first_name: "X" }))}`;
      expect(await verifyInitData(initData, BOT_TOKEN, { now })).toEqual({ ok: false, reason: "malformed" });
    });

    it("слишком длинная строка", async () => {
      const initData = await signed(basePairs({ query_id: "a".repeat(20_000) }));
      expect(await verifyInitData(initData, BOT_TOKEN, { now })).toEqual({ ok: false, reason: "malformed" });
    });

    it("не строка на входе (сырой JSON из запроса)", async () => {
      expect(await verifyInitData(42 as unknown as string, BOT_TOKEN, { now })).toEqual({
        ok: false,
        reason: "malformed",
      });
    });
  });

  it("missing_user: подпись верна, но пользователя нет", async () => {
    const initData = await signed(basePairs({ user: null }));
    expect(await verifyInitData(initData, BOT_TOKEN, { now })).toEqual({ ok: false, reason: "missing_user" });
  });

  it("из user берутся только известные поля нужного типа", async () => {
    // __proto__ — строкой: в объектном литерале он задал бы прототип, а не поле
    const user =
      '{"id":100000001,"first_name":"Тест","is_premium":"yes","username":42,"role":"admin","__proto__":{"isAdmin":true}}';
    const result = await verifyInitData(await signed(basePairs({ user })), BOT_TOKEN, { now });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.data.user).toStrictEqual({ id: 100000001, firstName: "Тест" });
    expect(Object.getPrototypeOf(result.data.user)).toBe(Object.prototype);
  });

  describe("ошибки конфигурации бросают исключение", () => {
    it("пустой токен", async () => {
      await expect(verifyInitData(await signed(basePairs()), "")).rejects.toThrow(/токен/);
    });

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("maxAgeSeconds = %s", async (maxAgeSeconds) => {
      await expect(verifyInitData("", BOT_TOKEN, { maxAgeSeconds })).rejects.toThrow(RangeError);
    });
  });
});

describe("verifyInitDataSignature (Ed25519, без токена)", () => {
  const BOT_ID = 123;

  function base64Url(bytes: Uint8Array) {
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  // Своя пара ключей вместо ключа Telegram: закрытого ключа Telegram у нас, понятно, нет
  async function setup() {
    const keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
    async function sign(pairs: Pairs, botId = BOT_ID) {
      const message = `${botId}:WebAppData\n${checkString(pairs, ["hash", "signature"])}`;
      const signature = await crypto.subtle.sign(
        { name: "Ed25519" },
        keys.privateKey,
        new TextEncoder().encode(message),
      );
      return new URLSearchParams([...pairs, ["signature", base64Url(new Uint8Array(signature))]]).toString();
    }
    return { publicKey, sign };
  }

  // hash в строку подписи не входит, поэтому может быть любым
  const pairs = () => [...basePairs({ signature: null }), ["hash", "0".repeat(64)]] as Pairs;

  it("принимает подпись; hash и signature в строку подписи не входят", async () => {
    const { publicKey, sign } = await setup();
    const result = await verifyInitDataSignature(await sign(pairs()), BOT_ID, { publicKey, now });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.user.id).toBe(100000001);
    expect(result.data.startParam).toBe("vendor_toyxona-1");
  });

  it("подделанное поле → bad_signature", async () => {
    const { publicKey, sign } = await setup();
    const params = new URLSearchParams(await sign(pairs()));
    params.set("user", JSON.stringify({ ...USER, id: 100000002 }));

    expect(await verifyInitDataSignature(params.toString(), BOT_ID, { publicKey, now })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("чужой бот → bad_signature", async () => {
    const { publicKey, sign } = await setup();
    expect(await verifyInitDataSignature(await sign(pairs(), 456), BOT_ID, { publicKey, now })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("настоящий ключ Telegram не принимает нашу подпись", async () => {
    const { sign } = await setup();
    const initData = await sign(pairs());
    for (const publicKey of ["production", "test"] as const) {
      expect(await verifyInitDataSignature(initData, BOT_ID, { publicKey, now })).toEqual({
        ok: false,
        reason: "bad_signature",
      });
    }
    expect(await verifyInitDataSignature(initData, BOT_ID, { now })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it.each([
    ["не base64url", "not/base64+url"],
    ["не 64 байта", "AAAA"],
    ["пустая", ""],
  ])("signature %s → bad_signature", async (_name, signature) => {
    const { publicKey } = await setup();
    const initData = new URLSearchParams([...pairs(), ["signature", signature]]).toString();
    expect(await verifyInitDataSignature(initData, BOT_ID, { publicKey, now })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("без signature → missing_signature", async () => {
    const { publicKey } = await setup();
    const initData = new URLSearchParams(pairs()).toString();
    expect(await verifyInitDataSignature(initData, BOT_ID, { publicKey, now })).toEqual({
      ok: false,
      reason: "missing_signature",
    });
  });

  it("старая подпись → expired", async () => {
    const { publicKey, sign } = await setup();
    const result = await verifyInitDataSignature(await sign(pairs()), BOT_ID, {
      publicKey,
      now: at(AUTH_DATE + DAY + 1),
    });
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it.each([0, -5, 1.5, Number.NaN])("botId = %s → исключение", async (botId) => {
    await expect(verifyInitDataSignature("", botId)).rejects.toThrow(RangeError);
  });
});
