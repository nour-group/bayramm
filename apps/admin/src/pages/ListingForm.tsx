/* Форма карточки: создание и правка. Цена обязательна (без «по запросу»), пакеты будней
   и выходных — для залов. Телефон для заявок только пишется: текущий — по «Показать».
   Опубликованную карточку менеджер (без права решать по правкам) меняет так же, как
   вендор из кабинета: название, цена, описания и пакеты уходят правкой на модерацию, а
   карточка остаётся прежней — форма говорит «отправлено на модерацию» и показывает то,
   что в карточке сейчас. Остальные поля сохраняются сразу. */

import type {
  ListingDetail,
  ListingInput,
  ListingSaveResult,
  PriceUnit,
  RevisionField,
  StaffDictionaries,
  StaffListingPackage,
} from "@bayramm/shared/api/staff";
import { Select, type SelectOption } from "@bayramm/ui/react";
import { type FormEvent, useEffect, useId, useState } from "react";
import type { Failure } from "../api";
import { t } from "../texts";
import { ErrorText, Field, FormBar, fieldErrors, useRevealErrors } from "../ui";

type PackageKind = StaffListingPackage["kind"];

interface PackageRow {
  key: number;
  kind: PackageKind;
  nameRu: string;
  nameUz: string;
  price: string;
  priceUnit: PriceUnit;
}

interface Values {
  name: string;
  slug: string;
  districtCode: string;
  addressRu: string;
  addressUz: string;
  descriptionRu: string;
  descriptionUz: string;
  priceFromUzs: string;
  priceUnit: PriceUnit;
  capMin: string;
  capMax: string;
  phone: string;
  status: "lead" | "draft";
}

const TEXT_KEYS = ["name", "addressRu", "addressUz", "descriptionRu", "descriptionUz"] as const;

const PRICE_UNITS: readonly SelectOption<PriceUnit>[] = [
  { value: "per_guest", label: t.priceUnits.per_guest },
  { value: "per_event", label: t.priceUnits.per_event },
];
const NUMBER_KEYS = ["priceFromUzs", "capMin", "capMax"] as const;
/** Поля тела запроса, которые у опубликованной карточки меняет только модерация */
const MODERATED_KEYS: ReadonlySet<string> = new Set<RevisionField>([
  "name",
  "priceFromUzs",
  "priceUnit",
  "descriptionRu",
  "descriptionUz",
  "packages",
]);

let rowKey = 0;

function packageRows(listing: ListingDetail | null): PackageRow[] {
  const rows: PackageRow[] = (listing?.packages ?? []).map((p) => ({
    key: rowKey++,
    kind: p.kind,
    nameRu: p.nameRu,
    nameUz: p.nameUz,
    price: String(p.priceUzs),
    priceUnit: p.priceUnit,
  }));
  // Будни и выходные — всегда строкой в форме: без них зал не опубликовать
  for (const kind of ["weekend", "weekday"] as const) {
    if (!rows.some((row) => row.kind === kind)) {
      rows.unshift({
        key: rowKey++,
        kind,
        nameRu: t.packageDefaults[kind].ru,
        nameUz: t.packageDefaults[kind].uz,
        price: "",
        priceUnit: listing?.priceUnit ?? "per_guest",
      });
    }
  }
  return rows.sort((a, b) => order(a.kind) - order(b.kind));
}

const order = (kind: PackageKind) => (kind === "weekday" ? 0 : kind === "weekend" ? 1 : 2);

function initial(listing: ListingDetail | null): Values {
  return {
    name: listing?.name ?? "",
    slug: listing?.slug ?? "",
    districtCode: listing?.districtCode ?? "",
    addressRu: listing?.addressRu ?? "",
    addressUz: listing?.addressUz ?? "",
    descriptionRu: listing?.descriptionRu ?? "",
    descriptionUz: listing?.descriptionUz ?? "",
    priceFromUzs: listing?.priceFromUzs?.toString() ?? "",
    priceUnit: listing?.priceUnit ?? "per_guest",
    capMin: listing?.capMin?.toString() ?? "",
    capMax: listing?.capMax?.toString() ?? "",
    phone: "",
    status: "draft",
  };
}

/** «150 000» → 150000; пусто — null; не число — NaN (сервер ответит ошибкой поля) */
export function parseAmount(value: string): number | null {
  const compact = value.replace(/[\s _]/g, "");
  if (compact === "") return null;
  return /^\d+$/.test(compact) ? Number(compact) : Number.NaN;
}

function packagesOf(rows: readonly PackageRow[]): StaffListingPackage[] {
  return rows
    .filter((row) => row.kind === "custom" || row.price.trim() !== "")
    .map((row) => {
      const price = parseAmount(row.price);
      return {
        kind: row.kind,
        nameRu: row.nameRu.trim(),
        nameUz: row.nameUz.trim(),
        // Не число — как есть: сервер укажет на пакет
        priceUzs: price === null || Number.isNaN(price) ? (row.price as unknown as number) : price,
        priceUnit: row.priceUnit,
      };
    });
}

/** Тело запроса: при создании — заполненное, при правке — изменённое */
export function listingBody(
  values: Values,
  before: Values,
  rows: readonly PackageRow[],
  beforeRows: readonly PackageRow[],
  creating: boolean,
): ListingInput {
  const body: Record<string, unknown> = {};
  const changed = (key: keyof Values) => creating || values[key].trim() !== before[key].trim();
  for (const key of TEXT_KEYS) {
    if (!changed(key)) continue;
    const value = values[key].trim();
    if (creating && value === "") continue;
    body[key] = value === "" ? null : value;
  }
  for (const key of NUMBER_KEYS) {
    if (!changed(key)) continue;
    const value = parseAmount(values[key]);
    if (creating && value === null) continue;
    // Не число — отправляем как есть: сервер ответит ошибкой этого поля, а не очистит его
    body[key] = Number.isNaN(value) ? values[key] : value;
  }
  if (values.districtCode !== before.districtCode || (creating && values.districtCode)) {
    body.districtCode = values.districtCode || null;
  }
  if (creating || values.priceUnit !== before.priceUnit) body.priceUnit = values.priceUnit;
  const slug = values.slug.trim();
  if (slug !== "" && slug !== before.slug) body.slug = slug;
  if (values.phone.trim() !== "") body.phone = values.phone.trim();
  const packages = packagesOf(rows);
  if (creating ? packages.length > 0 : JSON.stringify(packages) !== JSON.stringify(packagesOf(beforeRows))) {
    body.packages = packages;
  }
  if (creating) body.status = values.status;
  return body as ListingInput;
}

interface ListingFormProps {
  listing: ListingDetail | null;
  dictionaries: StaffDictionaries | null;
  /**
   * Ответ сервера: ошибка; карточка после правки (и какие поля ушли на модерацию);
   * null — готово (создание: страница уходит на новую карточку)
   */
  onSubmit: (body: ListingInput) => Promise<Failure | ListingSaveResult | null>;
  submitLabel: string;
  readOnly?: boolean;
  /** Название, цена, описания и пакеты уйдут на модерацию — подсказать у этих полей */
  moderated?: boolean;
  /** Есть несохранённые правки (true) или форма как в карточке (false) */
  onDirtyChange?: (dirty: boolean) => void;
}

/** Что ушло на модерацию и было ли в правке что-то ещё (оно сохранено сразу) */
interface Sent {
  readonly fields: readonly RevisionField[];
  readonly rest: boolean;
}

export function ListingForm({
  listing,
  dictionaries,
  onSubmit,
  submitLabel,
  readOnly,
  moderated = false,
  onDirtyChange,
}: ListingFormProps) {
  const creating = listing === null;
  const [before, setBefore] = useState(() => initial(listing));
  const [values, setValues] = useState(before);
  const [beforeRows, setBeforeRows] = useState(() => packageRows(listing));
  const [rows, setRows] = useState(beforeRows);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [sent, setSent] = useState<Sent | null>(null);
  const errors = fieldErrors(failure, t.listingFieldErrors);
  const moderatedHint = moderated && !readOnly ? t.moderatedHint : undefined;
  const form = useRevealErrors(failure);
  const formId = useId();
  // Несохранённое есть, если запрос правки был бы не пуст; на телефоне тогда видна «Сохранить»
  const dirty =
    !creating && !readOnly && Object.keys(listingBody(values, before, rows, beforeRows, false)).length > 0;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // Любая новая правка — старое «Сохранено» или «Отправлено» уже не про неё
  const touch = () => {
    setSaved(false);
    setSent(null);
  };
  const put = (key: keyof Values) => (value: string) => {
    touch();
    setValues((prev) => ({ ...prev, [key]: value }));
  };
  const set = (key: keyof Values) => (event: { target: { value: string } }) => put(key)(event.target.value);
  const setRow = (key: number, patch: Partial<PackageRow>) => {
    touch();
    setRows((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const body = listingBody(values, before, rows, beforeRows, creating);
    const result = await onSubmit(body);
    setBusy(false);
    if (result !== null && "ok" in result) {
      setFailure(result);
      return;
    }
    setFailure(null);
    const fields = result?.sentForModeration ?? [];
    if (result && fields.length > 0) {
      // Карточка не изменилась в том, что ушло на модерацию: форма — как в карточке сейчас
      const next = initial(result);
      const nextRows = packageRows(result);
      setBefore(next);
      setValues(next);
      setBeforeRows(nextRows);
      setRows(nextRows);
      setSaved(false);
      setSent({ fields, rest: Object.keys(body).some((key) => !MODERATED_KEYS.has(key)) });
      return;
    }
    setSent(null);
    setSaved(true);
    const next = { ...values, phone: "" };
    setValues(next);
    setBefore(next);
    setBeforeRows(rows);
  };

  const input = (
    key: keyof Values,
    label: string,
    extra: { maxLength: number; numeric?: boolean; required?: boolean; hint?: string | undefined },
  ) => (
    <Field label={label} error={errors[key]} hint={extra.hint}>
      {(props) => (
        <input
          {...props}
          className="input"
          value={values[key]}
          onChange={set(key)}
          maxLength={extra.maxLength}
          inputMode={extra.numeric ? "numeric" : undefined}
          autoComplete="off"
          enterKeyHint="done"
          readOnly={readOnly}
          required={extra.required}
        />
      )}
    </Field>
  );

  const textarea = (key: "descriptionRu" | "descriptionUz", lang: "ru" | "uz") => (
    <Field label={t.listingFields[key] ?? key} error={errors[key]} hint={moderatedHint} full>
      {(props) => (
        <textarea
          {...props}
          className="input"
          lang={lang}
          rows={5}
          value={values[key]}
          onChange={set(key)}
          maxLength={4000}
          readOnly={readOnly}
        />
      )}
    </Field>
  );

  return (
    <form id={formId} ref={form} className="form" onSubmit={submit} noValidate>
      {moderatedHint && <p className="notice notice-warn">{t.moderatedNotice}</p>}
      <section className="fs">
        <div className="fs-head">
          <h2>{t.listingSections.main}</h2>
          <p>{t.listingSections.mainHint}</p>
        </div>
        <div className="fields">
          {input("name", t.listingFields.name ?? "", { maxLength: 80, required: true, hint: moderatedHint })}
          <Field
            label={t.listingFields.slug ?? ""}
            error={errors.slug}
            hint={creating ? t.slugAuto : undefined}
          >
            {(props) => (
              <input
                {...props}
                className="input"
                value={values.slug}
                onChange={set("slug")}
                maxLength={40}
                autoCapitalize="none"
                spellCheck={false}
                readOnly={readOnly}
              />
            )}
          </Field>
          <Field label={t.listingFields.districtCode ?? ""} error={errors.districtCode}>
            {(props) => (
              <Select
                {...props}
                className="input"
                label={t.listingFields.districtCode ?? ""}
                value={values.districtCode}
                onChange={put("districtCode")}
                disabled={readOnly}
                options={[
                  { value: "", label: t.none },
                  ...(dictionaries?.districts ?? []).map((district) => ({
                    value: district.code,
                    label: district.nameRu,
                  })),
                ]}
              />
            )}
          </Field>
          <Field label={t.category}>
            {(props) => (
              <input
                {...props}
                className="input"
                readOnly
                value={
                  dictionaries?.categories.find((c) => c.code === (listing?.categoryCode ?? "hall"))
                    ?.nameRu ?? ""
                }
              />
            )}
          </Field>
          {creating && (
            <Field label={t.startAs}>
              {(props) => (
                <Select
                  {...props}
                  className="input"
                  label={t.startAs}
                  value={values.status}
                  onChange={put("status")}
                  options={[
                    { value: "draft", label: t.status.draft },
                    { value: "lead", label: t.status.lead },
                  ]}
                />
              )}
            </Field>
          )}
        </div>
      </section>

      <section className="fs">
        <div className="fs-head">
          <h2>{t.listingSections.texts}</h2>
          <p>{t.listingSections.textsHint}</p>
        </div>
        <div className="fields">
          {input("addressRu", t.listingFields.addressRu ?? "", { maxLength: 300 })}
          {input("addressUz", t.listingFields.addressUz ?? "", { maxLength: 300 })}
          {textarea("descriptionRu", "ru")}
          {textarea("descriptionUz", "uz")}
        </div>
      </section>

      <section className="fs">
        <div className="fs-head">
          <h2>{t.listingSections.prices}</h2>
          <p>{t.listingSections.pricesHint}</p>
        </div>
        <div className="fields">
          {input("priceFromUzs", t.listingFields.priceFromUzs ?? "", {
            maxLength: 16,
            numeric: true,
            hint: moderatedHint,
          })}
          <Field label={t.listingFields.priceUnit ?? ""} hint={moderatedHint}>
            {(props) => (
              <Select
                {...props}
                className="input"
                label={t.listingFields.priceUnit ?? ""}
                value={values.priceUnit}
                onChange={put("priceUnit")}
                disabled={readOnly}
                options={PRICE_UNITS}
              />
            )}
          </Field>
          {input("capMin", t.listingFields.capMin ?? "", { maxLength: 5, numeric: true })}
          {input("capMax", t.listingFields.capMax ?? "", { maxLength: 5, numeric: true })}
        </div>
        <fieldset className="packages">
          <legend>{t.packages}</legend>
          {moderatedHint && <p className="field-hint">{moderatedHint}</p>}
          {errors.packages && <p className="field-error">{errors.packages}</p>}
          {rows.map((row) => (
            <div key={row.key} className="package-row">
              <span className="package-kind">{t.packageKinds[row.kind]}</span>
              <Field label={t.packageNameRu}>
                {(props) => (
                  <input
                    {...props}
                    className="input"
                    value={row.nameRu}
                    maxLength={80}
                    readOnly={readOnly}
                    onChange={(event) => setRow(row.key, { nameRu: event.target.value })}
                  />
                )}
              </Field>
              <Field label={t.packageNameUz}>
                {(props) => (
                  <input
                    {...props}
                    className="input"
                    lang="uz"
                    value={row.nameUz}
                    maxLength={80}
                    readOnly={readOnly}
                    onChange={(event) => setRow(row.key, { nameUz: event.target.value })}
                  />
                )}
              </Field>
              <Field label={t.packagePrice}>
                {(props) => (
                  <input
                    {...props}
                    className="input"
                    inputMode="numeric"
                    enterKeyHint="done"
                    value={row.price}
                    maxLength={16}
                    readOnly={readOnly}
                    onChange={(event) => setRow(row.key, { price: event.target.value })}
                  />
                )}
              </Field>
              <Field label={t.listingFields.priceUnit ?? ""}>
                {(props) => (
                  <Select
                    {...props}
                    className="input"
                    label={`${t.listingFields.priceUnit ?? ""} · ${t.packageKinds[row.kind]}`}
                    value={row.priceUnit}
                    disabled={readOnly}
                    onChange={(priceUnit) => setRow(row.key, { priceUnit })}
                    options={PRICE_UNITS}
                  />
                )}
              </Field>
              {row.kind === "custom" && !readOnly && (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    touch();
                    setRows((prev) => prev.filter((r) => r.key !== row.key));
                  }}
                >
                  {t.removePackage}
                </button>
              )}
            </div>
          ))}
          {!readOnly && rows.length < 10 && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                touch();
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
                ]);
              }}
            >
              {t.addPackage}
            </button>
          )}
        </fieldset>
      </section>

      <section className="fs">
        <div className="fs-head">
          <h2>{t.listingSections.phone}</h2>
          <p>{t.listingSections.phoneHint}</p>
        </div>
        <div className="fields">
          <Field
            label={creating ? (t.listingFields.phone ?? "") : t.phoneChange}
            error={errors.phone}
            hint={creating ? undefined : t.phoneKeep}
          >
            {(props) => (
              <input
                {...props}
                className="input"
                type="tel"
                inputMode="tel"
                autoComplete="off"
                placeholder="+998 90 123 45 67"
                value={values.phone}
                onChange={set("phone")}
                maxLength={24}
                enterKeyHint="done"
                readOnly={readOnly}
              />
            )}
          </Field>
        </div>
      </section>

      {failure && <ErrorText failure={failure} />}
      {!readOnly && (
        <FormBar
          formId={formId}
          show={creating || dirty}
          busy={busy}
          submitLabel={submitLabel}
          note={
            saved ? (
              <span className="saved" role="status">
                {t.saved}
              </span>
            ) : sent ? (
              <span className="sent" role="status">
                {t.sentForModeration(
                  sent.fields.map((field) => t.revisionFields[field] ?? field).join(", "),
                  sent.rest,
                )}
              </span>
            ) : null
          }
        />
      )}
    </form>
  );
}
