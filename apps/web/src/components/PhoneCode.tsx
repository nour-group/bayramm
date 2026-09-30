import type { Dict } from "@bayramm/shared";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { ApiError } from "../api/errors";
import { useLang, useServices } from "../context";
import { formatPhone, PHONE_PREFIX, phoneDigits } from "../format";

/* Вход и добавление телефона кодом из сообщения: номер → «Получить код» → код → «Войти».
   Код генерирует сервер и шлёт провайдер (Telegram Gateway); чаще раза в минуту не
   попросить, пять неверных попыток — код сгорает. Что делать с кодом, решает onCode:
   войти (хаб) или добавить телефон к аккаунту (профиль). */

/** Текст ошибки входа или кода по коду ответа API */
export function authErrorText(t: Dict, error: unknown): string {
  if (!(error instanceof ApiError)) return t.authErr;
  switch (error.code) {
    case "invalid_phone":
      return t.authErrPhone;
    case "otp_invalid":
      return t.authErrCode;
    case "otp_expired":
      return t.authErrExpired;
    case "otp_attempts":
      return t.authErrAttempts;
    case "otp_too_soon":
      return t.authErrTooSoon(error.retryAfter ?? 60);
    case "otp_limit":
    case "rate_limited":
      return t.authErrLimit;
    case "account_disabled":
    case "client_blocked":
      return t.authErrDisabled;
    case "phone_unavailable":
      return t.authErrPhoneOff;
    case "otp_delivery_failed":
      return t.authErrDelivery;
    case "identity_taken":
      return t.accErrTaken;
    case "identity_kind_taken":
      return t.accErrKindTaken;
    case "reauth_required":
      return t.authAgain;
    default:
      return t.authErr;
  }
}

interface PhoneCodeProps {
  /** Код введён: войти или добавить телефон. Ошибка — текст под полем, форма остаётся */
  readonly onCode: (phone: string, code: string) => Promise<void>;
  readonly submitLabel: string;
}

type Step =
  | { readonly kind: "phone" }
  | { readonly kind: "code"; readonly phone: string; readonly until: number };

export function PhoneCode({ onCode, submitLabel }: PhoneCodeProps) {
  const { api, now } = useServices();
  const { t } = useLang();
  const id = useId();
  const [step, setStep] = useState<Step>({ kind: "phone" });
  const [digits, setDigits] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const codeInput = useRef<HTMLInputElement>(null);

  // Обратный отсчёт до «Отправить код ещё раз»
  const waiting = step.kind === "code" ? Math.max(0, Math.ceil((step.until - now()) / 1000)) : 0;
  useEffect(() => {
    if (waiting <= 0) return;
    const timer = setTimeout(() => setTick((n) => n + 1), 1000);
    return () => clearTimeout(timer);
  }, [waiting]);

  const send = async (phone: string) => {
    setBusy(true);
    setError(null);
    try {
      const sent = await api.sendPhoneCode(phone);
      setStep({ kind: "code", phone, until: now() + sent.resendAfter * 1000 });
      setCode("");
      // Поле кода — после того как оно появилось на экране
      setTimeout(() => codeInput.current?.focus({ preventScroll: true }), 0);
    } catch (err) {
      setError(authErrorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  const onPhone = (event: FormEvent) => {
    event.preventDefault();
    const clean = phoneDigits(digits);
    if (clean.length !== 9) {
      setError(t.authErrPhone);
      return;
    }
    void send(`${PHONE_PREFIX}${clean}`);
  };

  const onSubmitCode = async (event: FormEvent) => {
    event.preventDefault();
    if (step.kind !== "code") return;
    const clean = code.replace(/\D/g, "");
    if (clean.length !== 6) {
      setError(t.authErrCode);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCode(step.phone, clean);
    } catch (err) {
      setError(authErrorText(t, err));
      setBusy(false);
      return;
    }
    setBusy(false);
  };

  if (step.kind === "phone") {
    return (
      <form className="phone-code" onSubmit={onPhone} noValidate>
        <div className="fld">
          <label className="fld-label" htmlFor={`${id}-phone`}>
            {t.authPhoneLabel}
          </label>
          <div className="phone-input">
            <span aria-hidden="true">{PHONE_PREFIX}</span>
            <input
              id={`${id}-phone`}
              className="field-input"
              type="tel"
              inputMode="numeric"
              autoComplete="tel-national"
              aria-label={t.authPhoneLabel}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-error` : undefined}
              value={digits}
              onChange={(event) => setDigits(event.target.value)}
            />
          </div>
        </div>
        {error ? (
          <p className="fld-error" id={`${id}-error`} role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" className="btn btn-secondary wide" disabled={busy}>
          {t.authSendCode}
        </button>
      </form>
    );
  }

  return (
    <form className="phone-code" onSubmit={onSubmitCode} noValidate>
      <p className="small" role="status">
        {t.authCodeSent(formatPhone(step.phone))}
      </p>
      <div className="fld">
        <label className="fld-label" htmlFor={`${id}-code`}>
          {t.authCodeLabel}
        </label>
        <input
          id={`${id}-code`}
          ref={codeInput}
          className="field-input code-input"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={7}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
      </div>
      {error ? (
        <p className="fld-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      ) : null}
      <button type="submit" className="btn btn-primary wide" disabled={busy}>
        {submitLabel}
      </button>
      <div className="phone-code-more">
        {waiting > 0 ? (
          <p className="muted small">{t.authResendIn(waiting)}</p>
        ) : (
          <button type="button" className="link-btn" disabled={busy} onClick={() => void send(step.phone)}>
            {t.authResend}
          </button>
        )}
        <button
          type="button"
          className="link-btn"
          disabled={busy}
          onClick={() => {
            setStep({ kind: "phone" });
            setError(null);
          }}
        >
          {t.authOtherPhone}
        </button>
      </div>
    </form>
  );
}
