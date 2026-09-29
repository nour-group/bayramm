/* Форма карточки: создание и правка. Цена обязательна (без «по запросу»), пакеты будней
   и выходных — для залов. Телефон для заявок только пишется: текущий — по «Показать». */

import type {
  ListingDetail,
  ListingInput,
  PriceUnit,
  StaffDictionaries,
  StaffListingPackage,
} from "@bayramm/shared/api/staff";
import { type FormEvent, useState } from "react";
import type { Failure } from "../api";
import { t } from "../texts";
import { ErrorText, Field, fieldErrors } from "../ui";

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
const NUMBER_KEYS = ["priceFromUzs", "capMin", "capMax"] as const;

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
  onSubmit: (body: ListingInput) => Promise<Failure | null>;
  submitLabel: string;
  readOnly?: boolean;
}

export function ListingForm({ listing, dictionaries, onSubmit, submitLabel, readOnly }: ListingFormProps) {
  const creating = listing === null;
  const [before, setBefore] = useState(() => initial(listing));
  const [values, setValues] = useState(before);
  const [beforeRows, setBeforeRows] = useState(() => packageRows(listing));
  const [rows, setRows] = useState(beforeRows);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const errors = fieldErrors(failure, t.listingFieldErrors);

  const set = (key: keyof Values) => (event: { target: { value: string } }) => {
    setSaved(false);
    setValues((prev) => ({ ...prev, [key]: event.target.value }));
  };
  const setRow = (key: number, patch: Partial<PackageRow>) => {
    setSaved(false);
    setRows((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const result = await onSubmit(listingBody(values, before, rows, beforeRows, creating));
    setBusy(false);
    setFailure(result);
    if (result === null) {
      setSaved(true);
      const next = { ...values, phone: "" };
      setValues(next);
      setBefore(next);
      setBeforeRows(rows);
    }
  };

  const input = (
    key: keyof Values,
    label: string,
    extra: { maxLength: number; numeric?: boolean; required?: boolean },
  ) => (
    <Field label={label} error={errors[key]}>
      {(props) => (
        <input
          {...props}
          className="input"
          value={values[key]}
          onChange={set(key)}
          maxLength={extra.maxLength}
          inputMode={extra.numeric ? "numeric" : undefined}
          readOnly={readOnly}
          required={extra.required}
        />
      )}
    </Field>
  );

  const textarea = (key: "descriptionRu" | "descriptionUz", lang: "ru" | "uz") => (
    <Field label={t.listingFields[key] ?? key} error={errors[key]} full>
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
    <form className="form" onSubmit={submit} noValidate>
      <section className="fs">
        <div className="fs-head">
          <h2>{t.listingSections.main}</h2>
          <p>{t.listingSections.mainHint}</p>
        </div>
        <div className="fields">
          {input("name", t.listingFields.name ?? "", { maxLength: 80, required: true })}
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
              <select
                {...props}
                className="input"
                value={values.districtCode}
                onChange={set("districtCode")}
                disabled={readOnly}
              >
                <option value="">{t.none}</option>
                {(dictionaries?.districts ?? []).map((district) => (
                  <option key={district.code} value={district.code}>
                    {district.nameRu}
                  </option>
                ))}
              </select>
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
                <select {...props} className="input" value={values.status} onChange={set("status")}>
                  <option value="draft">{t.status.draft}</option>
                  <option value="lead">{t.status.lead}</option>
                </select>
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
          {input("priceFromUzs", t.listingFields.priceFromUzs ?? "", { maxLength: 16, numeric: true })}
          <Field label={t.listingFields.priceUnit ?? ""}>
            {(props) => (
              <select
                {...props}
                className="input"
                value={values.priceUnit}
                onChange={set("priceUnit")}
                disabled={readOnly}
              >
                <option value="per_guest">{t.priceUnits.per_guest}</option>
                <option value="per_event">{t.priceUnits.per_event}</option>
              </select>
            )}
          </Field>
          {input("capMin", t.listingFields.capMin ?? "", { maxLength: 5, numeric: true })}
          {input("capMax", t.listingFields.capMax ?? "", { maxLength: 5, numeric: true })}
        </div>
        <fieldset className="packages">
          <legend>{t.packages}</legend>
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
                    value={row.price}
                    maxLength={16}
                    readOnly={readOnly}
                    onChange={(event) => setRow(row.key, { price: event.target.value })}
                  />
                )}
              </Field>
              <Field label={t.listingFields.priceUnit ?? ""}>
                {(props) => (
                  <select
                    {...props}
                    className="input"
                    value={row.priceUnit}
                    disabled={readOnly}
                    onChange={(event) => setRow(row.key, { priceUnit: event.target.value as PriceUnit })}
                  >
                    <option value="per_guest">{t.priceUnits.per_guest}</option>
                    <option value="per_event">{t.priceUnits.per_event}</option>
                  </select>
                )}
              </Field>
              {row.kind === "custom" && !readOnly && (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setRows((prev) => prev.filter((r) => r.key !== row.key))}
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
                readOnly={readOnly}
              />
            )}
          </Field>
        </div>
      </section>

      {failure && <ErrorText failure={failure} />}
      {!readOnly && (
        <div className="formbar">
          {saved && (
            <span className="saved" role="status">
              {t.saved}
            </span>
          )}
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? t.saving : submitLabel}
          </button>
        </div>
      )}
    </form>
  );
}
