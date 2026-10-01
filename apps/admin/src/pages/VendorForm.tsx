/* Форма вендора: создание и правка. Телефоны только пишутся — текущий номер форма не
   знает (его видно только по «Показать»); пустое поле при правке — «не менять». */

import type { StaffDictionaries, VendorDetail, VendorInput } from "@bayramm/shared/api/staff";
import { Select } from "@bayramm/ui/react";
import { type FormEvent, useId, useState } from "react";
import type { Failure } from "../api";
import { t } from "../texts";
import { ErrorText, Field, FormBar, fieldErrors, useRevealErrors } from "../ui";
import { useUnsaved } from "../unsaved";

type Values = Record<keyof VendorInput, string>;

const TEXT_KEYS = [
  "name",
  "legalName",
  "stir",
  "legalAddress",
  "contractNo",
  "contactPerson",
  "contactRole",
  "telegramUsername",
] as const;

function initial(vendor: VendorDetail | null): Values {
  return {
    name: vendor?.name ?? "",
    legalForm: vendor?.legalForm ?? "",
    legalName: vendor?.contacts.legalName ?? "",
    stir: vendor?.contacts.stir ?? "",
    legalAddress: vendor?.contacts.legalAddress ?? "",
    contractNo: vendor?.contractNo ?? "",
    managerId: vendor?.manager?.id ?? "",
    contactPerson: vendor?.contacts.contactPerson ?? "",
    contactRole: vendor?.contacts.contactRole ?? "",
    phone: "",
    phoneAlt: "",
    telegramUsername: vendor?.contacts.telegramUsername ?? "",
  };
}

/** Тело запроса: при создании — заполненное, при правке — изменённое (пустое — очистить) */
export function vendorBody(values: Values, before: Values, creating: boolean): VendorInput {
  const body: Record<string, string | null> = {};
  for (const key of [...TEXT_KEYS, "legalForm", "managerId"] as const) {
    const value = values[key].trim();
    if (creating ? value !== "" : value !== before[key].trim()) body[key] = value === "" ? null : value;
  }
  // Телефоны: пустое поле — не трогать
  for (const key of ["phone", "phoneAlt"] as const) {
    const value = values[key].trim();
    if (value !== "") body[key] = value;
  }
  return body as VendorInput;
}

interface VendorFormProps {
  vendor: VendorDetail | null;
  dictionaries: StaffDictionaries | null;
  /** Отправка: ответ API — ошибка для формы или null (успех) */
  onSubmit: (body: VendorInput) => Promise<Failure | null>;
  submitLabel: string;
  readOnly?: boolean;
}

export function VendorForm({ vendor, dictionaries, onSubmit, submitLabel, readOnly }: VendorFormProps) {
  const [before, setBefore] = useState(() => initial(vendor));
  const [values, setValues] = useState(before);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const errors = fieldErrors(failure, t.fieldErrors);
  const creating = vendor === null;
  const form = useRevealErrors(failure);
  const formId = useId();
  // Есть несохранённое: на телефоне панель «Сохранить» появляется только тогда, а уход со
  // страницы переспросит
  const dirty = !readOnly && Object.keys(vendorBody(values, before, false)).length > 0;
  useUnsaved(dirty);

  const put = (key: keyof Values) => (value: string) => {
    setSaved(false);
    setValues((prev) => ({ ...prev, [key]: value }));
  };
  const set = (key: keyof Values) => (event: { target: { value: string } }) => put(key)(event.target.value);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const result = await onSubmit(vendorBody(values, before, creating));
    setBusy(false);
    setFailure(result);
    if (result === null) {
      setSaved(true);
      const next = { ...values, phone: "", phoneAlt: "" };
      setValues(next);
      setBefore(next);
    }
  };

  const text = (
    key: (typeof TEXT_KEYS)[number],
    extra: { maxLength: number; inputMode?: "numeric"; latin?: boolean },
  ) => (
    <Field label={t.fields[key] ?? key} error={errors[key]}>
      {(props) => (
        <input
          {...props}
          className="input"
          value={values[key]}
          onChange={set(key)}
          maxLength={extra.maxLength}
          inputMode={extra.inputMode}
          // Данные вендора, а не сотрудника: подсказки браузера из своего профиля здесь мешают
          autoComplete="off"
          enterKeyHint="done"
          {...(extra.latin ? { autoCapitalize: "none", spellCheck: false } : {})}
          readOnly={readOnly}
          required={key === "name"}
        />
      )}
    </Field>
  );

  const phone = (key: "phone" | "phoneAlt") => (
    <Field label={t.fields[key] ?? key} error={errors[key]} hint={creating ? undefined : t.phoneKeep}>
      {(props) => (
        <input
          {...props}
          className="input"
          type="tel"
          inputMode="tel"
          autoComplete="off"
          placeholder={creating ? "+998 90 123 45 67" : t.phoneNew}
          value={values[key]}
          onChange={set(key)}
          maxLength={24}
          enterKeyHint="done"
          readOnly={readOnly}
        />
      )}
    </Field>
  );

  return (
    <form id={formId} ref={form} className="form" onSubmit={submit} noValidate>
      {readOnly ? <p className="notice">{t.vendorReadOnly}</p> : null}
      <section className="fs">
        <div className="fs-head">
          <h2>{t.vendorSections.business}</h2>
          <p>{t.vendorSections.businessHint}</p>
        </div>
        <div className="fields">
          {text("name", { maxLength: 120 })}
          <Field label={t.fields.legalForm ?? ""}>
            {(props) => (
              <Select
                {...props}
                className="input"
                label={t.fields.legalForm ?? ""}
                value={values.legalForm}
                onChange={put("legalForm")}
                disabled={readOnly}
                options={[
                  { value: "", label: t.none },
                  ...(["ooo", "yatt", "self_employed"] as const).map((form) => ({
                    value: form,
                    label: t.legalForms[form],
                  })),
                ]}
              />
            )}
          </Field>
          {text("legalName", { maxLength: 200 })}
          {text("stir", { maxLength: 9, inputMode: "numeric" })}
          {text("legalAddress", { maxLength: 300 })}
          {text("contractNo", { maxLength: 64 })}
          <Field label={t.fields.managerId ?? ""} error={errors.managerId}>
            {(props) => (
              <Select
                {...props}
                className="input"
                label={t.fields.managerId ?? ""}
                value={values.managerId}
                onChange={put("managerId")}
                disabled={readOnly}
                options={[
                  { value: "", label: t.noManager },
                  ...(dictionaries?.staff ?? []).map((member) => ({
                    value: member.id,
                    label: `${member.displayName} · ${t.roles[member.role]}`,
                  })),
                ]}
              />
            )}
          </Field>
        </div>
      </section>
      <section className="fs">
        <div className="fs-head">
          <h2>{t.vendorSections.contact}</h2>
          <p>{t.vendorSections.contactHint}</p>
        </div>
        <div className="fields">
          {text("contactPerson", { maxLength: 120 })}
          {text("contactRole", { maxLength: 80 })}
          {/* Номера только пишутся: без права правки полям «новый номер» здесь нечего делать */}
          {readOnly ? null : phone("phone")}
          {readOnly ? null : phone("phoneAlt")}
          {text("telegramUsername", { maxLength: 33, latin: true })}
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
            ) : null
          }
        />
      )}
    </form>
  );
}
