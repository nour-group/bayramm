import type { Dict } from "@bayramm/shared";
import type {
  ConsentText,
  DictItem,
  ListingDetail,
  PublicService,
  RequestCreated,
} from "@bayramm/shared/api";
import {
  type CategoryConfig,
  categoryConfig,
  dayPartOf,
  hasDayParts,
  MAX_CHOSEN_SERVICES,
} from "@bayramm/shared/categories";
import { Checkbox, DateField, NumberStepper, RadioGroup, Select, TimeField } from "@bayramm/ui/react";
import { type FormEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { isApiError, isNotFound } from "../api/errors";
import { categoryName, catText, clientCategory } from "../categories";
import { useCalendarTexts } from "../components/Calendar";
import { categoryHref } from "../components/Categories";
import { Link } from "../components/Link";
import { Photo } from "../components/Photo";
import { Paragraphs } from "../components/RichText";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { TelegramCta } from "../components/TelegramCta";
import { canSignIn, pick, useDictionaries, useLang, useServices } from "../context";
import {
  addDays,
  formatDayMonth,
  formatMoney,
  formatPhone,
  formatPrice,
  formatPriceFrom,
  isIsoDate,
  maskPhoneDigits,
  metaLine,
  PHONE_PREFIX,
  phoneDigits,
  qtyQuestion,
  tashkentToday,
  telHref,
  weekdayMon,
} from "../format";
import { useAsync, useDocumentTitle } from "../hooks";
import { Icon } from "../icons";
import { hrefFor, useNav } from "../router";
import { haptic, requestWriteAccess } from "../telegram";
import { MAX_GUESTS, parseGuests } from "./catalog-feed";
import {
  budgetScale,
  COMMENT_MAX,
  clearDraft,
  type DetailField,
  type Draft,
  type DraftService,
  type DraftValue,
  detailFields,
  draftServiceIds,
  EMPTY_DRAFT,
  EVENT_MAX_DAYS_AHEAD,
  type Field,
  fieldOrder,
  fieldShown,
  firstDate,
  leadDaysOf,
  loadDraft,
  NAME_MAX,
  parseQty,
  saveDraft,
  servicesField,
  toCreateRequest,
  validate,
} from "./request-draft";
import { estimate, hasQty, suggestedQty } from "./request-estimate";
import { dayPartWindow } from "./venue-attributes";

const GUESTS_STEP = 20;

/** RadioGroup — у обязательного выбора из немногих вариантов; иначе — список с «не важно» */
const RADIO_MAX = 4;

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
    case "lead_time_too_short":
      return t.errLeadServer;
    case "date_busy":
      return t.errDateBusy;
    case "invalid_request":
      return t.errForm;
    default:
      return t.errSend;
  }
}

/** Поля из ответа 400/422 (details.hours, guests, eventDate…) — ошибки под полями формы */
function serverFieldErrors(
  error: unknown,
  draft: Draft,
  category: CategoryConfig,
  t: Dict,
): Partial<Record<Field, string>> {
  if (!isApiError(error)) return {};
  const out: Partial<Record<Field, string>> = {};
  if (error.code === "lead_time_too_short") out.date = t.errLeadServer;
  // Занятость сверил сервер (витрина во вкладке устарела): занят день или выбранная часть дня
  if (error.code === "date_busy") {
    if (error.details.includes("details.start_time")) {
      const start = draft.values.start_time;
      out["d.start_time"] =
        typeof start === "string" && start
          ? t.errPartBusy(t.dayPartName(dayPartOf(category, start)))
          : t.errInvalid;
    } else out.date = t.errDateBusy;
    return out;
  }
  for (const path of error.details) {
    const [head = "", key, index, sub] = path.split(".");
    if (head === "guests") out.guests = t.errGuests;
    else if (head === "eventDate") out.date ??= t.errDate;
    else if (head === "details" && key === "services") {
      const chosen = index === undefined ? undefined : draft.services[Number(index)];
      if (chosen && sub === "qty") out[`svc.${chosen.id}`] = t.errQty;
      else out.services = t.errServices;
    } else if (head === "details" && key) out[`d.${key}`] = t.errInvalid;
  }
  return out;
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

/** Согласие: галочка (Checkbox набора) не отмечена, полный текст раскрывается здесь же */
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
      <Checkbox
        id={id}
        className="consent-check"
        checked={checked}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={onChange}
      >
        {label}
      </Checkbox>
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
        <p>{t.sentConfirm}</p>
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
        {/* Дальше искать — в том же разделе, откуда пришли (кортеж → кортежи) */}
        <Link className="btn btn-secondary" href={categoryHref(listing.categoryCode)}>
          {t.sentSearch}
        </Link>
      </div>
    </section>
  );
}

/** Поле категории из её описания: число, да/нет, выбор, несколько, время, район */
function DetailInput({
  field,
  id,
  value,
  error,
  hint,
  districts,
  onChange,
}: {
  field: DetailField;
  id: string;
  value: DraftValue | undefined;
  error: string | undefined;
  hint?: string;
  districts: readonly DictItem[];
  onChange: (value: DraftValue) => void;
}) {
  const { t, lang } = useLang();
  const label = catText(lang, field.label);
  const aria = {
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy(id, error, Boolean(hint)),
  };
  switch (field.type) {
    case "int":
      return (
        <Fld id={id} label={label} required={field.required} error={error} hint={hint}>
          <NumberStepper
            id={id}
            min={field.min}
            max={field.max}
            decrementLabel={`${label} −1`}
            incrementLabel={`${label} +1`}
            maxLength={String(field.max).length}
            value={typeof value === "string" ? value : ""}
            onChange={onChange}
            {...aria}
          />
        </Fld>
      );
    case "bool":
      return (
        <div className="fld">
          <Checkbox id={id} checked={value === true} onChange={onChange} {...aria}>
            {label}
          </Checkbox>
          {error ? (
            <p className="fld-error" id={`${id}-error`}>
              {error}
            </p>
          ) : null}
        </div>
      );
    case "time":
      return (
        <Fld id={id} label={label} required={field.required} error={error} hint={hint}>
          <TimeField
            id={id}
            label={label}
            placeholder={t.timePh}
            value={typeof value === "string" && value ? value : null}
            onChange={onChange}
            {...aria}
          />
        </Fld>
      );
    case "district":
      return (
        <Fld id={id} label={label} required={field.required} error={error} hint={hint}>
          <Select
            id={id}
            label={label}
            placeholder={t.anyDistrict}
            value={typeof value === "string" ? value : ""}
            options={[
              ...(field.required ? [] : [{ value: "", label: t.anyGuestV }]),
              ...districts.map((d) => ({ value: d.code, label: pick(d.name, lang) })),
            ]}
            onChange={onChange}
            {...aria}
          />
        </Fld>
      );
    case "enum": {
      const options = field.options.map((o) => ({ value: o.code, label: catText(lang, o.label) }));
      if (field.required && options.length <= RADIO_MAX)
        return (
          <Fld id={id} label={label} required error={error} hint={hint} group>
            <RadioGroup
              id={id}
              name={id}
              value={typeof value === "string" && value ? value : null}
              options={options}
              onChange={onChange}
              {...aria}
            />
          </Fld>
        );
      return (
        <Fld id={id} label={label} required={field.required} error={error} hint={hint}>
          <Select
            id={id}
            label={label}
            placeholder={t.errChoose}
            value={typeof value === "string" ? value : field.required ? null : ""}
            options={[...(field.required ? [] : [{ value: "", label: t.anyGuestV }]), ...options]}
            onChange={onChange}
            {...aria}
          />
        </Fld>
      );
    }
    case "multi": {
      const codes = Array.isArray(value) ? value : [];
      return (
        <Fld id={id} label={label} required={field.required} error={error} hint={hint} group>
          <div className="checks">
            {field.options.map((option, i) => (
              <Checkbox
                key={option.code}
                id={i === 0 ? id : undefined}
                checked={codes.includes(option.code)}
                aria-invalid={error ? true : undefined}
                onChange={(on) =>
                  onChange(on ? [...codes, option.code] : codes.filter((code) => code !== option.code))
                }
              >
                {catText(lang, option.label)}
              </Checkbox>
            ))}
          </div>
        </Fld>
      );
    }
  }
}

/** Выбор услуги витрины: галочка, количество (у штучных единиц) и опции */
function ServicePick({
  service,
  chosen,
  pickId,
  qtyId,
  error,
  disabled,
  onToggle,
  onChange,
}: {
  service: PublicService;
  chosen: DraftService | undefined;
  /** id галочки: у первой услуги — id поля «услуги» (к нему фокус при ошибке выбора) */
  pickId: string;
  /** id поля количества: к нему фокус при ошибке количества */
  qtyId: string;
  error: string | undefined;
  disabled: boolean;
  onToggle: (on: boolean) => void;
  onChange: (next: DraftService) => void;
}) {
  const { t, lang } = useLang();
  const name = pick(service.name, lang);
  return (
    <li className={chosen ? "svc-choice on" : "svc-choice"}>
      <Checkbox id={pickId} checked={chosen !== undefined} disabled={disabled && !chosen} onChange={onToggle}>
        <span className="svc-choice-name">{name}</span>{" "}
        <span className="muted">{formatPrice(service.priceUzs, service.priceUnit, t)}</span>
      </Checkbox>
      {chosen ? (
        <div className="svc-choice-more">
          {hasQty(service.priceUnit) ? (
            <div className="field svc-qty">
              <label className="field-label" htmlFor={qtyId}>
                {qtyQuestion(service.priceUnit, t)}
                <span className="sr-only">: {name}</span>
              </label>
              <NumberStepper
                id={qtyId}
                min={service.minQty ?? 1}
                max={100_000}
                decrementLabel={`${qtyQuestion(service.priceUnit, t)} −1`}
                incrementLabel={`${qtyQuestion(service.priceUnit, t)} +1`}
                value={chosen.qty}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? `${qtyId}-error` : undefined}
                onChange={(qty) => onChange({ ...chosen, qty })}
              />
              {error ? (
                <p className="fld-error" id={`${qtyId}-error`}>
                  {error}
                </p>
              ) : null}
            </div>
          ) : null}
          {service.options.length > 0 ? (
            <fieldset className="svc-choice-options">
              <legend className="field-label">{t.svcOptions}</legend>
              {service.options.map((option) => (
                <Checkbox
                  key={option.id}
                  checked={chosen.options.includes(option.id)}
                  onChange={(on) =>
                    onChange({
                      ...chosen,
                      options: on
                        ? [...chosen.options, option.id]
                        : chosen.options.filter((o) => o !== option.id),
                    })
                  }
                >
                  {pick(option.name, lang)}{" "}
                  <span className="muted">+{formatPrice(option.priceUzs, option.priceUnit, t)}</span>
                </Checkbox>
              ))}
            </fieldset>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

interface FormProps {
  readonly listing: ListingDetail;
  readonly category: CategoryConfig;
  readonly occasions: readonly DictItem[];
  readonly districts: readonly DictItem[];
  readonly consents: readonly ConsentText[];
  readonly onCreated: (created: RequestCreated) => void;
  readonly onConsentsOutdated: () => void;
}

/** В черновике есть что-то кроме услуг, отмеченных на витрине: его заполняли в форме */
const touched = (draft: Draft): boolean =>
  draft.occasion !== null ||
  draft.date !== null ||
  draft.budget !== null ||
  [draft.guests, draft.name, draft.phone, draft.comment].some((v) => v.trim() !== "") ||
  Object.keys(draft.values).length > 0;

function initialDraft(
  listing: ListingDetail,
  category: CategoryConfig,
  query: URLSearchParams,
  today: string,
  telegramName: string,
): Draft {
  const saved = loadDraft(listing.slug);
  const date = query.get("date");
  const guests = parseGuests(query.get("guests"));
  // Черновик с формой: в нём уже всё; с витрины — только отмеченные услуги: дополняем
  if (saved && touched(saved)) return saved;
  const lead = leadDaysOf(listing, saved?.services.map((s) => s.id) ?? []);
  return {
    ...EMPTY_DRAFT,
    services: saved?.services ?? [],
    date:
      isIsoDate(date) && date >= firstDate(today, lead) && !listing.busyDates.includes(date) ? date : null,
    guests:
      guests === null || category.requestForm.guests === "hidden"
        ? ""
        : String(Math.min(guests, listing.capMax ?? MAX_GUESTS)),
    name: telegramName,
  };
}

function Form({
  listing,
  category,
  occasions,
  districts,
  consents,
  onCreated,
  onConsentsOutdated,
}: FormProps) {
  const { api, webApp, now } = useServices();
  const { t, lang } = useLang();
  const { query, navigate, back } = useNav();
  const today = tashkentToday(now());
  // Занятые дни витрины и те, что сервер назвал занятыми при отправке (витрина во вкладке устарела)
  const [lateBusy, setLateBusy] = useState<readonly string[]>([]);
  const busy = useMemo(() => new Set([...listing.busyDates, ...lateBusy]), [listing.busyDates, lateBusy]);
  const user = webApp?.initDataUnsafe.user;
  const telegramName = user ? [user.first_name, user.last_name].filter(Boolean).join(" ") : "";
  const [draft, setDraft] = useState<Draft>(() =>
    initialDraft(listing, category, query, today, telegramName),
  );
  const [transfer, setTransfer] = useState(false);
  const [notify, setNotify] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<Partial<Record<Field, string>>>({});
  const calendarTexts = useCalendarTexts();
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
  const context = { listing, category, busy, today, transferChecked: transfer };
  const errors = submitted ? { ...serverErrors, ...validate(draft, context, t) } : serverErrors;
  const guests = parseGuests(draft.guests);
  const price = formatPriceFrom(listing.priceFromUzs, listing.priceUnit, t);
  const guestsMode = category.requestForm.guests;
  const lead = leadDaysOf(
    listing,
    draft.services.map((s) => s.id),
  );
  const minDate = firstDate(today, lead);
  const svcField = servicesField(category);
  const scale = budgetScale(category);
  const budgetLabels = category.code === "hall" ? t.budgets : t.budgetsSmall;
  const chosenEstimate = estimate(
    listing.services,
    draft.services.map((s) => ({ id: s.id, qty: parseQty(s.qty), options: s.options })),
    guests,
  );

  const update = (patch: Partial<Draft>) => {
    setDraft((prev) => {
      const next = { ...prev, ...patch };
      saveDraft(listing.slug, next);
      return next;
    });
  };
  const setValue = (key: string, value: DraftValue) =>
    setDraft((prev) => {
      const values = { ...prev.values, [key]: value };
      // Самовывоз — району доставки не место
      if (key === "fulfillment" && value !== "delivery") delete values.delivery_district;
      const next = { ...prev, values };
      saveDraft(listing.slug, next);
      return next;
    });
  const setService = (service: PublicService, on: boolean) =>
    setDraft((prev) => {
      const services = on
        ? [...prev.services, { id: service.id, qty: suggestedQty(service, prev.values), options: [] }]
        : prev.services.filter((s) => s.id !== service.id);
      const next = { ...prev, services };
      saveDraft(listing.slug, next);
      return next;
    });
  const changeService = (next: DraftService) =>
    setDraft((prev) => {
      const draftNext = { ...prev, services: prev.services.map((s) => (s.id === next.id ? next : s)) };
      saveDraft(listing.slug, draftNext);
      return draftNext;
    });

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (sending) return;
    setSubmitted(true);
    setSendError(null);
    setServerErrors({});
    const found = validate(draft, context, t);
    const first = fieldOrder(category, draft).find((field) => found[field]);
    if (first || !transferText) {
      haptic(webApp, "error");
      if (first) document.getElementById(fieldId(first))?.focus({ preventScroll: false });
      return;
    }
    setSending(true);
    try {
      const body = toCreateRequest(draft, listing, category, {
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
        navigate(hrefFor({ name: "requests" }, { open: error.existingId, dup: 1 }));
        return;
      }
      setSendError(sendErrorText(error, t, listing.capMax ?? MAX_GUESTS));
      setServerErrors(serverFieldErrors(error, draft, category, t));
      // День занят целиком — в календаре формы он тоже станет занятым
      const sentDate = draft.date;
      if (isApiError(error) && error.code === "date_busy" && error.details.includes("eventDate") && sentDate)
        setLateBusy((days) => [...days, sentDate]);
      // Текст согласия сменился на сервере: перечитываем, галочки ставятся заново
      if (isApiError(error) && error.code === "consent_text_not_current") onConsentsOutdated();
    } finally {
      setSending(false);
    }
  };

  const dateLabel = (date: string) => `${formatDayMonth(date, t)}, ${t.weekdaysMon[weekdayMon(date)] ?? ""}`;
  // Подсказка у даты: срок заказа или что в этот день уже занято по частям
  const dateParts = draft.date ? (listing.busyParts.find((p) => p.date === draft.date)?.parts ?? []) : [];
  // Пришли с занятой датой (из каталога или витрины): её в форме нет — говорим почему
  const asked = query.get("date");
  const askedBusy = draft.date === null && isIsoDate(asked) && busy.has(asked) ? asked : null;
  const dateHint = askedBusy
    ? t.rqDateWasBusy(formatDayMonth(askedBusy, t))
    : lead > 0
      ? t.leadNoteFrom(lead, formatDayMonth(minDate, t))
      : hasDayParts(category) && dateParts.length > 0
        ? t.partsTaken(dateParts.map((part) => t.dayPartName(part)).join(", "))
        : undefined;
  const start = draft.values.start_time;
  const startHint =
    hasDayParts(category) && typeof start === "string" && start
      ? t.dayPartHint(
          t.dayPartName(dayPartOf(category, start)),
          dayPartWindow(category, dayPartOf(category, start)),
        )
      : undefined;

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
            {metaLine([
              `${price.amount}${price.unit ? ` ${price.unit}` : ""}`,
              listing.capMax === null
                ? categoryName(listing.categoryCode, t, lang)
                : t.people(listing.capMax),
            ])}
          </span>
        </p>
      </div>

      <Fld id={fieldId("occasion")} label={t.fOcc} required error={errors.occasion} group>
        <RadioGroup
          id={fieldId("occasion")}
          name={`${id}-occasion`}
          value={draft.occasion}
          options={occasions.map((occasion) => ({ value: occasion.code, label: pick(occasion.name, lang) }))}
          onChange={(occasion) => update({ occasion })}
        />
      </Fld>

      <Fld id={fieldId("date")} label={t.rqDate} required error={errors.date} hint={dateHint}>
        <DateField
          id={fieldId("date")}
          label={t.rqDate}
          placeholder={t.pickAny}
          value={draft.date}
          min={minDate}
          max={addDays(today, EVENT_MAX_DAYS_AHEAD)}
          busy={busy}
          format={dateLabel}
          texts={calendarTexts}
          aria-invalid={errors.date ? true : undefined}
          aria-describedby={describedBy(fieldId("date"), errors.date, Boolean(dateHint))}
          onChange={(date) => update({ date })}
        />
      </Fld>

      {guestsMode === "hidden" ? null : (
        <Fld
          id={fieldId("guests")}
          label={t.rqG}
          required={guestsMode === "required"}
          error={errors.guests}
          hint={
            listing.capMax === null
              ? undefined
              : guests !== null &&
                  listing.capMin !== null &&
                  guests < listing.capMin &&
                  guests <= listing.capMax
                ? t.guestsBelowMin(listing.capMin)
                : t.people(listing.capMax)
          }
        >
          <NumberStepper
            id={fieldId("guests")}
            min={1}
            max={Math.min(MAX_GUESTS, listing.capMax ?? MAX_GUESTS)}
            step={GUESTS_STEP}
            decrementLabel={`${t.rqG} −${GUESTS_STEP}`}
            incrementLabel={`${t.rqG} +${GUESTS_STEP}`}
            value={draft.guests}
            aria-invalid={errors.guests ? true : undefined}
            aria-describedby={describedBy(fieldId("guests"), errors.guests, listing.capMax !== null)}
            onChange={(value) => update({ guests: value })}
          />
        </Fld>
      )}

      {detailFields(category)
        .filter((field) => fieldShown(field, draft.values))
        .map((field) => (
          <DetailInput
            key={field.key}
            field={field}
            id={fieldId(`d.${field.key}`)}
            value={draft.values[field.key]}
            error={errors[`d.${field.key}`]}
            hint={field.key === "start_time" ? startHint : undefined}
            districts={districts}
            onChange={(value) => setValue(field.key, value)}
          />
        ))}

      {svcField && listing.services.length > 0 ? (
        <Fld
          id={fieldId("services")}
          label={catText(lang, svcField.label)}
          required={svcField.required}
          error={errors.services}
          group
        >
          <ul className="svc-choices">
            {listing.services.map((service, i) => (
              <ServicePick
                key={service.id}
                service={service}
                chosen={draft.services.find((s) => s.id === service.id)}
                pickId={i === 0 ? fieldId("services") : `${fieldId(`svc.${service.id}`)}-pick`}
                qtyId={fieldId(`svc.${service.id}`)}
                error={errors[`svc.${service.id}`]}
                disabled={draft.services.length >= MAX_CHOSEN_SERVICES}
                onToggle={(on) => setService(service, on)}
                onChange={changeService}
              />
            ))}
          </ul>
          {draft.services.length > 0 ? (
            <div className="estimate" aria-live="polite">
              <p className="estimate-sum">
                <span>{t.estimateH}</span>
                <b>
                  {chosenEstimate.counted > 0 ? t.estimateTotal(formatMoney(chosenEstimate.total, t)) : "—"}
                </b>
              </p>
              {chosenEstimate.needsGuests ? <p className="small">{t.estimateNeedsGuests}</p> : null}
              <p className="muted small">{t.estimateNote}</p>
            </div>
          ) : null}
        </Fld>
      ) : null}

      <Fld id={fieldId("budget")} label={t.rqBud} required={false} error={undefined} group>
        <RadioGroup
          name={`${id}-budget`}
          value={draft.budget === null ? null : String(draft.budget)}
          options={budgetLabels.slice(0, scale.length).map((label, i) => ({ value: String(i), label }))}
          onChange={(budget) => update({ budget: Number(budget) })}
        />
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
            onChange={(event) => update({ phone: maskPhoneDigits(phoneDigits(event.target.value)) })}
          />
        </div>
      </Fld>

      <Fld id={fieldId("comment")} label={t.rqCom} required={false} error={undefined}>
        <textarea
          id={fieldId("comment")}
          className="field-input"
          rows={3}
          maxLength={COMMENT_MAX}
          placeholder={category.code === "hall" ? t.rqComPh : t.rqComPhCat}
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
            onChange={(checked) => {
              setNotify(checked);
              // Без разрешения писать первым бот ответ вендора не пришлёт: спрашиваем сразу.
              // Отказал — уведомлений не будет, галочку снимаем
              if (checked)
                requestWriteAccess(webApp, (granted) => {
                  if (!granted) setNotify(false);
                });
            }}
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

      {/* Над кнопками: на телефоне панель прилипает к низу, пометка — в конце формы */}
      <p className="bar-note">{t.requestNote}</p>
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
    </form>
  );
}

/**
 * Гость ещё не вошёл: что уже выбрано — услуги с витрины, дата и гости из адреса. Войдёт на сайте
 * в этой вкладке (хаб вернёт сюда же) — всё это будет в форме: черновик живёт во вкладке
 */
function DraftSummary({ listing }: { listing: ListingDetail }) {
  const { now } = useServices();
  const { t, lang } = useLang();
  const { query } = useNav();
  const today = tashkentToday(now());
  const category = categoryConfig(listing.categoryCode) ?? clientCategory(listing.categoryCode);
  const date = query.get("date");
  const day = isIsoDate(date) && date > today && !listing.busyDates.includes(date) ? date : null;
  const guests = category.requestForm.guests === "hidden" ? null : parseGuests(query.get("guests"));
  const ids = draftServiceIds(listing.slug);
  const services = listing.services.filter((service) => ids.includes(service.id));
  if (day === null && guests === null && services.length === 0) return null;
  return (
    <section className="section" aria-labelledby="rq-draft">
      <h2 className="section-title" id="rq-draft">
        {t.rqDraftH}
      </h2>
      <dl className="facts">
        {day ? (
          <div>
            <dt>{t.rqDate}</dt>
            <dd>{formatDayMonth(day, t)}</dd>
          </div>
        ) : null}
        {guests !== null ? (
          <div>
            <dt>{t.rqG}</dt>
            <dd>{guests}</dd>
          </div>
        ) : null}
        {services.length > 0 ? (
          <div>
            <dt>{t.svcTitle}</dt>
            <dd>{services.map((service) => pick(service.name, lang)).join(", ")}</dd>
          </div>
        ) : null}
      </dl>
      <p className="muted small">{t.rqDraftNote}</p>
    </section>
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
  const listing = useAsync(
    `listing:${slug}`,
    (signal) => api.listing(slug, signal),
    () => api.peek?.listing(slug),
  );
  // Итог — здесь, а не в форме: смена языка перезагружает тексты согласий и форму
  const [created, setCreated] = useState<RequestCreated | null>(null);
  const lastConsents = useRef<readonly ConsentText[] | null>(null);
  const signedIn = canSignIn(identity);
  // Тексты согласий витрина уже попросила заранее (кэш вкладки) — форма без заглушки
  const consents = useAsync(
    `consents:${lang}:${signedIn}`,
    (signal) => (signedIn ? api.consentTexts(lang, signal) : Promise.resolve({ items: [] })),
    () => (signedIn ? api.peek?.consentTexts(lang) : undefined),
  );
  // Сервер сказал, что текст сменился: забыть кэш и перечитать — галочки ставятся заново
  const consentsOutdated = () => {
    api.peek?.forgetConsentTexts();
    consents.reload();
  };
  useDocumentTitle(t.rqTitle);

  // Вне Telegram заявку не отправить: объясняем и ведём в бота, телефон площадки — сразу
  if (!signedIn)
    return (
      <div className="screen">
        <TelegramCta slug={slug} headingLevel={1} />
        {listing.status === "ready" ? <DraftSummary listing={listing.data} /> : null}
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
  if (listing.status === "loading" || dicts.status === "loading" || !lastConsents.current)
    return <Loading screen />;

  const category = categoryConfig(listing.data.categoryCode) ?? clientCategory(listing.data.categoryCode);
  return (
    <Form
      key={slug}
      listing={listing.data}
      category={category}
      occasions={dicts.data.occasions}
      districts={dicts.data.districts}
      consents={lastConsents.current}
      onCreated={setCreated}
      onConsentsOutdated={consentsOutdated}
    />
  );
}
