import { describe, expect, it, vi } from "vitest";
import {
  consoleSender,
  generateOtpCode,
  maskPhone,
  normalizeOtpCode,
  OtpDeliveryError,
  otpCodeHash,
  otpSenderFor,
  TELEGRAM_GATEWAY_URL,
  telegramGatewaySender,
} from "./otp";

const KEY = "unit-test-id-hash-key-0123456789abcdef";
const PHONE = "+998001234567";

describe("generateOtpCode", () => {
  it("6 цифр, каждый раз новый", () => {
    const codes = new Set(Array.from({ length: 200 }, generateOtpCode));
    for (const code of codes) expect(code).toMatch(/^[0-9]{6}$/);
    expect(codes.size).toBeGreaterThan(190);
  });

  it("цифры распределены без перекоса", () => {
    const counts = new Array<number>(10).fill(0);
    for (let i = 0; i < 2000; i++)
      for (const digit of generateOtpCode()) counts[Number(digit)] = (counts[Number(digit)] ?? 0) + 1;
    // 12000 цифр, в среднем по 1200: грубая проверка, что 0–5 не выпадают чаще 6–9
    for (const count of counts) expect(count).toBeGreaterThan(1000);
  });
});

describe("normalizeOtpCode", () => {
  it("6 цифр, пробелы и дефисы между ними — допустимы", () => {
    expect(normalizeOtpCode("123456")).toBe("123456");
    expect(normalizeOtpCode(" 123 456 ")).toBe("123456");
    expect(normalizeOtpCode("123-456")).toBe("123456");
  });

  it.each([["12345"], ["1234567"], ["12a456"], [123456], [null], ["1".repeat(40)]])("%s — null", (raw) => {
    expect(normalizeOtpCode(raw)).toBeNull();
  });
});

describe("otpCodeHash", () => {
  it("HMAC(ID_HASH_KEY, otp:<номер>:<код>) — 32 байта, зависит и от номера, и от кода", async () => {
    const a = await otpCodeHash(KEY, PHONE, "123456");
    expect(a).toHaveLength(32);
    expect(await otpCodeHash(KEY, PHONE, "123456")).toEqual(a);
    expect(await otpCodeHash(KEY, PHONE, "123457")).not.toEqual(a);
    expect(await otpCodeHash(KEY, "+998001234568", "123456")).not.toEqual(a);
  });

  it("короткий ключ — ошибка настройки", async () => {
    await expect(otpCodeHash("short", PHONE, "123456")).rejects.toThrow();
  });
});

describe("otpSenderFor", () => {
  it("console — только в local", () => {
    expect(otpSenderFor({ APP_ENV: "local", OTP_PROVIDER: "console" })?.provider).toBe("console");
    expect(otpSenderFor({ APP_ENV: "staging", OTP_PROVIDER: "console" })).toBeNull();
    expect(otpSenderFor({ APP_ENV: "production", OTP_PROVIDER: "console" })).toBeNull();
  });

  it("tg_gateway — только с токеном", () => {
    expect(otpSenderFor({ APP_ENV: "production", OTP_PROVIDER: "tg_gateway" })).toBeNull();
    expect(
      otpSenderFor({ APP_ENV: "production", OTP_PROVIDER: "tg_gateway", TELEGRAM_GATEWAY_TOKEN: "" }),
    ).toBeNull();
    expect(
      otpSenderFor({ APP_ENV: "production", OTP_PROVIDER: "tg_gateway", TELEGRAM_GATEWAY_TOKEN: "t" })
        ?.provider,
    ).toBe("tg_gateway");
  });

  it("off и неизвестное — выключено", () => {
    expect(otpSenderFor({ APP_ENV: "local", OTP_PROVIDER: "off" })).toBeNull();
    expect(otpSenderFor({ APP_ENV: "local", OTP_PROVIDER: "eskiz" })).toBeNull();
  });
});

describe("consoleSender", () => {
  it("пишет код в лог, номер — только последние цифры", async () => {
    const log = vi.fn();
    expect(await consoleSender(log).send(PHONE, "123456", 600)).toBeNull();
    expect(log).toHaveBeenCalledWith("auth.otp: code (console provider)", {
      phone: maskPhone(PHONE),
      code: "123456",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("901234");
  });
});

describe("telegramGatewaySender", () => {
  it("sendVerificationMessage: свой код и срок, токен — в заголовке", async () => {
    const fetchFn = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({ ok: true, result: { request_id: "req-1", phone_number: PHONE, request_cost: 0.01 } }),
    );
    const sender = telegramGatewaySender("gw-token", fetchFn);
    expect(await sender.send(PHONE, "123456", 600)).toBe("req-1");
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe(`${TELEGRAM_GATEWAY_URL}/sendVerificationMessage`);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer gw-token");
    expect(JSON.parse(String(init?.body))).toEqual({ phone_number: PHONE, code: "123456", ttl: 600 });
  });

  it("отказ провайдера или сеть — OtpDeliveryError с причиной", async () => {
    const refused = telegramGatewaySender("t", async () =>
      Response.json({ ok: false, error: "PHONE_NUMBER_INVALID" }),
    );
    await expect(refused.send(PHONE, "123456", 600)).rejects.toMatchObject({
      name: "OtpDeliveryError",
      reason: "PHONE_NUMBER_INVALID",
    });
    const http = telegramGatewaySender("t", async () => new Response("nope", { status: 502 }));
    await expect(http.send(PHONE, "123456", 600)).rejects.toMatchObject({ reason: "http_502" });
    const offline = telegramGatewaySender("t", async () => {
      throw new TypeError("offline");
    });
    await expect(offline.send(PHONE, "123456", 600)).rejects.toBeInstanceOf(OtpDeliveryError);
  });

  it("без токена — ошибка настройки", () => {
    expect(() => telegramGatewaySender("")).toThrow();
  });
});
