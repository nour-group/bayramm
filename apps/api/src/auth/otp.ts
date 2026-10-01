// Вход по коду из сообщения на телефон.
//
// Код — 6 цифр, генерируем сами (crypto.getRandomValues), в базе — только
// HMAC(ID_HASH_KEY, "otp:<номер>:<код>"): без ключа по базе его не подобрать. Выдачу и
// проверку считает база (app.otp_issue, app.otp_check): не чаще раза в минуту и не
// больше трёх кодов за 10 минут на номер и на IP, пять попыток, 10 минут.
//
// Доставка — адаптер OtpSender:
//   · tg_gateway — Telegram Gateway: код приходит в приложение Telegram на этот номер;
//   · console    — код в лог воркера; только APP_ENV=local (разработка и тесты).
// Какой — переменная OTP_PROVIDER окружения. Провайдер не настроен (off, нет токена,
// console не в local) — вход по телефону в окружении выключен: 503 phone_unavailable.

import { idHmac } from "./crypto";

export const OTP_CODE_LENGTH = 6;
export const OTP_TTL_SECONDS = 10 * 60;
export const OTP_RESEND_SECONDS = 60;

export const TELEGRAM_GATEWAY_URL = "https://gatewayapi.telegram.org";
const GATEWAY_TIMEOUT_MS = 10_000;

export type OtpProvider = "console" | "tg_gateway";

export interface OtpSender {
  readonly provider: OtpProvider;
  /** Отправить код на номер (+998XXXXXXXXX). id сообщения у провайдера или null */
  send(phone: string, code: string, ttlSeconds: number): Promise<string | null>;
}

/** Провайдер не доставил код: причина — только в лог, наружу — 503 */
export class OtpDeliveryError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`OTP delivery failed: ${reason}`);
    this.name = "OtpDeliveryError";
    this.reason = reason;
  }
}

/** Номер в логе: только последние две цифры */
export const maskPhone = (phone: string) => `${phone.slice(0, 4)}•••••••${phone.slice(-2)}`;

/** Разработка и тесты: код — в лог воркера. Настоящим людям ничего не уходит */
export function consoleSender(log: (message: string, data: object) => void = console.info): OtpSender {
  return {
    provider: "console",
    async send(phone, code) {
      log("auth.otp: code (console provider)", { phone: maskPhone(phone), code });
      return null;
    },
  };
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Telegram Gateway: sendVerificationMessage со своим кодом и сроком жизни.
 * https://core.telegram.org/gateway/api — Authorization: Bearer <токен>
 */
export function telegramGatewaySender(
  token: string,
  fetchFn: Fetch = (input, init) => fetch(input, init),
  timeoutMs = GATEWAY_TIMEOUT_MS,
): OtpSender {
  if (token.length === 0) throw new Error("TELEGRAM_GATEWAY_TOKEN не задан");
  return {
    provider: "tg_gateway",
    async send(phone, code, ttlSeconds) {
      let res: Response;
      try {
        res = await fetchFn(`${TELEGRAM_GATEWAY_URL}/sendVerificationMessage`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ phone_number: phone, code, ttl: ttlSeconds }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new OtpDeliveryError(err instanceof Error ? err.name : "network");
      }
      const body = (await res.json().catch(() => null)) as {
        ok?: unknown;
        result?: { request_id?: unknown };
        error?: unknown;
      } | null;
      if (!res.ok || body?.ok !== true) {
        const error = typeof body?.error === "string" ? body.error.slice(0, 100) : `http_${res.status}`;
        throw new OtpDeliveryError(error);
      }
      const id = body.result?.request_id;
      return typeof id === "string" ? id.slice(0, 200) : null;
    },
  };
}

interface OtpEnv {
  APP_ENV: string;
  OTP_PROVIDER: string;
  TELEGRAM_GATEWAY_TOKEN?: string;
}

/** Адаптер окружения; null — вход по телефону выключен */
export function otpSenderFor(env: OtpEnv): OtpSender | null {
  switch (env.OTP_PROVIDER) {
    case "console":
      // Код в логе годится только для своей машины и тестов
      return env.APP_ENV === "local" ? consoleSender() : null;
    case "tg_gateway":
      return env.TELEGRAM_GATEWAY_TOKEN ? telegramGatewaySender(env.TELEGRAM_GATEWAY_TOKEN) : null;
    default:
      return null;
  }
}

/** 6 цифр, равномерно: байты ≥ 250 отбрасываются, чтобы не было перекоса к 0–5 */
export function generateOtpCode(): string {
  let code = "";
  while (code.length < OTP_CODE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(OTP_CODE_LENGTH * 2))) {
      if (byte < 250 && code.length < OTP_CODE_LENGTH) code += String(byte % 10);
    }
  }
  return code;
}

const CODE_RE = /^[0-9]{6}$/;

/** Код от человека: 6 цифр, пробелы и дефисы между ними допустимы; иначе null */
export function normalizeOtpCode(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 20) return null;
  const code = raw.replace(/[\s-]/g, "");
  return CODE_RE.test(code) ? code : null;
}

/** HMAC кода для базы: номер в нормальной форме, код — 6 цифр */
export function otpCodeHash(key: string, phone: string, code: string): Promise<Uint8Array> {
  return idHmac(key, `otp:${phone}:${code}`);
}
