import type { Dict } from "@bayramm/shared";
import type { ConsentText, ListingDetail, RequestCreated } from "@bayramm/shared/api";
import { type FormEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { isApiError, isNotFound } from "../api/errors";
import { Calendar } from "../components/Calendar";
import { Link } from "../components/Link";
import { Photo } from "../components/Photo";
import { Paragraphs } from "../components/RichText";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { TelegramCta } from "../components/TelegramCta";
import { canSignIn, pick, useDictionaries, useLang, useServices } from "../context";
import {
  addDays,
  formatDayMonth,
  formatPhone,
  formatPriceFrom,
  isIsoDate,
  PHONE_PREFIX,
  phoneDigits,
  tashkentToday,
  telHref,
  weekdayMon,
} from "../format";
import { useAsync, useDocumentTitle } from "../hooks";
import { Icon } from "../icons";
import { hrefFor, useNav } from "../router";
import { haptic } from "../telegram";
import { DATE_HORIZON_DAYS, MAX_GUESTS, parseGuests } from "./catalog-feed";
import {
  COMMENT_MAX,
  clearDraft,
  type Draft,
  EMPTY_DRAFT,
  FIELDS,
  type Field,
  loadDraft,
  NAME_MAX,
  saveDraft,
  toCreateRequest,
  validate,
} from "./request-draft";

const GUESTS_STEP = 20;

/** Текст ошибки отправки по коду API (контракт: ClientErrorCode) */
function sendErrorText(error: unknown, t: Dict, capMax: number): string {
  if (!isApiError(error)) return t.errSend;
  if (error.status === 401 || error.code === "no_session") return t.signInFailed;
  switch (error.code) {
    case "client_blocked":
      return t.errBlocked;
    case "daily_request_limit":
      return t.errDailyLimit;
    case "guests_over_capacity":
      return t.errGuestsMax(capMax);
    case "consent_text_not_current":
    case "consent_required":
      return t.errConsentOutdated;
    case "listing_not_active":
      return t.venueGoneP;
    default:
      return t.errSend;
  }
}

/** Поле формы: подпись, пометка «обязательно/по желанию», ошибка под полем */
function Fld({
  id,
  label,
  required,
  error,
  hint,
  children,
  group = false,
}: {
  id: string;
  label: string;
  required: boolean;
  error: string | undefined;
  hint?: string;
  children: ReactNode;
  group?: boolean;
}) {
  const { t } = useLang();
  const mark = <em className={required ? "mark-req" : "mark-opt"}>{required ? t.rqReq : t.rqOpt}</em>;
  const tail = (
    <>
      {hint ? (
        <p className="fld-hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="fld-error" id={`${id}-error`}>
          {error}
        </p>
      ) : null}
    </>
  );
  if (group)
    return (
      <fieldset className="fld" aria-describedby={error ? `${id}-error` : undefined}>
        <legend className="fld-label">
          {label} {mark}
        </legend>
        {children}
        {tail}
      </fieldset>
    );
  return (
    <div className="fld">
      <label className="fld-label" htmlFor={id}>
        {label} {mark}
      </label>
      {children}
      {tail}
    </div>
  );
}

function describedBy(id: string, error: string | undefined, hint?: boolean): string | undefined {
  const ids = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean);
  return ids.length ? ids.join(" ") : undefined;
}

/** Согласие: галочка не отмечена, полный текст раскрывается здесь же */
function Consent({
  id,
  text,
  label,
  checked,
  onChange,
  error,
}: {
  id: string;
  text: ConsentText;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  error?: string;
}) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  return (
    <div className={checked ? "consent on" : "consent"}>
      <label className="consent-check">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{label}</span>
      </label>
      <button
        type="button"
        className="link-btn"
        aria-expanded={open}
        aria-controls={`${id}-text`}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? t.consentHide : t.consentRead}
      </button>
      {open ? (
        <div className="consent-text" id={`${id}-text`}>
          <Paragraphs text={text.body} />
          <p className="muted small">{t.consentVersion(text.version)}</p>
        </div>
      ) : null}
      {error ? (
        <p className="fld-error" id={`${id}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Sent({ listing, created }: { listing: ListingDetail; created: RequestCreated }) {
  const { t } = useLang();
  const heading = useRef<HTMLHeadingElement>(null);
  useDocumentTitle(t.sentH);

  // Экран сменился без смены адреса: фокус и прокрутка — вручную (scrollTo есть не везде)
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    window.scrollTo?.(0, 0);
  }, []);

  return (
    <section className="screen sent">
      <span className="sent-icon" aria-hidden="true">
        <Icon name="checkFill" size={26} />
      </span>
      <h1 className="screen-title" tabIndex={-1} ref={heading}>
        {t.sentH}
      </h1>
      <p className="muted">
        {t.requestNo(created.publicNo)} · {listing.name}
      </p>
      <div className="callout callout-warn">
        <Icon name="warnD" size={20} />
        <p>{t.sentWarn}</p>
      </div>
      <a className="btn btn-primary wide" href={telHref(listing.phone)}>
        <Icon name="phone" size={17} />
        {t.sentCall} {formatPhone(listing.phone)}
      </a>
      <div className="callout">
        <Icon name="clockD" size={20} />
        <p>{t.sentTimer}</p>
      </div>
      <div className="two-buttons">
        <Link className="btn btn-secondary" href={hrefFor({ name: "requests" })}>
          {t.toMyRequests}
        </Link>
        <Link className="btn btn-secondary" href={hrefFor({ name: "catalog" })}>
          {t.sentSearch}
        </Link>
      </div>
    </section>
  );
}

interface FormProps {
  readonly listing: ListingDetail;
  readonly occasions: readonly { code: string; name: { ru: string; uz: string } }[];
  readonly consents: readonly ConsentText[];
  readonly onCreated: (created: RequestCreated) => void;
  readonly onConsentsOutdated: () => void;
}

function initialDraft(
  listing: ListingDetail,
  query: URLSearchParams,
  today: string,
  telegramName: string,
): Draft {
  const saved = loadDraft(listing.slug);
  if (saved) return saved;
  const date = query.get("date");
  const guests = parseGuests(query.get("guests"));
  return {
    ...EMPTY_DRAFT,
    date: isIsoDate(date) && date >= today && !listing.busyDates.includes(date) ? date : null,
    guests: guests === null ? "" : String(Math.min(guests, listing.capMax)),
    name: telegramName,
  };
}

function Form({ listing, occasions, consents, onCreated, onConsentsOutdated }: FormProps) {
  const { api, webApp, now } = useServices();
  const { t, lang } = useLang();
  const { query, navigate, back } = useNav();
  const today = tashkentToday(now());
  const busy = useMemo(() => new Set(listing.busyDates), [listing.busyDates]);
  const user = webApp?.initDataUnsafe.user;
  const telegramName = user ? [user.first_name, user.last_name].filter(Boolean).join(" ") : "";
  const [draft, setDraft] = useState<Draft>(() => initialDraft(listing, query, today, telegramName));
  const [transfer, setTransfer] = useState(false);
  const [notify, setNotify] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [dateOpen, setDateOpen] = useState(() => draft.date === null);
  const id = useId();
  const fieldId = (field: Field | "budget" | "comment") => `${id}-${field}`;

  const transferText = consents.find((c) => c.purpose === "request_transfer") ?? null;
  const notifyText = consents.find((c) => c.purpose === "bot_notifications") ?? null;

  // Другой текст (новая версия или другой язык) — согласие на него ещё не дано
  const transferId = transferText?.id;
  const notifyId = notifyText?.id;
  useEffect(() => {
    if (transferId) setTransfer(false);
  }, [transferId]);
  useEffect(() => {
    if (notifyId) setNotify(false);
  }, [notifyId]);
  const errors = submitted ? validate(draft, { listing, busy, today, transferChecked: transfer }, t) : {};
  const guests = parseGuests(draft.guests);
  const price = formatPriceFrom(listing.priceFromUzs, listing.priceUnit, t);

  const update = (patch: Partial<Draft>) => {
    setDraft((prev) => {
      const next = { ...prev, ...patch };
      saveDraft(listing.slug, next);
      return next;
    });
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (sending) return;
    setSubmitted(true);
    setSendError(null);
    const found = validate(draft, { listing, busy, today, transferChecked: transfer }, t);
    const first = FIELDS.find((field) => found[field]);
    if (first || !transferText) {
      haptic(webApp, "error");
      if (first === "date") setDateOpen(true);
      if (first) document.getElementById(fieldId(first))?.focus({ preventScroll: false });
      return;
    }
    setSending(true);
    try {
      const body = toCreateRequest(draft, listing, {
        transfer: transferText,
        notify: notify ? notifyText : null,
      });
      const result = await api.createRequest(body);
      clearDraft(listing.slug);
      haptic(webApp, "success");
      onCreated(result);
    } catch (error) {
      haptic(webApp, "error");
      if (isApiError(error) && error.status === 409 && error.existingId) {
        navigate(hrefFor({ name: "requests" }, { open: error.existingId }));
        return;
      }
      setSendError(sendErrorText(error, t, listing.capMax));
      // Текст согласия сменился на сервере: перечитываем, галочки ставятся заново
      if (isApiError(error) && error.code === "consent_text_not_current") onConsentsOutdated();
    } finally {
      setSending(false);
    }
  };

  const dateLabel = draft.date
    ? `${formatDayMonth(draft.date, t)}, ${t.weekdaysMon[weekdayMon(draft.date)] ?? ""}`
    : t.pickAny;

  return (
    <form className="screen request" onSubmit={onSubmit} noValidate>
      <h1 className="screen-title" tabIndex={-1}>
        {t.rqTitle}
      </h1>
      <div className="rq-who">
        <Photo photo={listing.cover} alt="" sizes="56px" className="rq-thumb" />
        <p>
          <b>{listing.name}</b>
          <span className="muted small">
            {price.amount}
            {price.unit ? ` ${price.unit}` : ""} · {t.people(listing.capMax)}
          </span>
        </p>
      </div>

      <Fld id={fieldId("occasion")} label={t.fOcc} required error={errors.occasion} group>
        <div className="choices">
          {occasions.map((occasion, i) => (
            <label key={occasion.code} className={draft.occasion === occasion.code ? "choice on" : "choice"}>
              <input
                id={i === 0 ? fieldId("occasion") : undefined}
                type="radio"
                name={`${id}-occasion`}
                value={occasion.code}
                checked={draft.occasion === occasion.code}
                onChange={() => update({ occasion: occasion.code })}
              />
              <span>{pick(occasion.name, lang)}</span>
            </label>
          ))}
        </div>
      </Fld>

      <Fld id={fieldId("date")} label={t.rqDate} required error={errors.date} group>
        <button
          id={fieldId("date")}
          type="button"
          className={draft.date ? "field-input field-button on" : "field-input field-button"}
          aria-expanded={dateOpen}
          aria-controls={`${id}-calendar`}
          aria-invalid={errors.date ? true : undefined}
          onClick={() => setDateOpen((open) => !open)}
        >
          <Icon name="calB" size={17} />
          <span>{dateLabel}</span>
          <Icon name={dateOpen ? "minus" : "caretDown"} size={12} />
        </button>
        {dateOpen ? (
          <div id={`${id}-calendar`}>
            <Calendar
              label={t.rqDate}
              min={today}
              max={addDays(today, DATE_HORIZON_DAYS)}
              busy={busy}
              selected={draft.date}
              onSelect={(date) => {
                update({ date });
                setDateOpen(false);
              }}
            />
          </div>
        ) : null}
      </Fld>

      <Fld
        id={fieldId("guests")}
        label={t.rqG}
        required
        error={errors.guests}
        hint={
          guests !== null && listing.capMin !== null && guests < listing.capMin && guests <= listing.capMax
            ? t.guestsBelowMin(listing.capMin)
            : t.people(listing.capMax)
        }
      >
        <div className="stepper">
          <button
            type="button"
            className="icon-btn"
            aria-label={`${t.rqG} −${GUESTS_STEP}`}
            onClick={() => update({ guests: String(Math.max(1, (guests ?? GUESTS_STEP) - GUESTS_STEP)) })}
          >
            <Icon name="minus" size={14} />
          </button>
          <input
            id={fieldId("guests")}
            className="field-input"
            type="number"
            inputMode="numeric"
            min={1}
            max={Math.min(MAX_GUESTS, listing.capMax)}
            value={draft.guests}
            aria-invalid={errors.guests ? true : undefined}
            aria-describedby={describedBy(fieldId("guests"), errors.guests, true)}
            onChange={(event) => update({ guests: event.target.value })}
          />
          <button
            type="button"
            className="icon-btn"
            aria-label={`${t.rqG} +${GUESTS_STEP}`}
            onClick={() => update({ guests: String(Math.min(listing.capMax, (guests ?? 0) + GUESTS_STEP)) })}
          >
            <Icon name="plus" size={14} />
          </button>
        </div>
      </Fld>

      <Fld id={fieldId("budget")} label={t.rqBud} required={false} error={undefined} group>
        <div className="choices">
          {t.budgets.map((label, i) => (
            <label key={label} className={draft.budget === i ? "choice on" : "choice"}>
              <input
                type="radio"
                name={`${id}-budget`}
                value={i}
                checked={draft.budget === i}
                onChange={() => update({ budget: i })}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </Fld>

      <Fld id={fieldId("name")} label={t.rqName} required error={errors.name}>
        <input
          id={fieldId("name")}
          className="field-input"
          type="text"
          autoComplete="name"
          maxLength={NAME_MAX}
          value={draft.name}
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={describedBy(fieldId("name"), errors.name)}
          onChange={(event) => update({ name: event.target.value })}
        />
      </Fld>

      <Fld id={fieldId("phone")} label={t.rqPhone} required error={errors.phone} hint={t.rqPhoneHint}>
        <div className="phone-input">
          <span aria-hidden="true">{PHONE_PREFIX}</span>
          <input
            id={fieldId("phone")}
            className="field-input"
            type="tel"
            inputMode="numeric"
            autoComplete="tel-national"
            placeholder="90 123 45 67"
            maxLength={20}
            value={draft.phone}
            aria-invalid={errors.phone ? true : undefined}
            aria-describedby={describedBy(fieldId("phone"), errors.phone, true)}
            onChange={(event) => update({ phone: event.target.value })}
            onBlur={() => {
              const digits = phoneDigits(draft.phone);
              if (digits.length === 9) update({ phone: formatPhone(`${PHONE_PREFIX}${digits}`).slice(5) });
            }}
          />
        </div>
      </Fld>

      <Fld id={fieldId("comment")} label={t.rqCom} required={false} error={undefined}>
        <textarea
          id={fieldId("comment")}
          className="field-input"
          rows={3}
          maxLength={COMMENT_MAX}
          placeholder={t.rqComPh}
          value={draft.comment}
          onChange={(event) => update({ comment: event.target.value })}
        />
      </Fld>

      <fieldset className="fld consents">
        <legend className="fld-label">{t.consentsTitle}</legend>
        {transferText ? (
          <Consent
            id={fieldId("consent")}
            text={transferText}
            label={t.consentTransfer(listing.name)}
            checked={transfer}
            onChange={setTransfer}
            error={errors.consent}
          />
        ) : (
          <p className="fld-error" role="alert">
            {t.consentMissing}
          </p>
        )}
        {notifyText ? (
          <Consent
            id={`${id}-notify`}
            text={notifyText}
            label={t.consentNotify}
            checked={notify}
            onChange={setNotify}
          />
        ) : null}
      </fieldset>

      {submitted && Object.keys(errors).length > 0 ? (
        <p className="form-error" role="alert">
          {t.errForm}
        </p>
      ) : null}
      {sendError ? (
        <p className="form-error" role="alert">
          {sendError}
        </p>
      ) : null}

      {/* Отказ и отправка — одного размера (правило продукта о согласии) */}
      <div className="action-bar form-bar">
        <button type="button" className="btn btn-secondary" onClick={back}>
          {t.permCancel}
        </button>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={sending || !transferText}
          aria-busy={sending}
        >
          {sending ? t.sending : t.rqSend}
        </button>
      </div>
      <p className="bar-note">{t.rqNote}</p>
    </form>
  );
}

function ContactCard({ listing }: { listing: ListingDetail }) {
  const { t } = useLang();
  const phone = formatPhone(listing.phone);
  return (
    <section className="section contact" aria-labelledby="guest-venue">
      <h2 className="section-title" id="guest-venue">
        {listing.name}
      </h2>
      <div className="contact-row">
        <a className="contact-phone" href={telHref(listing.phone)}>
          {phone}
        </a>
        <a className="btn btn-secondary" href={telHref(listing.phone)}>
          <Icon name="phone" size={17} />
          {t.sentCall}
        </a>
      </div>
      <p className="muted small">{t.callNote}</p>
    </section>
  );
}

export function RequestForm({ slug }: { slug: string }) {
  const { api, identity } = useServices();
  const { t, lang } = useLang();
  const { state: dicts } = useDictionaries();
  const listing = useAsync(`listing:${slug}`, (signal) => api.listing(slug, signal));
  // Итог — здесь, а не в форме: смена языка перезагружает тексты согласий и форму
  const [created, setCreated] = useState<RequestCreated | null>(null);
  const lastConsents = useRef<readonly ConsentText[] | null>(null);
  const signedIn = canSignIn(identity);
  const consents = useAsync(`consents:${lang}:${signedIn}`, (signal) =>
    signedIn ? api.consentTexts(lang, signal) : Promise.resolve({ items: [] }),
  );
  useDocumentTitle(t.rqTitle);

  // Вне Telegram заявку не отправить: объясняем и ведём в бота, телефон площадки — сразу
  if (!signedIn)
    return (
      <div className="screen">
        <TelegramCta slug={slug} headingLevel={1} />
        {listing.status === "ready" ? <ContactCard listing={listing.data} /> : null}
      </div>
    );

  if (created && listing.status === "ready") return <Sent listing={listing.data} created={created} />;
  if (listing.status === "error")
    return isNotFound(listing.error) ? (
      <EmptyState
        headingLevel={1}
        title={t.venueGoneH}
        text={t.venueGoneP}
        action={
          <Link className="btn btn-secondary" href={hrefFor({ name: "catalog" })}>
            {t.toCatalog}
          </Link>
        }
      />
    ) : (
      <ErrorState onRetry={listing.reload} />
    );
  if (dicts.status === "error") return <ErrorState onRetry={dicts.reload} />;
  if (consents.status === "error") return <ErrorState message={t.consentMissing} onRetry={consents.reload} />;
  // Пока тексты согласий перечитываются (смена языка, новая версия), форма остаётся на месте
  if (consents.status === "ready") lastConsents.current = consents.data.items;
  if (listing.status === "loading" || dicts.status === "loading" || !lastConsents.current) return <Loading />;

  return (
    <Form
      key={slug}
      listing={listing.data}
      occasions={dicts.data.occasions}
      consents={lastConsents.current}
      onCreated={setCreated}
      onConsentsOutdated={consents.reload}
    />
  );
}
