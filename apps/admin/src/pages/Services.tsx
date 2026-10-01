/* Услуги витрины в панели: список со статусами, новая услуга из каталога категории (и
   «другая услуга» со своим названием), правка, снять с витрины и вернуть, удалить.
   Каталог типов, единицы цены и шаблоны добавок — @bayramm/shared/categories; поля
   проверяются теми же правилами, что на сервере (serviceErrors), — ошибки подсвечиваются до
   отправки. Модератор и администратор заводят и правят сразу на витрину; менеджер — на
   проверку (у опубликованной витрины правка активной услуги — предложением).
   Форма услуги — на месте, под списком: длинная, со своими списками выбора, в шторке ей
   тесно. После любого действия витрина перечитывается: меняются цена «от» и готовность. */

import type { ListingDetail, ListingService } from "@bayramm/shared/api/staff";
import {
  type CategoryConfig,
  newOptionDraft,
  newServiceDraft,
  type OptionDraft,
  PRICE_UNITS,
  type PriceUnit,
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
import { formatPrice, formatSum } from "../format";
import { apiErrorText, t } from "../texts";
import { ErrorText, Field, Pill, type Tone } from "../ui";
import { useUnsaved } from "../unsaved";

const STATUS_TONE: Record<ListingService["status"], Tone> = {
  draft: "muted",
  review: "outline",
  active: "good",
  rejected: "warn",
  paused: "muted",
};

const ALL_UNITS: readonly PriceUnit[] = PRICE_UNITS;

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
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [removing, setRemoving] = useState<ListingService | null>(null);
  const [removeFailure, setRemoveFailure] = useState<Failure | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const base = `/staff/listings/${listing.id}/services`;

  const act = async (service: ListingService, action: "pause" | "resume") => {
    setBusy(service.id);
    const result = await api.post<ListingService>(`${base}/${service.id}/${action}`);
    setBusy(null);
    setFailure(result.ok ? null : result);
    if (result.ok) onChanged();
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
                        onClick={() => void act(service, "pause")}
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
            <Field label={t.serviceFields.priceUzs ?? ""} error={errorOf(details, "priceUzs")}>
              {(props) => (
                <input
                  {...props}
                  className="input"
                  inputMode="numeric"
                  value={draft.price}
                  maxLength={16}
                  autoComplete="off"
                  enterKeyHint="done"
                  onChange={(event) => patch({ price: event.target.value })}
                />
              )}
            </Field>
            <Field label={t.serviceFields.priceUnit ?? ""} error={errorOf(details, "priceUnit")}>
              {(props) => (
                <Select
                  {...props}
                  className="input"
                  label={t.serviceFields.priceUnit ?? ""}
                  value={draft.priceUnit}
                  disabled={type.units.length < 2}
                  onChange={(priceUnit) => patch({ priceUnit })}
                  options={type.units.map((unit) => ({ value: unit, label: unitName(unit) }))}
                />
              )}
            </Field>
            <Field
              label={t.serviceFields.minQty ?? ""}
              error={errorOf(details, "minQty")}
              hint={t.serviceFields.minQtyHint}
            >
              {(props) => (
                <input
                  {...props}
                  className="input"
                  inputMode="numeric"
                  value={draft.minQty}
                  maxLength={6}
                  autoComplete="off"
                  onChange={(event) => patch({ minQty: event.target.value })}
                />
              )}
            </Field>
            <Field
              label={t.serviceFields.leadDays ?? ""}
              error={errorOf(details, "leadDays")}
              hint={t.serviceFields.leadDaysHint}
            >
              {(props) => (
                <input
                  {...props}
                  className="input"
                  inputMode="numeric"
                  value={draft.leadDays}
                  maxLength={3}
                  autoComplete="off"
                  onChange={(event) => patch({ leadDays: event.target.value })}
                />
              )}
            </Field>
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
                  <Field
                    label={t.serviceFields.priceUzs ?? ""}
                    error={bad("priceUzs") ? t.serviceErrors.priceUzs : undefined}
                  >
                    {(props) => (
                      <input
                        {...props}
                        className="input"
                        inputMode="numeric"
                        value={option.price}
                        maxLength={16}
                        autoComplete="off"
                        onChange={(event) => putOption(option.key, { price: event.target.value })}
                      />
                    )}
                  </Field>
                  <Field label={t.serviceFields.priceUnit ?? ""}>
                    {(props) => (
                      <Select
                        {...props}
                        className="input"
                        label={`${t.serviceFields.priceUnit ?? ""} · ${title}`}
                        value={option.priceUnit}
                        onChange={(priceUnit) => putOption(option.key, { priceUnit })}
                        options={ALL_UNITS.map((unit) => ({ value: unit, label: unitName(unit) }))}
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
