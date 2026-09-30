import type { Dict } from "@bayramm/shared";
import type { AuthMethods } from "@bayramm/shared/api/account";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { ApiError } from "../api/errors";
import type { PhoneProof } from "../api/types";
import { useLang, useServices } from "../context";
import { formatPhone, PHONE_PREFIX, phoneDigits } from "../format";
import { HumanCheck, type HumanCheckHandle } from "./HumanCheck";

/* Вход и добавление телефона кодом из сообщения: номер → «Получить код» → код → «Войти».
   Код генерирует сервер и шлёт провайдер (Telegram Gateway); чаще раза в минуту не
   попросить, пять неверных попыток — код сгорает. Что делать с кодом, решает onCode:
   войти (хаб) или добавить телефон к аккаунту (профиль).

   Если в окружении включена проверка «не робот», код просит человек: в хабе — виджет
   Turnstile рядом с кнопкой (его токен одноразовый: после каждой отправки — новый), в
   Mini App — initData Telegram вместо виджета. */

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
    case "turnstile_required":
    case "turnstile_failed":
      return t.humanCheckFailed;
    case "turnstile_unavailable":
      return t.humanCheckOff;
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

/** Чем запрос кода докажет, что его шлёт человек */
export type HumanProof =
  | { readonly kind: "turnstile"; readonly siteKey: string }
  | { readonly kind: "initData"; readonly initData: string };

/**
 * Проверка «не робот» у кода на телефон: в Telegram — его initData, в браузере — виджет
 * Turnstile (если он включён в окружении: есть ключ виджета)
 */
export function humanProofFor(
  methods: Pick<AuthMethods, "turnstileSiteKey">,
  initData: string | undefined,
): HumanProof | null {
  if (methods.turnstileSiteKey === null) return null;
  if (initData) return { kind: "initData", initData };
  return { kind: "turnstile", siteKey: methods.turnstileSiteKey };
}

interface PhoneCodeProps {
  /** Код введён: войти или добавить телефон. Ошибка — текст под полем, форма остаётся */
  readonly onCode: (phone: string, code: string) => Promise<void>;
  readonly submitLabel: string;
  /** Проверка «не робот» у запроса кода; нет — не нужна (выключена в окружении) */
  readonly human?: HumanProof | null;
}

type Step =
  | { readonly kind: "phone" }
  | { readonly kind: "code"; readonly phone: string; readonly until: number };

export function PhoneCode({ onCode, submitLabel, human = null }: PhoneCodeProps) {
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
  const check = useRef<HumanCheckHandle>(null);
  const [token, setToken] = useState<string | null>(null);

  // Обратный отсчёт до «Отправить код ещё раз»
  const waiting = step.kind === "code" ? Math.max(0, Math.ceil((step.until - now()) / 1000)) : 0;
  useEffect(() => {
    if (waiting <= 0) return;
    const timer = setTimeout(() => setTick((n) => n + 1), 1000);
    return () => clearTimeout(timer);
  }, [waiting]);

  const send = async (phone: string) => {
    let proof: PhoneProof = {};
    if (human?.kind === "initData") proof = { initData: human.initData };
    if (human?.kind === "turnstile") {
      if (token === null) {
        setError(t.humanCheckWait);
        return;
      }
      proof = { turnstileToken: token };
    }
    setBusy(true);
    setError(null);
    try {
      const sent = await api.sendPhoneCode(phone, proof);
      setStep({ kind: "code", phone, until: now() + sent.resendAfter * 1000 });
      setCode("");
      // Поле кода — после того как оно появилось на экране
      setTimeout(() => codeInput.current?.focus({ preventScroll: true }), 0);
    } catch (err) {
      setError(authErrorText(t, err));
    } finally {
      // Токен Turnstile потрачен, чем бы ни кончилось: для следующей попытки — новый
      if (human?.kind === "turnstile") check.current?.reset();
      setBusy(false);
    }
  };

  const humanCheck =
    human?.kind === "turnstile" ? (
      <HumanCheck ref={check} siteKey={human.siteKey} onToken={setToken} />
    ) : null;

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
        {humanCheck}
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
      {/* Новый код — снова с проверкой: виджет появляется вместе с кнопкой «ещё раз» */}
      {waiting > 0 ? null : humanCheck}
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
