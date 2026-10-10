/* Форма вендора: создание и правка. Телефоны только пишутся — текущий номер форма не
   знает (его видно только по «Показать»); пустое поле при правке — «не менять».
   При создании команда выбирает категорию: с ней заводится первая витрина вендора.
   Категория — у витрины, а не у вендора: при правке её здесь нет.
   Поля — под свои данные (fields.tsx): телефон с +998 и маской, Telegram с «@», СТИР —
   только цифры, форма — сегментами, менеджер — администраторы и менеджеры (нынешний остаётся
   в списке, даже если его отключили). Неполный номер, СТИР не из 9 цифр и не то имя Telegram
   видны до отправки — теми же словами, что ответил бы сервер. */

import { normalizeTelegram, normalizeUzPhone } from "@bayramm/shared";
import type { LegalForm, StaffDictionaries, VendorDetail, VendorInput } from "@bayramm/shared/api/staff";
import { Select } from "@bayramm/ui/react";
import { type FormEvent, useId, useState } from "react";
import type { Failure } from "../api";
import { categoryOptions } from "../categories";
import { ChoiceField, PhoneField, TelegramField } from "../fields";
import { t } from "../texts";
import { ErrorText, Field, FormBar, fieldErrors, useRevealErrors } from "../ui";
import { useUnsaved } from "../unsaved";

// Категория — у витрины: при создании она отдельным полем (categoryCode), при правке её нет
type Values = Record<Exclude<keyof VendorInput, "categoryCode">, string>;

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

const LEGAL_FORMS: readonly LegalForm[] = ["ooo", "yatt", "self_employed"];

/** Кого можно назначить менеджером вендора: ведут вендоров администратор и менеджер */
const MANAGER_ROLES: ReadonlySet<string> = new Set(["admin", "manager"]);

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
  // Телефоны: пустое поле — не трогать; вписанный — в виде +998XXXXXXXXX
  for (const key of ["phone", "phoneAlt"] as const) {
    const value = values[key].trim();
    if (value !== "") body[key] = normalizeUzPhone(value) ?? value;
  }
  return body as VendorInput;
}

/** Ошибки до отправки — те же поля, что в ответе 422: СТИР, телефоны, Telegram */
export function vendorErrors(values: Values): string[] {
  const errors: string[] = [];
  const stir = values.stir.trim();
  if (stir !== "" && !/^\d{9}$/.test(stir)) errors.push("stir");
  for (const key of ["phone", "phoneAlt"] as const)
    if (values[key].trim() !== "" && normalizeUzPhone(values[key]) === null) errors.push(key);
  const telegram = values.telegramUsername.trim();
  if (telegram !== "" && normalizeTelegram(telegram) === null) errors.push("telegramUsername");
  return errors;
}

interface VendorFormProps {
  vendor: VendorDetail | null;
  dictionaries: StaffDictionaries | null;
  /** Отправка: ответ API — ошибка для формы или null (успех) */
  onSubmit: (body: VendorInput) => Promise<Failure | null>;
  submitLabel: string;
  readOnly?: boolean;
}

const invalid = (details: string[]): Failure => ({ ok: false, status: 422, code: "invalid_input", details });

export function VendorForm({ vendor, dictionaries, onSubmit, submitLabel, readOnly }: VendorFormProps) {
  const [before, setBefore] = useState(() => initial(vendor));
  const [values, setValues] = useState(before);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [categoryCode, setCategoryCode] = useState("");
  const errors = fieldErrors(failure, { ...t.fieldErrors, categoryCode: t.categoryRequired });
  const creating = vendor === null;
  const form = useRevealErrors(failure);
  const formId = useId();
  // Есть несохранённое: на телефоне панель «Сохранить» появляется только тогда, а уход со
  // страницы переспросит
  const dirty = !readOnly && Object.keys(vendorBody(values, before, false)).length > 0;
  useUnsaved(dirty || (creating && categoryCode !== ""));

  const put = (key: keyof Values) => (value: string) => {
    setSaved(false);
    setValues((prev) => ({ ...prev, [key]: value }));
  };
  const set = (key: keyof Values) => (event: { target: { value: string } }) => put(key)(event.target.value);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // Без категории вендор остался бы без витрины: спрашиваем до запроса
    const found = [...(creating && categoryCode === "" ? ["categoryCode"] : []), ...vendorErrors(values)];
    if (found.length > 0) {
      setFailure(invalid(found));
      return;
    }
    setBusy(true);
    const body = vendorBody(values, before, creating);
    const result = await onSubmit(creating ? { ...body, categoryCode } : body);
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
    key: Exclude<(typeof TEXT_KEYS)[number], "telegramUsername" | "stir" | "legalAddress">,
    extra: { maxLength: number },
  ) => (
    <Field label={t.fields[key] ?? key} error={errors[key]}>
      {(props) => (
        <input
          {...props}
          className="input"
          value={values[key]}
          onChange={set(key)}
          maxLength={extra.maxLength}
          // Данные вендора, а не сотрудника: подсказки браузера из своего профиля здесь мешают
          autoComplete="off"
          enterKeyHint="done"
          readOnly={readOnly}
          required={key === "name"}
        />
      )}
    </Field>
  );

  const phone = (key: "phone" | "phoneAlt") => (
    <PhoneField
      label={t.fields[key] ?? key}
      value={values[key]}
      onChange={put(key)}
      error={errors[key]}
      hint={creating ? undefined : t.phoneKeep}
    />
  );

  // Менеджер — администраторы и менеджеры; нынешний остаётся в списке, даже если его отключили
  // или он модератор: иначе поле показало бы «не назначен», а в карточке он есть
  const staff = (dictionaries?.staff ?? []).filter((member) => MANAGER_ROLES.has(member.role));
  const current = vendor?.manager ?? null;
  const managerOptions = [
    { value: "", label: t.noManager },
    ...staff.map((member) => ({
      value: member.id,
      label: `${member.displayName} · ${t.roles[member.role]}`,
    })),
    ...(current && !staff.some((member) => member.id === current.id)
      ? [{ value: current.id, label: `${current.name ?? t.none} · ${t.input.managerInactive}` }]
      : []),
  ];

  return (
    <form id={formId} ref={form} className="form" onSubmit={submit} noValidate>
      {readOnly ? <p className="notice">{t.vendorReadOnly}</p> : null}
      <section className="fs">
        <div className="fs-head">
          <h2>{t.vendorSections.business}</h2>
          <p>{t.vendorSections.businessHint}</p>
        </div>
        <div className="fields">
          {creating && (
            <Field label={t.categoryFirst} error={errors.categoryCode} hint={t.categoryFirstHint}>
              {(props) => (
                <Select
                  {...props}
                  className="input"
                  label={t.categoryFirst}
                  placeholder={t.categoryRequired}
                  value={categoryCode === "" ? null : categoryCode}
                  onChange={(code) => {
                    setSaved(false);
                    setCategoryCode(code);
                    if (failure?.details.includes("categoryCode")) setFailure(null);
                  }}
                  options={categoryOptions()}
                />
              )}
            </Field>
          )}
          {text("name", { maxLength: 120 })}
          <ChoiceField
            label={t.fields.legalForm ?? ""}
            value={values.legalForm === "" ? null : (values.legalForm as LegalForm)}
            onChange={put("legalForm")}
            disabled={readOnly}
            options={LEGAL_FORMS.map((legal) => ({ value: legal, label: t.legalForms[legal] }))}
          />
          {text("legalName", { maxLength: 200 })}
          <Field label={t.fields.stir ?? ""} error={errors.stir} hint={t.input.stir}>
            {(props) => (
              <input
                {...props}
                className="input"
                value={values.stir}
                // Только цифры: буквы и пробелы из скопированного реестра не попадают в поле
                onChange={(event) => put("stir")(event.target.value.replace(/\D+/g, ""))}
                maxLength={9}
                inputMode="numeric"
                autoComplete="off"
                enterKeyHint="done"
                readOnly={readOnly}
              />
            )}
          </Field>
          <Field label={t.fields.managerId ?? ""} error={errors.managerId}>
            {(props) => (
              <Select
                {...props}
                className="input"
                label={t.fields.managerId ?? ""}
                value={values.managerId}
                onChange={put("managerId")}
                disabled={readOnly}
                options={managerOptions}
              />
            )}
          </Field>
          {text("contractNo", { maxLength: 64 })}
          <Field label={t.fields.legalAddress ?? ""} error={errors.legalAddress} full>
            {(props) => (
              <textarea
                {...props}
                className="input"
                rows={2}
                value={values.legalAddress}
                onChange={set("legalAddress")}
                maxLength={300}
                autoComplete="off"
                readOnly={readOnly}
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
          <TelegramField
            label={t.fields.telegramUsername ?? ""}
            value={values.telegramUsername}
            onChange={put("telegramUsername")}
            error={errors.telegramUsername}
            hint={t.input.telegramHint}
            readOnly={readOnly}
          />
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
