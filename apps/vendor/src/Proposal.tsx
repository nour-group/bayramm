/* Изменения карточки: партнёр предлагает новое название, цену, описания и пакеты, команда
   Bayramm проверяет (панель → «Модерация»). Клиенты видят одобренную карточку, пока
   предложение ждёт решения. Одно открытое предложение на площадку: пока оно на проверке —
   его видно здесь, его можно отозвать; решение (одобрено или отказ с причиной) — тоже здесь.

   Предлагать и отзывать может только владелец кабинета: сотрудник площадки видит, что
   предложено и что решили, но без формы и кнопок. Предложение, которое внёс менеджер Bayramm
   (byTeam), партнёр не отзывает — по нему решает модератор.

   В предложение уходят только изменённые поля; ничего не изменили — запроса нет. Проверка
   полей — на сервере (те же правила, что при решении); неверные поля подсвечиваются. Цена
   обязательна: пустой или «по запросу» не отправляется. Контролы — из @bayramm/ui/react. */

import type {
  ListingRevisionPayload,
  PriceUnit,
  RevisionPackage,
  VendorListing,
  VendorRevision,
  VendorRevisionList,
} from "@bayramm/shared/api/vendor";
import { DESCRIPTION_MAX, MAX_REVISION_PACKAGES } from "@bayramm/shared/api/vendor";
import { ConfirmSheet, RadioGroup } from "@bayramm/ui/react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { ApiFailure, api } from "./api";
import { formatMoment, formatMoney, groupDigits } from "./format";
import { fill, textOf, type VendorDict, vendorDict } from "./i18n";
import { LoadError, Loading } from "./ui";
import { useLoad } from "./useLoad";

type PackageKind = RevisionPackage["kind"];

interface PackageRow {
  readonly key: number;
  readonly kind: PackageKind;
  readonly nameRu: string;
  readonly nameUz: string;
  readonly price: string;
  readonly priceUnit: PriceUnit;
}

interface Values {
  readonly name: string;
  readonly price: string;
  readonly priceUnit: PriceUnit;
  readonly descriptionRu: string;
  readonly descriptionUz: string;
}

/** Поле формы → ключ правки (и имя в details ответа 422) */
const FIELD_KEYS = {
  name: "name",
  price: "price_from_uzs",
  priceUnit: "price_unit",
  descriptionRu: "description_ru",
  descriptionUz: "description_uz",
  packages: "packages",
} as const;
type FieldKey = (typeof FIELD_KEYS)[keyof typeof FIELD_KEYS];

let rowKey = 0;

/** «25 000 000» → 25000000; пусто или не число — null */
export function parseSum(value: string): number | null {
  const compact = value.replace(/[\s  _]/g, "");
  if (!/^\d{1,11}$/.test(compact)) return null;
  const sum = Number(compact);
  return sum > 0 ? sum : null;
}

const order = (kind: PackageKind) => (kind === "weekday" ? 0 : kind === "weekend" ? 1 : 2);

function rowsOf(listing: VendorListing): PackageRow[] {
  const rows: PackageRow[] = listing.packages.map((p) => ({
    key: rowKey++,
    kind: p.kind,
    nameRu: p.name.ru,
    nameUz: p.name.uz,
    price: groupDigits(p.priceUzs),
    priceUnit: p.priceUnit,
  }));
  // У зала будни и выходные — всегда строкой: без них карточку не опубликовать
  if (listing.categoryCode === "hall") {
    for (const kind of ["weekday", "weekend"] as const) {
      if (!rows.some((row) => row.kind === kind)) {
        // Название пакета — для клиентов на обоих языках, какой бы язык ни был у кабинета
        rows.push({
          key: rowKey++,
          kind,
          nameRu: vendorDict.ru[`pk_${kind}`],
          nameUz: vendorDict.uz[`pk_${kind}`],
          price: "",
          priceUnit: listing.priceUnit,
        });
      }
    }
  }
  return rows.sort((a, b) => order(a.kind) - order(b.kind));
}

function packagesOf(rows: readonly PackageRow[]): RevisionPackage[] {
  return rows
    .filter((row) => row.kind === "custom" || row.price.trim() !== "")
    .map((row) => ({
      kind: row.kind,
      name_ru: row.nameRu.trim(),
      name_uz: row.nameUz.trim(),
      // Не число — как есть: сервер укажет на этот пакет
      price_uzs: parseSum(row.price) ?? (row.price as unknown as number),
      price_unit: row.priceUnit,
    }));
}

const currentPackages = (listing: VendorListing): RevisionPackage[] =>
  listing.packages.map((p) => ({
    kind: p.kind,
    name_ru: p.name.ru,
    name_uz: p.name.uz,
    price_uzs: p.priceUzs,
    price_unit: p.priceUnit,
  }));

/** Только изменённые поля; цена не числом — null (форма покажет ошибку до запроса) */
export function proposalOf(
  listing: VendorListing,
  values: Values,
  rows: readonly PackageRow[],
): ListingRevisionPayload | null {
  const payload: { -readonly [K in keyof ListingRevisionPayload]: ListingRevisionPayload[K] } = {};
  const name = values.name.trim();
  if (name !== listing.name) payload.name = name;
  const price = parseSum(values.price);
  if (price === null) return null;
  if (price !== listing.priceFromUzs) payload.price_from_uzs = price;
  if (values.priceUnit !== listing.priceUnit) payload.price_unit = values.priceUnit;
  const ru = values.descriptionRu.trim();
  if (ru !== listing.description.ru.trim()) payload.description_ru = ru;
  const uz = values.descriptionUz.trim();
  if (uz !== listing.description.uz.trim()) payload.description_uz = uz;
  const packages = packagesOf(rows);
  if (JSON.stringify(packages) !== JSON.stringify(currentPackages(listing))) payload.packages = packages;
  return payload;
}

const unitText = (unit: PriceUnit, t: VendorDict) => (unit === "per_guest" ? t.perGuest : t.perEvent);

// ── что предложено ─────────────────────────────────────────────────────────

function Proposed({
  payload,
  listing,
  t,
  lang,
}: {
  payload: ListingRevisionPayload;
  listing: VendorListing;
  t: VendorDict;
  lang: "ru" | "uz";
}) {
  const price = payload.price_from_uzs ?? listing.priceFromUzs;
  const unit = payload.price_unit ?? listing.priceUnit;
  return (
    <dl className="facts proposal-facts">
      {payload.name !== undefined ? (
        <div className="facts-wide">
          <dt>{t.nameLabel}</dt>
          <dd>{payload.name}</dd>
        </div>
      ) : null}
      {(payload.price_from_uzs !== undefined || payload.price_unit !== undefined) && price !== null ? (
        <div className="facts-wide">
          <dt>{t.priceLabel}</dt>
          <dd>{`${fill(t.priceFrom, { price: formatMoney(price, t, lang) })} ${unitText(unit, t)}`}</dd>
        </div>
      ) : null}
      {payload.description_ru !== undefined ? (
        <div className="facts-wide">
          <dt>{t.descriptionRuLabel}</dt>
          <dd className="description" lang="ru">
            {payload.description_ru}
          </dd>
        </div>
      ) : null}
      {payload.description_uz !== undefined ? (
        <div className="facts-wide">
          <dt>{t.descriptionUzLabel}</dt>
          <dd className="description" lang="uz">
            {payload.description_uz}
          </dd>
        </div>
      ) : null}
      {payload.packages !== undefined ? (
        <div className="facts-wide">
          <dt>{t.packages}</dt>
          <dd>
            <ul className="packages">
              {payload.packages.map((pack) => (
                <li key={`${pack.kind}-${pack.name_ru}-${pack.price_uzs}`}>
                  <span>{lang === "uz" ? pack.name_uz : pack.name_ru}</span>
                  <strong className="package-price">
                    {formatMoney(pack.price_uzs, t, lang)} {unitText(pack.price_unit ?? "per_guest", t)}
                  </strong>
                </li>
              ))}
            </ul>
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

// ── форма ──────────────────────────────────────────────────────────────────

interface FormProps {
  readonly listing: VendorListing;
  readonly t: VendorDict;
  readonly onSent: (revision: VendorRevision) => void;
  /** Открытое предложение уже есть (409): показать его */
  readonly onPendingExists: () => void;
  readonly onCancel: () => void;
}

type FormNotice = "noChanges" | "invalid" | "failed" | "pendingExists" | null;

function ProposalForm({ listing, t, onSent, onPendingExists, onCancel }: FormProps) {
  const id = useId();
  const [values, setValues] = useState<Values>(() => ({
    name: listing.name,
    // Суммы — с разрядами, как на карточке: «25 000 000»; пробелы при разборе отбрасываются
    price: listing.priceFromUzs === null ? "" : groupDigits(listing.priceFromUzs),
    priceUnit: listing.priceUnit,
    descriptionRu: listing.description.ru,
    descriptionUz: listing.description.uz,
  }));
  const [rows, setRows] = useState<PackageRow[]>(() => rowsOf(listing));
  const [invalid, setInvalid] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<FormNotice>(null);
  const [busy, setBusy] = useState(false);

  const unitOptions = [
    { value: "per_guest" as const, label: t.perGuest },
    { value: "per_event" as const, label: t.perEvent },
  ];
  const set = (key: keyof Values) => (value: string) => setValues((prev) => ({ ...prev, [key]: value }));
  const setRow = (key: number, patch: Partial<PackageRow>) =>
    setRows((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const bad = (key: string) => invalid.has(key);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setNotice(null);
    const payload = proposalOf(listing, values, rows);
    if (payload === null) {
      setInvalid(new Set([FIELD_KEYS.price]));
      setNotice("invalid");
      return;
    }
    if (Object.keys(payload).length === 0) {
      setInvalid(new Set());
      setNotice("noChanges");
      return;
    }
    setBusy(true);
    try {
      onSent(await api.proposeRevision(listing.id, payload));
    } catch (err) {
      if (err instanceof ApiFailure && err.code === "invalid_input") {
        // packages.1.price_uzs → подсветить и весь блок пакетов, и строку packages.1
        const parts = (detail: string) => [
          detail.split(".")[0] ?? detail,
          detail.split(".").slice(0, 2).join("."),
        ];
        setInvalid(new Set(err.details.flatMap(parts)));
        setNotice("invalid");
      } else if (err instanceof ApiFailure && err.code === "no_changes") {
        setNotice("noChanges");
      } else if (err instanceof ApiFailure && err.code === "revision_pending") {
        setNotice("pendingExists");
        onPendingExists();
      } else {
        setNotice("failed");
      }
    } finally {
      setBusy(false);
    }
  };

  const errorText = (key: FieldKey) =>
    bad(key) ? (
      <p className="field-error" id={`${id}-${key}-error`}>
        {key === FIELD_KEYS.price ? t.priceInvalid : t.fieldInvalid}
      </p>
    ) : null;
  const described = (key: FieldKey) => (bad(key) ? `${id}-${key}-error` : undefined);

  const text = (key: "name" | "descriptionRu" | "descriptionUz", label: string, multiline: boolean) => {
    const field = FIELD_KEYS[key];
    const inputId = `${id}-${key}`;
    const common = {
      id: inputId,
      className: "field",
      value: values[key],
      "aria-invalid": bad(field) || undefined,
      "aria-describedby": described(field),
      onChange: (event: { target: { value: string } }) => set(key)(event.target.value),
    };
    return (
      <div className="form-row">
        <label className="field-label" htmlFor={inputId}>
          {label}
        </label>
        {multiline ? (
          <textarea
            {...common}
            rows={5}
            maxLength={DESCRIPTION_MAX}
            lang={key === "descriptionUz" ? "uz" : "ru"}
          />
        ) : (
          <input {...common} maxLength={80} autoComplete="off" />
        )}
        {errorText(field)}
      </div>
    );
  };

  const notices: Record<Exclude<FormNotice, null>, string> = {
    noChanges: t.proposalNoChanges,
    invalid: t.proposalInvalid,
    failed: t.actionFailed,
    pendingExists: t.proposalPendingExists,
  };

  return (
    <form className="proposal-form" onSubmit={submit} noValidate>
      {/* Шире телефона поля — парами: название рядом с ценой, описание RU рядом с UZ */}
      <div className="form-grid">
        {text("name", t.nameLabel, false)}
        <div className="form-row">
          <label className="field-label" htmlFor={`${id}-price`}>
            {t.priceFromLabel}
          </label>
          <input
            id={`${id}-price`}
            className="field"
            inputMode="numeric"
            autoComplete="off"
            maxLength={16}
            value={values.price}
            aria-invalid={bad(FIELD_KEYS.price) || undefined}
            aria-describedby={described(FIELD_KEYS.price)}
            onChange={(event) => set("price")(event.target.value)}
          />
          {errorText(FIELD_KEYS.price)}
        </div>
      </div>
      <fieldset className="choices">
        <legend className="field-label">{t.priceUnitLabel}</legend>
        <RadioGroup
          variant="segmented"
          name={`${id}-unit`}
          value={values.priceUnit}
          options={unitOptions}
          onChange={(unit) => setValues((prev) => ({ ...prev, priceUnit: unit }))}
        />
      </fieldset>
      <div className="form-grid">
        {text("descriptionRu", t.descriptionRuLabel, true)}
        {text("descriptionUz", t.descriptionUzLabel, true)}
      </div>

      <fieldset className="choices proposal-packages" aria-describedby={described(FIELD_KEYS.packages)}>
        <legend className="panel-title">{t.packages}</legend>
        {errorText(FIELD_KEYS.packages)}
        {rows.map((row, index) => {
          const rowBad = bad(`packages.${index}`);
          const rowId = `${id}-pk-${row.key}`;
          return (
            <div key={row.key} className={rowBad ? "package-row package-row-bad" : "package-row"}>
              <p className="package-kind">{textOf(t, `pk_${row.kind}`)}</p>
              <div className="form-grid">
                <div className="form-row">
                  <label className="field-label" htmlFor={`${rowId}-ru`}>
                    {t.packageNameRu}
                  </label>
                  <input
                    id={`${rowId}-ru`}
                    className="field"
                    maxLength={80}
                    value={row.nameRu}
                    aria-invalid={rowBad || undefined}
                    onChange={(event) => setRow(row.key, { nameRu: event.target.value })}
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
                    maxLength={80}
                    value={row.nameUz}
                    aria-invalid={rowBad || undefined}
                    onChange={(event) => setRow(row.key, { nameUz: event.target.value })}
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
                    value={row.price}
                    aria-invalid={rowBad || undefined}
                    onChange={(event) => setRow(row.key, { price: event.target.value })}
                  />
                </div>
                <div className="form-row package-unit">
                  <RadioGroup
                    variant="segmented"
                    label={`${t.priceUnitLabel}: ${textOf(t, `pk_${row.kind}`)}`}
                    name={`${rowId}-unit`}
                    value={row.priceUnit}
                    options={unitOptions}
                    onChange={(unit) => setRow(row.key, { priceUnit: unit })}
                  />
                </div>
              </div>
              {row.kind === "custom" ? (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setRows((prev) => prev.filter((r) => r.key !== row.key))}
                >
                  {t.packageRemove}
                </button>
              ) : null}
            </div>
          );
        })}
        {rows.length < MAX_REVISION_PACKAGES ? (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() =>
              setRows((prev) => [
                ...prev,
                {
                  key: rowKey++,
                  kind: "custom",
                  nameRu: "",
                  nameUz: "",
                  price: "",
                  priceUnit: values.priceUnit,
                },
              ])
            }
          >
            {t.packageAdd}
          </button>
        ) : null}
      </fieldset>

      {notice ? (
        <p className={notice === "noChanges" ? "note" : "form-error"} role="alert">
          {notices[notice]}
        </p>
      ) : null}
      <div className="actions">
        <button type="submit" className="btn btn-dark" disabled={busy}>
          {t.proposalSubmit}
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={onCancel}>
          {t.cancel}
        </button>
      </div>
    </form>
  );
}

// ── раздел целиком ─────────────────────────────────────────────────────────

interface ProposalProps {
  readonly listing: VendorListing;
  readonly t: VendorDict;
  readonly lang: "ru" | "uz";
  /** Владелец кабинета: только он предлагает и отзывает */
  readonly owner: boolean;
}

export function Proposal({ listing, t, lang, owner }: ProposalProps) {
  const [revisions, reload, setRevisions] = useLoad<VendorRevisionList>(listing.id, (key) =>
    api.revisions(key),
  );
  const [editing, setEditing] = useState(false);
  const [sent, setSent] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [withdrawFailed, setWithdrawFailed] = useState(false);
  const withdrawButton = useRef<HTMLButtonElement>(null);
  // Кнопка, которую нажали, исчезает (форма вместо «Предложить», «на проверке» вместо
  // формы) — фокус переходит в новый блок: на первое поле формы, на «Предложить» после
  // «Отмены», на заголовок раздела после отправки (сам статус «Отправлено» читает диктор)
  const section = useRef<HTMLElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const refocus = useRef<"first" | "title" | null>(null);
  const edit = (open: boolean) => {
    refocus.current = "first";
    setEditing(open);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: перенос фокуса — после смены формы или отправки
  useEffect(() => {
    const target = refocus.current;
    if (target === null) return;
    refocus.current = null;
    if (target === "title") title.current?.focus();
    else section.current?.querySelector<HTMLElement>(".proposal-form input, .proposal-start")?.focus();
  }, [editing, sent]);

  const body = () => {
    if (revisions.state === "loading") return <Loading t={t} />;
    if (revisions.state === "error") return <LoadError t={t} onRetry={reload} />;
    const items = revisions.data.items;
    const pending = items.find((r) => r.status === "pending");
    const latest = items[0];

    const replace = (next: VendorRevision) =>
      setRevisions((list) => ({ items: list.items.map((r) => (r.id === next.id ? next : r)) }));

    const withdraw = async () => {
      if (!pending) return;
      setBusy(true);
      setWithdrawFailed(false);
      try {
        replace(await api.withdrawRevision(listing.id, pending.id));
        setConfirming(false);
        setSent(false);
      } catch (err) {
        // По предложению уже решили или его внесла команда — показать, как есть
        if (
          err instanceof ApiFailure &&
          (err.code === "illegal_transition" || err.code === "forbidden_for_actor")
        ) {
          setConfirming(false);
          reload();
        } else setWithdrawFailed(true);
      } finally {
        setBusy(false);
      }
    };

    if (pending) {
      const date = formatMoment(pending.submittedAt, t);
      // Предложение менеджера Bayramm решает модератор: партнёр его не отзывает
      const withdrawable = owner && !pending.byTeam;
      return (
        <>
          {sent ? (
            <p className="note" role="status">
              {t.proposalSent}
            </p>
          ) : null}
          <div className="notice proposal-pending">
            <p>{fill(pending.byTeam ? t.proposalByTeam : t.proposalPending, { date })}</p>
            <Proposed payload={pending.payload} listing={listing} t={t} lang={lang} />
          </div>
          {withdrawable ? (
            <>
              <button
                ref={withdrawButton}
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setWithdrawFailed(false);
                  setConfirming(true);
                }}
              >
                {t.proposalWithdraw}
              </button>
              <ConfirmSheet
                open={confirming}
                title={t.proposalWithdrawQ}
                text={t.proposalWithdrawText}
                confirmLabel={t.proposalWithdraw}
                cancelLabel={t.cancel}
                tone="danger"
                busy={busy}
                error={withdrawFailed ? t.actionFailed : undefined}
                onConfirm={() => void withdraw()}
                onCancel={() => setConfirming(false)}
                returnFocus={withdrawButton}
              />
            </>
          ) : null}
        </>
      );
    }

    return (
      <>
        {latest?.status === "declined" && latest.decisionReason ? (
          <p className="notice">{fill(t.proposalDeclined, { reason: latest.decisionReason })}</p>
        ) : null}
        {latest?.status === "approved" && latest.decidedAt ? (
          <p className="note">{fill(t.proposalApproved, { date: formatMoment(latest.decidedAt, t) })}</p>
        ) : null}
        {!owner ? (
          <p className="note">{t.proposalOwnerOnly}</p>
        ) : editing ? (
          <ProposalForm
            listing={listing}
            t={t}
            onSent={(revision) => {
              setRevisions((list) => ({ items: [revision, ...list.items] }));
              refocus.current = "title";
              setEditing(false);
              setSent(true);
            }}
            onPendingExists={reload}
            onCancel={() => edit(false)}
          />
        ) : (
          <>
            <p className="note">{t.proposalLead}</p>
            <button type="button" className="btn btn-dark proposal-start" onClick={() => edit(true)}>
              {t.proposalStart}
            </button>
          </>
        )}
      </>
    );
  };

  return (
    <section className="panel proposal" aria-labelledby="proposal-title" ref={section}>
      <h2 className="section-title" id="proposal-title" ref={title} tabIndex={-1}>
        {t.proposalTitle}
      </h2>
      {body()}
    </section>
  );
}
