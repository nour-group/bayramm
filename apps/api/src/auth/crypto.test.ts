import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  generateToken,
  hashToken,
  isWellFormedToken,
  MIN_ID_HASH_KEY_LENGTH,
  parseAuthorization,
  secretsEqual,
  TOKEN_BYTES,
  telegramIdHash,
  toBase64Url,
} from "./crypto";

const KEY = "k".repeat(MIN_ID_HASH_KEY_LENGTH);

function fromBase64Url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

describe("generateToken", () => {
  it("32 случайных байта в base64url без паддинга — 43 символа", () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fromBase64Url(token)).toHaveLength(TOKEN_BYTES);
    expect(isWellFormedToken(token)).toBe(true);
  });

  it("не повторяется", () => {
    const tokens = new Set(Array.from({ length: 200 }, generateToken));
    expect(tokens.size).toBe(200);
  });
});

describe("toBase64Url", () => {
  it("алфавит URL-safe, без =", () => {
    expect(toBase64Url(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
    expect(toBase64Url(new Uint8Array([]))).toBe("");
    expect(toBase64Url(new TextEncoder().encode("hello"))).toBe("aGVsbG8");
  });
});

describe("hashToken", () => {
  it("sha256 от строки токена", async () => {
    // эталон из FIPS 180-2
    expect(Buffer.from(await hashToken("abc")).toString("hex")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const token = generateToken();
    expect(Buffer.from(await hashToken(token))).toEqual(createHash("sha256").update(token).digest());
  });

  it("32 байта, как требует check в app.sessions", async () => {
    expect(await hashToken(generateToken())).toHaveLength(32);
  });
});

describe("parseAuthorization", () => {
  const token = generateToken();

  it("нет заголовка — гость", () => {
    expect(parseAuthorization(undefined)).toEqual({ kind: "none" });
  });

  it("Bearer с токеном нашего формата", () => {
    expect(parseAuthorization(`Bearer ${token}`)).toEqual({ kind: "token", token });
    expect(parseAuthorization(`bearer ${token}`)).toEqual({ kind: "token", token });
  });

  it("всё остальное — невалидно, без похода в базу", () => {
    for (const header of [
      "",
      "Bearer",
      "Bearer ",
      `Basic ${token}`,
      token,
      `Bearer ${token}x`,
      `Bearer ${token.slice(1)}`,
      `Bearer ${token} extra`,
      `Bearer ${"+".repeat(43)}`,
      `Bearer ${"a".repeat(42)}=`,
    ]) {
      expect(parseAuthorization(header), JSON.stringify(header)).toEqual({ kind: "invalid" });
    }
  });
});

describe("secretsEqual", () => {
  it("совпадает только та же строка", async () => {
    const secret = "s".repeat(40);
    expect(await secretsEqual(secret, secret)).toBe(true);
    for (const other of ["", secret.slice(1), `${secret}s`, `S${secret.slice(1)}`, "x"]) {
      expect(await secretsEqual(other, secret), JSON.stringify(other)).toBe(false);
    }
  });
});

describe("telegramIdHash", () => {
  it("HMAC-SHA256(ID_HASH_KEY, десятичный Telegram ID)", async () => {
    const expected = createHmac("sha256", KEY).update("100000001").digest();
    expect(Buffer.from(await telegramIdHash(KEY, 100000001))).toEqual(expected);
  });

  it("зависит от ключа и от ID", async () => {
    const a = await telegramIdHash(KEY, 1);
    expect(await telegramIdHash(`${KEY}x`, 1)).not.toEqual(a);
    expect(await telegramIdHash(KEY, 2)).not.toEqual(a);
    expect(a).toHaveLength(32);
  });

  it("пустой или короткий ключ — ошибка конфигурации", async () => {
    await expect(telegramIdHash("", 1)).rejects.toThrow(/ID_HASH_KEY/);
    await expect(telegramIdHash("k".repeat(MIN_ID_HASH_KEY_LENGTH - 1), 1)).rejects.toThrow(/ID_HASH_KEY/);
  });

  it("ID — только положительное безопасное целое", async () => {
    for (const id of [0, -1, 1.5, Number.NaN, 2 ** 53]) {
      await expect(telegramIdHash(KEY, id), String(id)).rejects.toThrow(RangeError);
    }
  });
});
