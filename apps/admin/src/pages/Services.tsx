/* Услуги витрины в панели: список со статусами, новая услуга из каталога категории (и
   «другая услуга» со своим названием), правка, снять с витрины и вернуть, удалить.
   Каталог типов, единицы цены и шаблоны добавок — @bayramm/shared/categories; поля
   проверяются теми же правилами, что на сервере (serviceErrors), — ошибки подсвечиваются до
   отправки. Модератор и администратор заводят и правят сразу на витрину; менеджер — на
   проверку (у опубликованной витрины правка активной услуги — предложением).
   Услуга на проверке или с предложением изменений (от партнёра или менеджера, и у черновика
   тоже) — тому, кто решает по модерации, здесь же «Одобрить» и «Отклонить» с причиной для
   партнёра, как в очереди «Модерации» (ServiceDecision — один на оба места).
   Форма услуги — на месте, под списком: длинная, со своими списками выбора, в шторке ей
   тесно. Цена — с разрядами и «сум», единица одна — словами, две–четыре — пилюлями, минимум и
   срок — числами с «−» и «+»; у дополнения — единицы категории и шаблона. «Снять с витрины» —
   через подтверждение: услуга пропадёт у клиентов, цена «от» пересчитается.
   После любого действия витрина перечитывается: меняются цена «от» и готовность. */

import type { ListingDetail, ListingService } from "@bayramm/shared/api/staff";
import {
  type CategoryConfig,
  categoryPriceUnits,
  newOptionDraft,
  newServiceDraft,
  type OptionDraft,
  type PriceUnit,
  SERVICE_LIMITS,
  type ServiceDraft,
  serviceChangeRows,
  serviceDirty,
  serviceDraftOf,
  serviceErrors,
  serviceInput,
  serviceType,
  serviceTypeLabel,
} from "@bayramm/shared/categories";
import { ConfirmSheet, Select } from "@bayramm/ui/react";
import { type FormEvent, useId, useRef, useState } from "react";
import { type Failure, type Result, useCan, useSession } from "../api";
import { ru, unitName } from "../categories";
import { ChoiceField, MoneyField, NumberField } from "../fields";
import { formatPrice, formatSum } from "../format";
import { apiErrorText, t } from "../texts";
import { ConfirmForm, ErrorText, Field, focusSection, PhoneSheet, Pill, type Tone } from "../ui";
import { useUnsaved } from "../unsaved";

const STATUS_TONE: Record<ListingService["status"], Tone> = {
  draft: "muted",
  review: "outline",
  active: "good",
  rejected: "warn",
  paused: "muted",
};

/** Единицы цены дополнения: единицы категории и единица шаблона, если её там нет (как в кабинете) */
export function optionUnits(category: CategoryConfig, option: Pick<OptionDraft, "priceUnit">): PriceUnit[] {
  const units = categoryPriceUnits(category);
  return units.includes(option.priceUnit) ? units : [...units, option.priceUnit];
}

/** Строка услуги: цена и единица, минимум, срок */
function serviceFacts(service: ListingService): string {
  const parts = [formatPrice(service.priceUzs, service.priceUnit)];
  if (service.minQty !== null) parts.push(t.serviceMin(service.minQty, unitName(service.priceUnit)));
  if (service.leadDays !== null) parts.push(t.serviceLead(service.leadDays));
  return parts.join(" · ");
}

/** Значение поля предложения правки словами — «сейчас» и «предлагают» */
export function changeText(field: string, value: unknown): string {
  if (value === null || value === undefined) return t.none;
  switch (field) {
    case "priceUzs":
      return typeof value === "number" ? formatSum(value) : String(value);
    case "priceUnit":
      return unitName(value as PriceUnit);
    case "name":
    case "includes": {
      const text = value as { ru?: string; uz?: string };
      return [text.ru, text.uz].filter(Boolean).join(" / ") || t.none;
    }
    case "options": {
      const options = value as readonly ListingService["options"][number][];
      return options.length === 0
        ? t.none
        : options.map((o) => `${o.name.ru} — ${formatPrice(o.priceUzs, o.priceUnit)}`).join("; ");
    }
    default:
      return String(value);
  }
}

/** Предложение правки: поле — сейчас — предлагают */
export function ServiceChanges({ service }: { service: ListingService }) {
  const rows = serviceChangeRows(service);
  if (rows.length === 0) return null;
  return (
    <dl className="diff">
      {rows.map((row) => (
        <div key={row.field} className="diff-row">
          <dt>{t.serviceFields[row.field] ?? row.field}</dt>
          <dd>
            <span className="diff-before">
              <span className="visually-hidden">{t.serviceNow}: </span>
              {changeText(row.field, row.before)}
            </span>
            <span aria-hidden="true"> → </span>
            <span className="diff-after">
              <span className="visually-hidden">{t.serviceProposed}: </span>
              {changeText(row.field, row.after)}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Услуга ждёт решения: новая на проверке или с предложением изменений */
export const awaitsDecision = (service: ListingService) =>
  service.status === "review" || service.proposal !== null;

/**
 * Одобрить или отклонить услугу (новую или её изменения) — в очереди «Модерации» и на странице
 * витрины. Отказ — с причиной, её увидит партнёр (на телефоне — в шторке). approveClass —
 * класс кнопки «Одобрить»: очередь по нему ставит фокус на следующую услугу
 */
export function ServiceDecision({
  service,
  onDecided,
  approveClass,
}: {
  service: ListingService;
  onDecided: (outcome: "approved" | "declined") => void;
  approveClass?: string;
}) {
  const { api } = useSession();
  const [declining, setDeclining] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const declineButton = useRef<HTMLButtonElement>(null);
  const name = service.name.ru;

  const approve = async () => {
    setBusy(true);
    const result = await api.post<ListingService>(`/staff/services/${service.id}/approve`);
    setBusy(false);
    setFailure(result.ok ? null : result);
    if (result.ok) onDecided("approved");
  };
  const decline = async (reason: string): Promise<Failure | null> => {
    const result = await api.post<ListingService>(`/staff/services/${service.id}/decline`, { reason });
    if (!result.ok) return result;
    setDeclining(false);
    onDecided("declined");
    return null;
  };

  return (
    <>
      <div className="rcard-actions">
        <button
          type="button"
          className={`btn btn-primary${approveClass ? ` ${approveClass}` : ""}`}
          disabled={busy}
          onClick={() => void approve()}
        >
          {t.serviceApprove}
          <span className="visually-hidden">: {name}</span>
        </button>
        <button
          ref={declineButton}
          type="button"
          className="btn btn-danger"
          aria-expanded={declining}
          disabled={busy}
          onClick={() => setDeclining(!declining)}
        >
          {t.serviceDecline}
          <span className="visually-hidden">: {name}</span>
        </button>
      </div>
      {failure ? <ErrorText failure={failure} /> : null}
      <PhoneSheet
        open={declining}
        title={`${t.serviceDecline}: ${name}`}
        onClose={() => setDeclining(false)}
        returnFocus={declineButton}
      >
        <div className="rcard-actions">
          <ConfirmForm
            hint={t.serviceDeclineHint}
            label={t.reason}
            required
            danger
            presets={t.reasons.serviceDecline}
            submitLabel={t.serviceDecline}
            onSubmit={decline}
            onCancel={() => setDeclining(false)}
          />
        </div>
      </PhoneSheet>
    </>
  );
}

interface ServicesProps {
  listing: ListingDetail;
  category: CategoryConfig;
  /** После любого изменения — перечитать витрину: меняются цена «от» и готовность */
  onChanged: () => void;
}

type Editing = { readonly kind: "new" } | { readonly kind: "edit"; readonly service: ListingService };

export function Services({ listing, category, onChanged }: ServicesProps) {
  const { api } = useSession();
  const can = useCan();
  const editable = can("listings.write");
  // Решает по услугам тот, у кого право модерации (как очередь GET /staff/services)
  const decides = can("revisions.moderate");
  // Что решили здесь — строкой статуса: кнопки решения исчезли, фокус — на заголовке блока
  const [said, setSaid] = useState("");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [removing, setRemoving] = useState<ListingService | null>(null);
  const [removeFailure, setRemoveFailure] = useState<Failure | null>(null);
  // «Снять с витрины» — через подтверждение: услуга пропадёт у клиентов
  const [pausing, setPausing] = useState<ListingService | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const base = `/staff/listings/${listing.id}/services`;

  const act = async (service: ListingService, action: "pause" | "resume") => {
    setBusy(service.id);
    const result = await api.post<ListingService>(`${base}/${service.id}/${action}`);
    setBusy(null);
    setFailure(result.ok ? null : result);
    if (result.ok) onChanged();
    return result.ok;
  };

  const pause = async () => {
    if (!pausing) return;
    if (await act(pausing, "pause")) setPausing(null);
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(removing.id);
    const result = await api.del(`${base}/${removing.id}`);
    setBusy(null);
    setRemoveFailure(result.ok ? null : result);
    if (result.ok) {
      setRemoving(null);
      onChanged();
    }
  };

  const saved = () => {
    setEditing(null);
    onChanged();
  };

  const decided = (service: ListingService, outcome: "approved" | "declined") => {
    setSaid(
      outcome === "approved"
        ? t.serviceApprovedHere(service.name.ru)
        : t.serviceDeclinedHere(service.name.ru),
    );
    focusSection("services-title");
    onChanged();
  };

  return (
    <section className="panel" aria-labelledby="services-title">
      <div className="panel-head">
        <h2 id="services-title" tabIndex={-1}>
          {t.services} <span className="count">{listing.services.length}</span>
        </h2>
        {editable && editing === null ? (
          <button
            ref={addButton}
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setFailure(null);
              setEditing({ kind: "new" });
            }}
          >
            {t.serviceAdd}
          </button>
        ) : null}
      </div>
      <p className="muted small">{t.servicesHint}</p>
      <p className="visually-hidden" aria-live="polite">
        {said}
      </p>
      <p className="price-from">
        <span className="muted">{t.priceFromAuto}: </span>
        <strong>
          {listing.priceFromUzs === null
            ? t.priceFromNone
            : formatPrice(listing.priceFromUzs, listing.priceUnit)}
        </strong>
      </p>
      {editable ? (
        <p className="muted small">{can("revisions.moderate") ? t.servicesDecides : t.servicesManager}</p>
      ) : null}
      {editing?.kind === "new" ? (
        <ServiceForm
          listingId={listing.id}
          category={category}
          service={null}
          onSaved={saved}
          onCancel={() => setEditing(null)}
        />
      ) : null}
      {listing.services.length === 0 ? (
        <p className="muted">{t.servicesEmpty}</p>
      ) : (
        <ul className="cards services">
          {listing.services.map((service) => {
            const typeLabel = serviceTypeLabel("ru", category, service.type);
            if (editing?.kind === "edit" && editing.service.id === service.id) {
              return (
                <li key={service.id} className="card-row">
                  <ServiceForm
                    listingId={listing.id}
                    category={category}
                    service={service}
                    onSaved={saved}
                    onCancel={() => setEditing(null)}
                  />
                </li>
              );
            }
            return (
              <li key={service.id} className="card-row service-row">
                <div className="rcard-head">
                  <strong className="service-name">{service.name.ru}</strong>
                  <Pill tone={STATUS_TONE[service.status]}>{t.serviceStatus[service.status]}</Pill>
                </div>
                {service.customName ? <span className="sub">{typeLabel}</span> : null}
                <span className="sub">{serviceFacts(service)}</span>
                {service.options.length > 0 ? (
                  <span className="sub">
                    {t.serviceFields.options}:{" "}
                    {service.options
                      .map((o) => `${o.name.ru} — ${formatPrice(o.priceUzs, o.priceUnit)}`)
                      .join("; ")}
                  </span>
                ) : null}
                {service.decision?.outcome === "declined" && service.decision.reason ? (
                  <p className="reason">
                    {service.status === "rejected"
                      ? t.serviceDeclined(service.decision.reason)
                      : t.serviceProposalDeclined(service.decision.reason)}
                  </p>
                ) : null}
                {service.proposal ? (
                  <div className="notice notice-warn">
                    <p className="notice-title">{t.serviceProposal}</p>
                    <ServiceChanges service={service} />
                  </div>
                ) : null}
                {decides && awaitsDecision(service) ? (
                  <div className="notice notice-warn">
                    <p className="notice-title">{t.serviceWaits}</p>
                    <ServiceDecision service={service} onDecided={(outcome) => decided(service, outcome)} />
                  </div>
                ) : null}
                {editable ? (
                  <div className="acts">
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy !== null || editing !== null}
                      onClick={() => {
                        setFailure(null);
                        setEditing({ kind: "edit", service });
                      }}
                    >
                      {t.serviceEdit}
                      <span className="visually-hidden">: {service.name.ru}</span>
                    </button>
                    {service.status === "active" ? (
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busy !== null}
                        onClick={() => {
                          setFailure(null);
                          setPausing(service);
                        }}
                      >
                        {t.servicePause}
                        <span className="visually-hidden">: {service.name.ru}</span>
                      </button>
                    ) : null}
                    {service.status === "paused" ? (
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busy !== null}
                        onClick={() => void act(service, "resume")}
                      >
                        {t.serviceResume}
                        <span className="visually-hidden">: {service.name.ru}</span>
                      </button>
                    ) : null}
                    {service.status === "draft" || service.status === "rejected" ? (
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busy !== null}
                        onClick={() => void act(service, "resume")}
                      >
                        {t.serviceSubmit}
                        <span className="visually-hidden">: {service.name.ru}</span>
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      disabled={busy !== null}
                      onClick={() => {
                        setRemoveFailure(null);
                        setRemoving(service);
                      }}
                    >
                      {t.serviceDelete}
                      <span className="visually-hidden">: {service.name.ru}</span>
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {failure && <ErrorText failure={failure} />}
      <ConfirmSheet
        open={removing !== null}
        title={t.serviceDeleteTitle}
        text={removing ? `${removing.name.ru}. ${t.serviceDeleteHint}` : t.serviceDeleteHint}
        confirmLabel={t.serviceDelete}
        cancelLabel={t.cancel}
        tone="danger"
        busy={busy !== null}
        error={removeFailure ? apiErrorText(removeFailure.code) : undefined}
        onConfirm={() => void remove()}
        onCancel={() => setRemoving(null)}
      />
      <ConfirmSheet
        open={pausing !== null}
        title={t.servicePauseTitle}
        text={pausing ? t.servicePauseText(pausing.name.ru) : undefined}
        confirmLabel={t.servicePause}
        cancelLabel={t.cancel}
        tone="danger"
        busy={busy !== null}
        error={pausing && failure ? apiErrorText(failure.code) : undefined}
        onConfirm={() => void pause()}
        onCancel={() => {
          setPausing(null);
          setFailure(null);
        }}
      />
    </section>
  );
}

// ── форма услуги ───────────────────────────────────────────────────────────

interface ServiceFormProps {
  listingId: string;
  category: CategoryConfig;
  /** null — новая услуга */
  service: ListingService | null;
  onSaved: () => void;
  onCancel: () => void;
}

const invalid = (details: string[]): Failure => ({ ok: false, status: 422, code: "invalid_input", details });

/** Ошибка поля услуги: путь целиком (options.1.priceUzs) или поле верхнего уровня */
function errorOf(details: readonly string[], key: string): string | undefined {
  return details.includes(key) ? (t.serviceErrors[key] ?? t.attributeError) : undefined;
}

function ServiceForm({ listingId, category, service, onSaved, onCancel }: ServiceFormProps) {
  const { api } = useSession();
  const creating = service === null;
  const titleId = useId();
  const [before] = useState<ServiceDraft | null>(() => (service ? serviceDraftOf(service) : null));
  const [draft, setDraft] = useState<ServiceDraft | null>(before);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const details = failure?.code === "invalid_input" ? failure.details : [];
  const type = draft ? serviceType(category, draft.type) : undefined;
  const dirty = draft !== null && (before === null || serviceDirty(category, draft, before));
  useUnsaved(dirty);

  const patch = (next: Partial<ServiceDraft>) => setDraft((prev) => (prev ? { ...prev, ...next } : prev));
  const putOption = (key: string, next: Partial<OptionDraft>) =>
    setDraft((prev) =>
      prev ? { ...prev, options: prev.options.map((o) => (o.key === key ? { ...o, ...next } : o)) } : prev,
    );

  const pickType = (code: string) => {
    setFailure(null);
    setDraft(newServiceDraft(category, code) ?? null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft) {
      setFailure(invalid(["type"]));
      return;
    }
    const mode = { create: creating };
    const found = serviceErrors(category, draft, mode);
    if (found.length > 0) {
      setFailure(invalid(found));
      return;
    }
    setBusy(true);
    const body = serviceInput(category, draft, mode);
    const result: Result<ListingService> = creating
      ? await api.post<ListingService>(`/staff/listings/${listingId}/services`, body)
      : await api.patch<ListingService>(`/staff/listings/${listingId}/services/${service.id}`, body);
    setBusy(false);
    if (!result.ok) {
      setFailure(result);
      return;
    }
    onSaved();
  };

  const usedTemplates = new Set(draft?.options.map((o) => o.code).filter(Boolean));
  const templates = (type?.options ?? []).filter((o) => !usedTemplates.has(o.code));

  return (
    <form className="service-form" onSubmit={submit} noValidate aria-labelledby={titleId}>
      <h3 id={titleId} className="service-form-title">
        {creating ? t.serviceNew : t.serviceEditTitle(service.name.ru)}
      </h3>
      <div className="fields">
        {creating ? (
          <Field label={t.serviceAddFrom} error={errorOf(details, "type")} full>
            {(props) => (
              <Select
                {...props}
                className="input"
                label={t.serviceAddFrom}
                placeholder={t.serviceFields.type}
                value={draft?.type ?? null}
                onChange={pickType}
                options={category.services.map((s) => ({ value: s.code, label: ru(s.label) }))}
              />
            )}
          </Field>
        ) : null}
        {draft && type ? (
          <>
            {type.freeName ? (
              <>
                <Field label={t.serviceFields.nameRu ?? ""} error={errorOf(details, "name")}>
                  {(props) => (
                    <input
                      {...props}
                      className="input"
                      value={draft.nameRu}
                      maxLength={80}
                      autoComplete="off"
                      onChange={(event) => patch({ nameRu: event.target.value })}
                    />
                  )}
                </Field>
                <Field label={t.serviceFields.nameUz ?? ""} error={errorOf(details, "name")}>
                  {(props) => (
                    <input
                      {...props}
                      className="input"
                      lang="uz"
                      value={draft.nameUz}
                      maxLength={80}
                      autoComplete="off"
                      onChange={(event) => patch({ nameUz: event.target.value })}
                    />
                  )}
                </Field>
              </>
            ) : null}
            <MoneyField
              label={t.serviceFields.priceUzs ?? ""}
              value={draft.price}
              onChange={(price) => patch({ price })}
              max={SERVICE_LIMITS.maxPrice}
              error={errorOf(details, "priceUzs")}
            />
            {/* Единица одна — выбирать нечего: написано, за что цена; две–четыре — пилюлями */}
            {type.units.length === 1 ? (
              <div className="field">
                <span>{t.serviceFields.priceUnit}</span>
                <p className="svc-unit-fixed">{unitName(draft.priceUnit)}</p>
              </div>
            ) : type.units.length <= 4 ? (
              <ChoiceField
                label={t.serviceFields.priceUnit ?? ""}
                value={draft.priceUnit}
                options={type.units.map((unit) => ({ value: unit, label: unitName(unit) }))}
                onChange={(priceUnit) => patch({ priceUnit })}
                variant="pill"
                full={false}
                error={errorOf(details, "priceUnit")}
              />
            ) : (
              <Field label={t.serviceFields.priceUnit ?? ""} error={errorOf(details, "priceUnit")}>
                {(props) => (
                  <Select
                    {...props}
                    className="input"
                    label={t.serviceFields.priceUnit ?? ""}
                    value={draft.priceUnit}
                    onChange={(priceUnit) => patch({ priceUnit })}
                    options={type.units.map((unit) => ({ value: unit, label: unitName(unit) }))}
                  />
                )}
              </Field>
            )}
            <NumberField
              label={t.serviceMinQtyIn[draft.priceUnit] ?? t.serviceFields.minQty ?? ""}
              value={draft.minQty}
              onChange={(minQty) => patch({ minQty })}
              min={1}
              max={SERVICE_LIMITS.maxMinQty}
              error={errorOf(details, "minQty")}
              hint={t.serviceFields.minQtyHint}
            />
            <NumberField
              label={t.serviceFields.leadDays ?? ""}
              value={draft.leadDays}
              onChange={(leadDays) => patch({ leadDays })}
              min={0}
              max={SERVICE_LIMITS.maxLeadDays}
              error={errorOf(details, "leadDays")}
              hint={t.serviceFields.leadDaysHint}
            />
            {(["Ru", "Uz"] as const).map((lang) => (
              <Field
                key={lang}
                label={t.serviceFields[`includes${lang}`] ?? ""}
                error={errorOf(details, "includes")}
                full
              >
                {(props) => (
                  <textarea
                    {...props}
                    className="input"
                    lang={lang.toLowerCase()}
                    rows={2}
                    maxLength={1000}
                    value={lang === "Ru" ? draft.includesRu : draft.includesUz}
                    onChange={(event) =>
                      patch(
                        lang === "Ru"
                          ? { includesRu: event.target.value }
                          : { includesUz: event.target.value },
                      )
                    }
                  />
                )}
              </Field>
            ))}
          </>
        ) : null}
      </div>

      {draft && type ? (
        <fieldset className="svc-options">
          <legend>{t.serviceFields.options}</legend>
          <p className={details.includes("options") ? "field-error" : "field-hint"}>
            {details.includes("options") ? t.serviceErrors.options : t.optionsHint}
          </p>
          {draft.options.map((option, index) => {
            const at = `options.${index}`;
            const bad = (key: string) => details.includes(`${at}.${key}`) || details.includes(at);
            const title = t.optionN(index + 1);
            return (
              <section key={option.key} className="option-row" aria-label={title}>
                <p className="attr-item-title">{title}</p>
                <div className="fields">
                  <Field label={t.serviceFields.nameRu ?? ""} error={bad("name") ? t.optionError : undefined}>
                    {(props) => (
                      <input
                        {...props}
                        className="input"
                        value={option.nameRu}
                        maxLength={80}
                        autoComplete="off"
                        onChange={(event) => putOption(option.key, { nameRu: event.target.value })}
                      />
                    )}
                  </Field>
                  <Field label={t.serviceFields.nameUz ?? ""} error={bad("name") ? t.optionError : undefined}>
                    {(props) => (
                      <input
                        {...props}
                        className="input"
                        lang="uz"
                        value={option.nameUz}
                        maxLength={80}
                        autoComplete="off"
                        onChange={(event) => putOption(option.key, { nameUz: event.target.value })}
                      />
                    )}
                  </Field>
                  <MoneyField
                    label={t.serviceFields.priceUzs ?? ""}
                    value={option.price}
                    onChange={(price) => putOption(option.key, { price })}
                    max={SERVICE_LIMITS.maxPrice}
                    error={bad("priceUzs") ? t.serviceErrors.priceUzs : undefined}
                  />
                  <Field label={t.serviceFields.priceUnit ?? ""} hint={t.optionUnitsHint}>
                    {(props) => (
                      <Select
                        {...props}
                        className="input"
                        label={`${t.serviceFields.priceUnit ?? ""} · ${title}`}
                        value={option.priceUnit}
                        onChange={(priceUnit) => putOption(option.key, { priceUnit })}
                        options={optionUnits(category, option).map((unit) => ({
                          value: unit,
                          label: unitName(unit),
                        }))}
                      />
                    )}
                  </Field>
                </div>
                <div>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() =>
                      setDraft((prev) =>
                        prev ? { ...prev, options: prev.options.filter((o) => o.key !== option.key) } : prev,
                      )
                    }
                  >
                    {t.optionRemove}
                    <span className="visually-hidden">: {title}</span>
                  </button>
                </div>
              </section>
            );
          })}
          {draft.options.length < 10 ? (
            <div className="option-add">
              {templates.length > 0 ? (
                <Select
                  className="input"
                  size="compact"
                  label={t.optionFromCatalog}
                  placeholder={t.optionFromCatalog}
                  value={null}
                  onChange={(code) =>
                    setDraft((prev) =>
                      prev
                        ? { ...prev, options: [...prev.options, newOptionDraft(category, prev.type, code)] }
                        : prev,
                    )
                  }
                  options={templates.map((o) => ({ value: o.code, label: ru(o.label) }))}
                />
              ) : null}
              <button
                type="button"
                className="btn btn-sm"
                onClick={() =>
                  setDraft((prev) =>
                    prev
                      ? { ...prev, options: [...prev.options, newOptionDraft(category, prev.type)] }
                      : prev,
                  )
                }
              >
                {t.optionAdd}
              </button>
            </div>
          ) : null}
        </fieldset>
      ) : null}

      {failure && <ErrorText failure={failure} />}
      <div className="acts">
        <button type="submit" className="btn btn-primary" disabled={busy || (!creating && !dirty)}>
          {busy ? t.saving : creating ? t.serviceCreate : t.serviceSave}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          {t.cancel}
        </button>
      </div>
    </form>
  );
}
