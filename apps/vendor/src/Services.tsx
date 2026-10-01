/* Раздел «Услуги»: услуги выбранной витрины — из каталога её категории (или «другая
   услуга» со своим названием на двух языках), с ценой и единицей, минимальным заказом,
   сроком подготовки, «что входит» и дополнениями. Клиент видит только одобренное командой:
   новая услуга уходит на проверку (или черновиком), правка услуги на витрине опубликованной
   карточки — предложением (proposal), до решения клиент видит прежнее. Цена «от» карточки
   считается из услуг — руками её не задают.

   Список — с состоянием каждой услуги (черновик, на проверке, на витрине, отклонена, снята;
   «изменения на проверке» — что было и что предложено) и причиной отказа. Менять — только
   владельцу кабинета; сотрудник площадки видит то же без кнопок. Форма проверяет поля теми
   же правилами, что сервер (serviceErrors), и подсвечивает те же пути, что назвал бы 422.
   Удалить, снять с витрины и отозвать изменения — через подтверждение.

   Форма — на месте списка (на телефоне длинная форма в шторке неудобна): заголовок формы
   получает фокус, «Отмена» и кнопка «Назад» Telegram возвращают к списку и к услуге. */

import type { Lang } from "@bayramm/shared";
import type {
  ListingService,
  ServiceInput,
  VendorListing,
  VendorListingRef,
  VendorRole,
} from "@bayramm/shared/api/vendor";
import {
  type CategoryConfig,
  categoryConfig,
  categoryPriceUnits,
  newOptionDraft,
  newServiceDraft,
  type OptionDraft,
  type PriceUnit,
  priceUnitLabel,
  SERVICE_LIMITS,
  type ServiceChangeRow,
  type ServiceDraft,
  serviceChangeRows,
  serviceDirty,
  serviceDraftOf,
  serviceErrors,
  serviceInput,
  serviceType,
  serviceTypeLabel,
} from "@bayramm/shared/categories";
import { ConfirmSheet, NumberStepper, RadioGroup, Select } from "@bayramm/ui/react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { ApiFailure, api } from "./api";
import { priceText } from "./category";
import { errorText } from "./errors";
import { formatMoney } from "./format";
import { fill, type VendorDict } from "./i18n";
import { Icon } from "./icons";
import { ListingPicker } from "./ListingPicker";
import { useBackButton } from "./telegram";
import { Empty, Heading, LoadError, Loading, type ScreenProps } from "./ui";
import { useLoad } from "./useLoad";

/** Карточка на проверке или опубликована: услугу на витрине партнёр меняет только предложением */
export function changesByProposal(listing: VendorListing, service: ListingService): boolean {
  return (
    ["review", "active", "suspended"].includes(listing.status) &&
    (service.status === "active" || service.status === "paused")
  );
}

/** Название услуги: у «другой» — вендора, у каталожной — из каталога */
const nameOf = (service: ListingService, lang: Lang) => service.name[lang] || service.name.ru;

const STATUS_TONE: Readonly<Record<ListingService["status"], string>> = {
  draft: "chip-off",
  review: "chip-wait",
  active: "chip-done",
  rejected: "chip-bad",
  paused: "chip-off",
};

// ── предложение правки: было → предлагают ─────────────────────────────────

function changeValue(row: ServiceChangeRow, which: "before" | "after", t: VendorDict, lang: Lang): string {
  const value = row[which];
  if (value === null || value === undefined) return "—";
  switch (row.field) {
    case "name": {
      const name = value as { ru: string; uz: string };
      return name[lang] || name.ru;
    }
    case "priceUzs":
      return formatMoney(value as number, t, lang);
    case "priceUnit":
      return priceUnitLabel(lang, value as PriceUnit);
    case "minQty":
    case "leadDays":
      return String(value);
    case "includes": {
      const text = value as { ru?: string; uz?: string };
      return text[lang] ?? text.ru ?? text.uz ?? "—";
    }
    case "options": {
      const options = value as ListingService["options"];
      return options.length === 0
        ? "—"
        : options.map((o) => `${o.name[lang]} — ${priceText(o.priceUzs, o.priceUnit, t, lang)}`).join("; ");
    }
  }
}

export function ChangeRows({ service, t, lang }: { service: ListingService; t: VendorDict; lang: Lang }) {
  const rows = serviceChangeRows(service);
  if (rows.length === 0) return null;
  return (
    <dl className="changes">
      {rows.map((row) => (
        <div key={row.field}>
          <dt>{t[`svcField_${row.field}`]}</dt>
          <dd>
            <span className="change-was">
              {t.svcNow}: {changeValue(row, "before", t, lang)}
            </span>
            <span className="change-now">
              {t.svcProposed}: {changeValue(row, "after", t, lang)}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ── услуга в списке ────────────────────────────────────────────────────────

type Confirm = "delete" | "pause" | "withdrawProposal";

interface CardProps {
  readonly service: ListingService;
  readonly listing: VendorListing;
  readonly category: CategoryConfig | undefined;
  readonly t: VendorDict;
  readonly lang: Lang;
  readonly owner: boolean;
  readonly busy: boolean;
  readonly onEdit: (service: ListingService) => void;
  readonly onAct: (service: ListingService, action: "submit" | "withdraw") => void;
  readonly onConfirm: (service: ListingService, what: Confirm, from: HTMLElement) => void;
}

function ServiceCard({
  service,
  listing,
  category,
  t,
  lang,
  owner,
  busy,
  onEdit,
  onAct,
  onConfirm,
}: CardProps) {
  const { status, proposal, decision } = service;
  const declined =
    decision?.outcome === "declined" && decision.reason && proposal === null ? decision.reason : null;
  const typeLabel = category ? serviceTypeLabel(lang, category, service.type) : service.type;
  const facts = [
    priceText(service.priceUzs, service.priceUnit, t, lang),
    service.minQty === null ? null : fill(t.svcMin, { n: service.minQty }),
    service.leadDays === null ? null : fill(t.svcLead, { n: service.leadDays }),
  ].filter((part): part is string => part !== null);
  const includes = service.includes?.[lang] ?? service.includes?.ru ?? null;
  const canSubmit = status === "draft" || status === "rejected" || status === "paused";
  const canDelete = status !== "active";

  return (
    <li className="svc" data-service={service.id}>
      <div className="svc-top">
        <div className="svc-title">
          <h3 className="svc-name" id={`svc-${service.id}`} tabIndex={-1}>
            {nameOf(service, lang)}
          </h3>
          {service.customName ? <p className="svc-type">{typeLabel}</p> : null}
        </div>
        <span className={`chip ${STATUS_TONE[status]}`}>{t[`svcSt_${status}`]}</span>
      </div>
      <p className="svc-facts">{facts.join(" · ")}</p>
      {includes ? <p className="svc-includes">{includes}</p> : null}
      {service.options.length > 0 ? (
        <ul className="svc-options">
          {service.options.map((option) => (
            <li key={option.id}>
              <span>+ {option.name[lang] || option.name.ru}</span>
              <span className="svc-option-price">
                {priceText(option.priceUzs, option.priceUnit, t, lang)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {proposal ? (
        <div className="notice svc-proposal">
          <p>
            <span className="chip chip-work">{t.svcProposal}</span>
          </p>
          <ChangeRows service={service} t={t} lang={lang} />
        </div>
      ) : null}
      {declined ? (
        <p className="notice svc-declined">
          {fill(status === "rejected" ? t.svcDeclined : t.svcProposalDeclined, { reason: declined })}
        </p>
      ) : null}
      {owner ? (
        <div className="actions svc-actions">
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => onEdit(service)}>
            {t.svcEdit}
          </button>
          {canSubmit ? (
            <button
              type="button"
              className="btn btn-dark"
              disabled={busy}
              onClick={() => onAct(service, "submit")}
            >
              {t.proposalSubmit}
            </button>
          ) : null}
          {status === "review" ? (
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => onAct(service, "withdraw")}
            >
              {t.svcToDraft}
            </button>
          ) : null}
          {proposal && status !== "review" ? (
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={(event) => onConfirm(service, "withdrawProposal", event.currentTarget)}
            >
              {t.svcWithdrawProposal}
            </button>
          ) : null}
          {status === "active" && !proposal && changesByProposal(listing, service) ? (
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={(event) => onConfirm(service, "pause", event.currentTarget)}
            >
              {t.svcPause}
            </button>
          ) : null}
          {canDelete ? (
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              aria-label={fill(t.svcDeleteLabel, { name: nameOf(service, lang) })}
              onClick={(event) => onConfirm(service, "delete", event.currentTarget)}
            >
              {t.svcDelete}
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

// ── форма услуги ───────────────────────────────────────────────────────────

/** Единицы цены для дополнения: единицы категории и единица шаблона, если её там нет */
function optionUnits(category: CategoryConfig, option: OptionDraft): PriceUnit[] {
  const units = categoryPriceUnits(category);
  return units.includes(option.priceUnit) ? units : [...units, option.priceUnit];
}

type FormNotice = "invalid" | "noChanges" | "tooMany" | "stale" | "ownerOnly" | "failed" | null;

interface EditorProps {
  readonly listing: VendorListing;
  readonly category: CategoryConfig;
  /** null — новая услуга */
  readonly service: ListingService | null;
  readonly t: VendorDict;
  readonly lang: Lang;
  readonly onDone: (saved: ListingService, how: "sent" | "saved") => void;
  /** Услугу успели изменить (409): форма закрывается, список перечитывается */
  readonly onStale: () => void;
  readonly onCancel: () => void;
}

function ServiceEditor({ listing, category, service, t, lang, onDone, onStale, onCancel }: EditorProps) {
  const id = useId();
  const create = service === null;
  const [draft, setDraft] = useState<ServiceDraft | null>(() => (service ? serviceDraftOf(service) : null));
  const [before] = useState<ServiceDraft | null>(() => (service ? serviceDraftOf(service) : null));
  const [invalid, setInvalid] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<FormNotice>(null);
  const [failedText, setFailedText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const title = useRef<HTMLHeadingElement>(null);
  const byProposal = service !== null && changesByProposal(listing, service);
  const type = draft ? serviceType(category, draft.type) : undefined;

  useEffect(() => {
    title.current?.focus({ preventScroll: true });
  }, []);
  // Кнопка «Назад» Telegram — та же «Отмена»; обработчик один на всё время формы, иначе
  // кнопка мигала бы на каждом нажатии клавиши
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  const back = useCallback(() => cancel.current(), []);
  useBackButton(back);

  const set = (patch: Partial<ServiceDraft>) => setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  const setOption = (key: string, patch: Partial<OptionDraft>) =>
    set({ options: (draft?.options ?? []).map((o) => (o.key === key ? { ...o, ...patch } : o)) });
  const bad = (path: string) => invalid.has(path);
  const badRow = (index: number) =>
    [...invalid].some((p) => p === `options.${index}` || p.startsWith(`options.${index}.`));

  const send = async (submit: boolean) => {
    if (!draft) {
      setInvalid(new Set(["type"]));
      setNotice("invalid");
      return;
    }
    setNotice(null);
    const errors = serviceErrors(category, draft, { create });
    if (errors.length > 0) {
      setInvalid(new Set(errors));
      setNotice("invalid");
      return;
    }
    setInvalid(new Set());
    // Ничего не изменили: отправить черновик на проверку можно и так, остальное — нечего слать
    const sendsDraft = submit && (service?.status === "draft" || service?.status === "rejected");
    if (!create && before && !serviceDirty(category, draft, before) && !sendsDraft) {
      setNotice("noChanges");
      return;
    }
    const body: ServiceInput = {
      ...serviceInput(category, draft, { create }),
      ...(submit ? {} : { submit: false }),
    };
    setBusy(true);
    try {
      const saved = service
        ? await api.updateService(listing.id, service.id, body)
        : await api.createService(listing.id, body);
      onDone(saved, submit ? "sent" : "saved");
    } catch (err) {
      if (!(err instanceof ApiFailure)) setNotice("failed");
      else if (err.code === "invalid_input" || err.code === "service_invalid") {
        setInvalid(new Set(err.details));
        setNotice("invalid");
      } else if (err.code === "no_changes") setNotice("noChanges");
      else if (err.code === "too_many_services") setNotice("tooMany");
      else if (err.code === "vendor_owner_required") setNotice("ownerOnly");
      else if (err.code === "illegal_transition" || err.code === "moderated_field_requires_revision") {
        setNotice("stale");
        onStale();
      } else {
        setFailedText(errorText(err, t));
        setNotice("failed");
      }
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void send(true);
  };

  const errorOf = (path: string, text: string) =>
    bad(path) ? (
      <p className="field-error" id={`${id}-${path}-error`}>
        {text}
      </p>
    ) : null;
  const described = (path: string) => (bad(path) ? `${id}-${path}-error` : undefined);

  const textField = (
    key: "nameRu" | "nameUz" | "includesRu" | "includesUz",
    label: string,
    path: string,
    multiline: boolean,
  ) => {
    if (!draft) return null;
    const common = {
      id: `${id}-${key}`,
      className: "field",
      value: draft[key],
      lang: key.endsWith("Uz") ? "uz" : "ru",
      "aria-invalid": bad(path) || undefined,
      "aria-describedby": described(path),
      onChange: (event: { target: { value: string } }) => set({ [key]: event.target.value }),
    };
    return (
      <div className="form-row">
        <label className="field-label" htmlFor={common.id}>
          {label}
        </label>
        {multiline ? (
          <textarea {...common} rows={3} maxLength={SERVICE_LIMITS.includesMax} />
        ) : (
          <input {...common} maxLength={SERVICE_LIMITS.nameMax} autoComplete="off" />
        )}
      </div>
    );
  };

  // Внутри <fieldset> с <legend>: имя группе даёт legend
  const unitControl = (
    units: readonly PriceUnit[],
    value: PriceUnit,
    onChange: (unit: PriceUnit) => void,
    path: string,
  ): ReactNode => {
    // Единица у типа одна — выбирать нечего: просто написано, за что цена
    if (units.length === 1) return <p className="svc-unit-fixed">{priceUnitLabel(lang, value)}</p>;
    return (
      <RadioGroup
        variant="pill"
        name={`${id}-${path}`}
        value={value}
        options={units.map((unit) => ({ value: unit, label: priceUnitLabel(lang, unit) }))}
        onChange={onChange}
        aria-invalid={bad(path) || undefined}
      />
    );
  };

  const notices: Record<Exclude<FormNotice, null>, string> = {
    invalid: t.proposalInvalid,
    noChanges: t.proposalNoChanges,
    tooMany: t.svcTooMany,
    stale: t.svcStale,
    ownerOnly: t.servicesMember,
    failed: failedText ?? t.actionFailed,
  };
  const templates = type?.options.filter((o) => !draft?.options.some((d) => d.code === o.code)) ?? [];
  const roomForOptions = (draft?.options.length ?? 0) < SERVICE_LIMITS.maxOptions;
  const draftable = create || service?.status === "draft" || service?.status === "rejected";

  return (
    <section className="panel svc-editor" aria-labelledby={`${id}-title`}>
      <h2 className="section-title" id={`${id}-title`} ref={title} tabIndex={-1}>
        {create ? t.serviceNew : t.serviceEditTitle}
      </h2>
      <form className="proposal-form" onSubmit={submit} noValidate>
        {create ? (
          <div className="form-row">
            <label className="field-label" htmlFor={`${id}-type`}>
              {t.serviceType}
            </label>
            <Select
              id={`${id}-type`}
              label={t.serviceType}
              placeholder={t.serviceTypePick}
              value={draft?.type ?? null}
              options={category.services.map((option) => ({
                value: option.code,
                label: serviceTypeLabel(lang, category, option.code),
                hint: option.units.map((unit) => priceUnitLabel(lang, unit)).join(", "),
              }))}
              onChange={(code) => {
                setInvalid(new Set());
                setNotice(null);
                setDraft(newServiceDraft(category, code) ?? null);
              }}
              aria-invalid={bad("type") || undefined}
              aria-describedby={described("type")}
            />
            {errorOf("type", t.svcPickType)}
            <p className="note">{t.serviceOtherHint}</p>
          </div>
        ) : (
          <p className="svc-type-fixed">
            <span className="field-label">{t.serviceType}</span>
            <strong>{serviceTypeLabel(lang, category, service.type)}</strong>
          </p>
        )}

        {draft && type ? (
          <>
            {type.freeName ? (
              <div className="form-grid">
                {textField("nameRu", t.packageNameRu, "name", false)}
                {textField("nameUz", t.packageNameUz, "name", false)}
                {errorOf("name", t.svcNameInvalid)}
              </div>
            ) : null}

            <div className="form-row">
              <label className="field-label" htmlFor={`${id}-price`}>
                {t.packagePrice}
              </label>
              <input
                id={`${id}-price`}
                className="field"
                inputMode="numeric"
                autoComplete="off"
                maxLength={16}
                value={draft.price}
                aria-invalid={bad("priceUzs") || undefined}
                aria-describedby={described("priceUzs")}
                onChange={(event) => set({ price: event.target.value })}
              />
              {errorOf("priceUzs", t.svcPriceInvalid)}
            </div>
            <fieldset className="choices">
              <legend className="field-label">{t.priceUnitLabel}</legend>
              {unitControl(type.units, draft.priceUnit, (unit) => set({ priceUnit: unit }), "priceUnit")}
              {errorOf("priceUnit", t.fieldInvalid)}
            </fieldset>

            <div className="form-grid">
              <div className="form-row">
                <label className="field-label" htmlFor={`${id}-min`}>
                  {t.serviceMinQty}
                </label>
                <NumberStepper
                  id={`${id}-min`}
                  value={draft.minQty}
                  min={1}
                  max={SERVICE_LIMITS.maxMinQty}
                  onChange={(value) => set({ minQty: value })}
                  decrementLabel={`${t.serviceMinQty}: ${t.capacityLess}`}
                  incrementLabel={`${t.serviceMinQty}: ${t.capacityMore}`}
                  aria-invalid={bad("minQty") || undefined}
                  aria-describedby={described("minQty") ?? `${id}-min-hint`}
                />
                <p className="note" id={`${id}-min-hint`}>
                  {t.serviceMinQtyHint}
                </p>
                {errorOf("minQty", t.fieldInvalid)}
              </div>
              <div className="form-row">
                <label className="field-label" htmlFor={`${id}-lead`}>
                  {t.serviceLeadDays}
                </label>
                <NumberStepper
                  id={`${id}-lead`}
                  value={draft.leadDays}
                  min={0}
                  max={SERVICE_LIMITS.maxLeadDays}
                  maxLength={3}
                  onChange={(value) => set({ leadDays: value })}
                  decrementLabel={`${t.serviceLeadDays}: ${t.capacityLess}`}
                  incrementLabel={`${t.serviceLeadDays}: ${t.capacityMore}`}
                  aria-invalid={bad("leadDays") || undefined}
                  aria-describedby={described("leadDays") ?? `${id}-lead-hint`}
                />
                <p className="note" id={`${id}-lead-hint`}>
                  {t.serviceLeadDaysHint}
                </p>
                {errorOf("leadDays", t.fieldInvalid)}
              </div>
            </div>

            <div className="form-grid">
              {textField("includesRu", t.serviceIncludesRu, "includes", true)}
              {textField("includesUz", t.serviceIncludesUz, "includes", true)}
              {errorOf("includes", t.fieldInvalid)}
            </div>

            <fieldset className="choices svc-option-list" aria-describedby={described("options")}>
              <legend className="panel-title">{t.serviceOptions}</legend>
              <p className="note">{t.serviceOptionsLead}</p>
              {errorOf("options", t.fieldInvalid)}
              {draft.options.map((option, index) => {
                const rowId = `${id}-opt-${option.key}`;
                const rowBad = badRow(index);
                return (
                  <div key={option.key} className={rowBad ? "package-row package-row-bad" : "package-row"}>
                    <p className="package-kind">{fill(t.optionTitle, { n: index + 1 })}</p>
                    <div className="form-grid">
                      <div className="form-row">
                        <label className="field-label" htmlFor={`${rowId}-ru`}>
                          {t.packageNameRu}
                        </label>
                        <input
                          id={`${rowId}-ru`}
                          className="field"
                          lang="ru"
                          maxLength={SERVICE_LIMITS.nameMax}
                          value={option.nameRu}
                          aria-invalid={bad(`options.${index}.name`) || undefined}
                          onChange={(event) => setOption(option.key, { nameRu: event.target.value })}
                        />
                      </div>
                      <div className="form-row">
                        <label className="field-label" htmlFor={`${rowId}-uz`}>
                          {t.packageNameUz}
                        </label>
                        <input
                          id={`${rowId}-uz`}
                          className="field"
                          lang="uz"
                          maxLength={SERVICE_LIMITS.nameMax}
                          value={option.nameUz}
                          aria-invalid={bad(`options.${index}.name`) || undefined}
                          onChange={(event) => setOption(option.key, { nameUz: event.target.value })}
                        />
                      </div>
                      <div className="form-row">
                        <label className="field-label" htmlFor={`${rowId}-price`}>
                          {t.packagePrice}
                        </label>
                        <input
                          id={`${rowId}-price`}
                          className="field"
                          inputMode="numeric"
                          maxLength={16}
                          value={option.price}
                          aria-invalid={bad(`options.${index}.priceUzs`) || undefined}
                          onChange={(event) => setOption(option.key, { price: event.target.value })}
                        />
                      </div>
                      <div className="form-row">
                        <label className="field-label" htmlFor={`${rowId}-unit`}>
                          {t.priceUnitLabel}
                        </label>
                        <Select
                          id={`${rowId}-unit`}
                          label={`${t.priceUnitLabel}: ${fill(t.optionTitle, { n: index + 1 })}`}
                          value={option.priceUnit}
                          options={optionUnits(category, option).map((unit) => ({
                            value: unit,
                            label: priceUnitLabel(lang, unit),
                          }))}
                          onChange={(unit) => setOption(option.key, { priceUnit: unit })}
                        />
                      </div>
                    </div>
                    {rowBad ? <p className="field-error">{t.fieldInvalid}</p> : null}
                    <button
                      type="button"
                      className="btn btn-ghost svc-option-remove"
                      onClick={() => set({ options: draft.options.filter((o) => o.key !== option.key) })}
                    >
                      {fill(t.optionRemove, { n: index + 1 })}
                    </button>
                  </div>
                );
              })}
              {roomForOptions ? (
                <div className="svc-option-add">
                  {templates.map((template) => {
                    const label = newOptionDraft(category, draft.type, template.code);
                    const name = lang === "uz" ? label.nameUz : label.nameRu;
                    return (
                      <button
                        key={template.code}
                        type="button"
                        className="btn btn-ghost"
                        aria-label={fill(t.optionAddFrom, { name })}
                        onClick={() =>
                          set({
                            options: [...draft.options, newOptionDraft(category, draft.type, template.code)],
                          })
                        }
                      >
                        <Icon name="plus" size={14} />
                        {name}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => set({ options: [...draft.options, newOptionDraft(category, draft.type)] })}
                  >
                    <Icon name="plus" size={14} />
                    {t.optionAdd}
                  </button>
                </div>
              ) : null}
            </fieldset>
          </>
        ) : null}

        {byProposal ? <p className="notice">{t.serviceProposalNote}</p> : null}
        {notice ? (
          <p className={notice === "noChanges" ? "note" : "form-error"} role="alert">
            {notices[notice]}
          </p>
        ) : null}
        <div className="actions">
          <button type="submit" className="btn btn-dark" disabled={busy}>
            {byProposal
              ? t.proposalStart
              : service?.status === "review" || (service && !draftable)
                ? t.serviceSave
                : t.proposalSubmit}
          </button>
          {draftable ? (
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void send(false)}>
              {t.serviceSaveDraft}
            </button>
          ) : null}
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={onCancel}>
            {t.cancel}
          </button>
        </div>
      </form>
    </section>
  );
}

// ── раздел целиком ─────────────────────────────────────────────────────────

interface ServicesProps extends ScreenProps {
  readonly listings: readonly VendorListingRef[];
  readonly listingId: string | null;
  readonly onListing: (id: string) => void;
  /** Услуги меняет только владелец кабинета */
  readonly role: VendorRole;
  /** Выбор витрины — в боковой панели (компьютер) */
  readonly inSidebar: boolean;
}

type Editing = { readonly id: string | null } | null;
type Message = { readonly text: string; readonly tone: "status" | "alert" } | null;

export function Services({
  t,
  lang,
  headingRef,
  listings,
  listingId,
  onListing,
  role,
  inSidebar,
}: ServicesProps) {
  const [listing, reload, setListing, refresh] = useLoad<VendorListing>(listingId, (key) => api.listing(key));
  const owner = role === "owner";
  const [editing, setEditing] = useState<Editing>(null);
  const [message, setMessage] = useState<Message>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ service: ListingService; what: Confirm } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const confirmFrom = useRef<HTMLElement | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const listTitle = useRef<HTMLHeadingElement>(null);
  // Куда перевести фокус после того, как список снова на экране: на услугу или кнопку
  const focusNext = useRef<string | "add" | "list" | null>(null);

  // Другая витрина — форма и сообщения прежней не переносятся
  // biome-ignore lint/correctness/useExhaustiveDependencies: сброс — по смене витрины
  useEffect(() => {
    setEditing(null);
    setMessage(null);
  }, [listingId]);

  useEffect(() => {
    const target = focusNext.current;
    if (target === null || editing !== null) return;
    focusNext.current = null;
    const el =
      target === "add"
        ? addButton.current
        : target === "list"
          ? listTitle.current
          : document.getElementById(`svc-${target}`);
    el?.focus({ preventScroll: true });
  });

  const quietly = useCallback(async () => {
    if (!(await refresh())) reload();
  }, [refresh, reload]);

  const replace = (saved: ListingService) =>
    setListing((current) => {
      const exists = current.services.some((s) => s.id === saved.id);
      return {
        ...current,
        services: exists
          ? current.services.map((s) => (s.id === saved.id ? saved : s))
          : [...current.services, saved],
      };
    });

  const failureText = (err: unknown): string => {
    if (!(err instanceof ApiFailure)) return t.actionFailed;
    if (err.code === "publish_blocked") return t.svcPublishBlocked;
    if (err.code === "illegal_transition") return t.svcStale;
    if (err.code === "vendor_owner_required") return t.servicesMember;
    return errorText(err, t);
  };

  const act = async (service: ListingService, action: "submit" | "withdraw") => {
    setBusyId(service.id);
    setMessage(null);
    try {
      const saved =
        action === "submit"
          ? await api.submitService(listingId ?? "", service.id)
          : await api.withdrawService(listingId ?? "", service.id);
      replace(saved);
      setMessage({ text: action === "submit" ? t.proposalSent : t.svcSaved, tone: "status" });
      focusNext.current = service.id;
      void quietly();
    } catch (err) {
      setMessage({ text: failureText(err), tone: "alert" });
      if (err instanceof ApiFailure && err.code === "illegal_transition") void quietly();
    } finally {
      setBusyId(null);
    }
  };

  const confirmed = async () => {
    if (!confirm || !listingId) return;
    const { service, what } = confirm;
    setConfirmBusy(true);
    setConfirmError(null);
    try {
      if (what === "delete") {
        await api.deleteService(listingId, service.id).catch((err: unknown) => {
          // Уже удалена (с другого устройства) — как удалена
          if (!(err instanceof ApiFailure && err.code === "not_found")) throw err;
        });
        setListing((current) => ({
          ...current,
          services: current.services.filter((s) => s.id !== service.id),
        }));
        focusNext.current = "list";
        confirmFrom.current = listTitle.current;
      } else {
        replace(await api.withdrawService(listingId, service.id));
        focusNext.current = service.id;
        confirmFrom.current = document.getElementById(`svc-${service.id}`);
      }
      setConfirm(null);
      setMessage({ text: t.svcSaved, tone: "status" });
      void quietly();
    } catch (err) {
      setConfirmError(failureText(err));
      if (err instanceof ApiFailure && err.code === "illegal_transition") void quietly();
    } finally {
      setConfirmBusy(false);
    }
  };

  if (listings.length === 0 || !listingId) {
    return (
      <section className="page" aria-labelledby="page-title">
        <Heading headingRef={headingRef}>{t.services}</Heading>
        <Empty icon="services" title={t.noListings} text={t.noListingsText} />
      </section>
    );
  }

  const ready = listing.state === "ready" ? listing.data : null;
  const category = ready ? categoryConfig(ready.categoryCode) : undefined;
  const editingService = editing?.id ? (ready?.services.find((s) => s.id === editing.id) ?? null) : null;
  const confirmTexts: Record<Confirm, { title: string; text: string; label: string }> = {
    delete: { title: t.svcDeleteQ, text: t.svcDeleteText, label: t.svcDelete },
    pause: { title: t.svcPauseQ, text: t.svcPauseText, label: t.svcPause },
    withdrawProposal: {
      title: t.proposalWithdrawQ,
      text: t.proposalWithdrawText,
      label: t.svcWithdrawProposal,
    },
  };

  return (
    <section className="page page-services" aria-labelledby="page-title">
      <Heading headingRef={headingRef}>{t.services}</Heading>
      <ListingPicker
        listings={listings}
        value={listingId}
        onChange={(id) => id && onListing(id)}
        t={t}
        lang={lang}
        inSidebar={inSidebar}
      />
      <p className="promise">
        <Icon name="info" size={17} />
        <span>{owner ? t.servicesLead : `${t.servicesLead} ${t.servicesMember}`}</span>
      </p>

      {listing.state === "loading" ? <Loading t={t} kind="list" /> : null}
      {listing.state === "error" ? <LoadError t={t} onRetry={reload} error={listing.error} /> : null}
      {ready && editing && category ? (
        <ServiceEditor
          key={editing.id ?? "new"}
          listing={ready}
          category={category}
          service={editingService}
          t={t}
          lang={lang}
          onDone={(saved, how) => {
            replace(saved);
            setMessage({
              text: how === "saved" ? t.svcSaved : t.proposalSent,
              tone: "status",
            });
            focusNext.current = saved.id;
            setEditing(null);
            void quietly();
          }}
          onStale={() => void quietly()}
          onCancel={() => {
            focusNext.current = editing.id ?? "add";
            setEditing(null);
          }}
        />
      ) : null}
      {ready && !editing ? (
        <>
          {message ? (
            <p className={message.tone === "alert" ? "form-error" : "note"} role={message.tone}>
              {message.text}
            </p>
          ) : null}
          <div className="svc-head">
            <h2 className="section-title" ref={listTitle} tabIndex={-1}>
              {t.servicesSummary} <span className="count">{ready.services.length}</span>
            </h2>
            {owner && category ? (
              <button
                ref={addButton}
                type="button"
                className="btn btn-dark"
                disabled={ready.services.length >= SERVICE_LIMITS.maxServices}
                onClick={() => {
                  setMessage(null);
                  setEditing({ id: null });
                }}
              >
                <Icon name="plus" size={14} />
                {t.serviceAdd}
              </button>
            ) : null}
          </div>
          {ready.services.length >= SERVICE_LIMITS.maxServices && owner ? (
            <p className="note">{t.svcTooMany}</p>
          ) : null}
          {ready.services.length === 0 ? (
            <Empty
              icon="services"
              title={t.servicesEmpty}
              text={owner ? t.servicesEmptyText : t.servicesEmptyMember}
            />
          ) : (
            <ul className="svc-list">
              {ready.services.map((service) => (
                <ServiceCard
                  key={service.id}
                  service={service}
                  listing={ready}
                  category={category}
                  t={t}
                  lang={lang}
                  owner={owner}
                  busy={busyId === service.id}
                  onEdit={(picked) => {
                    setMessage(null);
                    setEditing({ id: picked.id });
                  }}
                  onAct={(picked, action) => void act(picked, action)}
                  onConfirm={(picked, what, from) => {
                    confirmFrom.current = from;
                    setConfirmError(null);
                    setConfirm({ service: picked, what });
                  }}
                />
              ))}
            </ul>
          )}
        </>
      ) : null}
      {confirm ? (
        <ConfirmSheet
          open
          title={confirmTexts[confirm.what].title}
          text={confirmTexts[confirm.what].text}
          confirmLabel={confirmTexts[confirm.what].label}
          cancelLabel={t.cancel}
          tone="danger"
          busy={confirmBusy}
          error={confirmError ?? undefined}
          onConfirm={() => void confirmed()}
          onCancel={() => setConfirm(null)}
          returnFocus={confirmFrom}
        />
      ) : null}
    </section>
  );
}
