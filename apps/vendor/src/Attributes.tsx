/* Поля витрины (attributes) — форма из конфигурации категории (@bayramm/shared/categories),
   а не своя под каждую категорию: число — NumberStepper, да/нет — Checkbox, один вариант —
   Select, несколько — группа галочек, текст — поле (на двух языках — два), список (автопарк
   кортежа) — записи с «добавить» и «убрать». Значения в форме — как их держат поля
   (attributeDrafts), в правку уходят только изменённые (attributePatch, Proposal.tsx).

   Ошибки — пути как в ответе API: attributes.fleet.0.class подсвечивает поле записи, запись
   и весь список. Обязательные поля помечены; чего не хватает для публикации — блок готовности
   на экране площадки (missingAttributes). Плюс показ полей словами (AttributeFacts). */

import type { Lang } from "@bayramm/shared";
import type { ListingAttributes } from "@bayramm/shared/api/vendor";
import {
  type AttributeDraft,
  type AttributeDrafts,
  type AttributeField,
  attributeText,
  type CategoryConfig,
  categoryText,
  choiceLabel,
  emptyListItem,
  type ListField,
  type ListItemDraft,
  type ListItemField,
} from "@bayramm/shared/categories";
import { Checkbox, NumberStepper, Select } from "@bayramm/ui/react";
import { fill, type VendorDict } from "./i18n";

/** Подпись поля; обязательное — с пометкой */
function labelOf(field: AttributeField | ListItemField, t: VendorDict, lang: Lang): string {
  const label = categoryText(lang, field.label);
  return field.required ? `${label} (${t.required})` : label;
}

/** Длина числа в поле: по верхней границе */
const digits = (max: number) => String(max).length;

interface ScalarProps {
  readonly field: AttributeField | ListItemField;
  readonly value: string | boolean | undefined;
  readonly onChange: (value: string | boolean) => void;
  readonly id: string;
  readonly invalid: boolean;
  readonly errorId: string | undefined;
  readonly t: VendorDict;
  readonly lang: Lang;
  /** Подпись для диктора с номером записи списка: «Модель, № 2» */
  readonly suffix?: string;
}

/** Одно значение: число, да/нет, вариант, строка */
function Scalar({ field, value, onChange, id, invalid, errorId, t, lang, suffix }: ScalarProps) {
  const label = labelOf(field, t, lang);
  const spoken = suffix ? `${label}, ${suffix}` : label;
  switch (field.type) {
    case "bool":
      return (
        <Checkbox
          id={id}
          checked={value === true}
          onChange={onChange}
          aria-invalid={invalid}
          aria-describedby={errorId}
        >
          {categoryText(lang, field.label)}
        </Checkbox>
      );
    case "int":
      return (
        <div className="form-row">
          <label className="field-label" htmlFor={id}>
            {label}
          </label>
          <NumberStepper
            id={id}
            value={typeof value === "string" ? value : ""}
            min={field.min}
            max={field.max}
            maxLength={digits(field.max)}
            onChange={onChange}
            decrementLabel={`${spoken}: ${t.capacityLess}`}
            incrementLabel={`${spoken}: ${t.capacityMore}`}
            aria-invalid={invalid}
            aria-describedby={errorId}
          />
        </div>
      );
    case "enum":
      return (
        <div className="form-row">
          <label className="field-label" htmlFor={id}>
            {label}
          </label>
          <Select
            id={id}
            label={spoken}
            placeholder={t.notChosen}
            value={typeof value === "string" && value !== "" ? value : null}
            options={[
              // Необязательное поле можно и очистить
              ...(field.required ? [] : [{ value: "", label: t.notChosen }]),
              ...field.options.map((option) => ({
                value: option.code,
                label: categoryText(lang, option.label),
              })),
            ]}
            onChange={onChange}
            aria-invalid={invalid}
            aria-describedby={errorId}
          />
        </div>
      );
    case "text":
      return (
        <div className="form-row">
          <label className="field-label" htmlFor={id}>
            {label}
          </label>
          <input
            id={id}
            className="field"
            maxLength={field.maxLength}
            autoComplete="off"
            value={typeof value === "string" ? value : ""}
            aria-invalid={invalid || undefined}
            aria-describedby={errorId}
            onChange={(event) => onChange(event.target.value)}
          />
        </div>
      );
  }
}

interface AttributesFormProps {
  readonly category: CategoryConfig;
  readonly drafts: AttributeDrafts;
  readonly onChange: (key: string, value: AttributeDraft) => void;
  /** Неверные поля — пути из проверки или ответа API: attributes.fleet.0.class */
  readonly invalid: ReadonlySet<string>;
  readonly t: VendorDict;
  readonly lang: Lang;
  readonly idPrefix: string;
}

export function AttributesForm({
  category,
  drafts,
  onChange,
  invalid,
  t,
  lang,
  idPrefix,
}: AttributesFormProps) {
  const bad = (path: string) => [...invalid].some((p) => p === path || p.startsWith(`${path}.`));
  const error = (path: string) =>
    bad(path) ? (
      <p className="field-error" id={`${idPrefix}-${path}-error`}>
        {t.fieldInvalid}
      </p>
    ) : null;
  const errorId = (path: string) => (bad(path) ? `${idPrefix}-${path}-error` : undefined);

  const list = (field: ListField, items: readonly ListItemDraft[]) => {
    const path = `attributes.${field.key}`;
    const setItem = (index: number, key: string, value: string | boolean) =>
      onChange(
        field.key,
        items.map((item, i) => (i === index ? { ...item, [key]: value } : item)),
      );
    return (
      <fieldset key={field.key} className="choices attr-list" aria-describedby={errorId(path)}>
        <legend className="panel-title">{labelOf(field, t, lang)}</legend>
        {items.map((item, index) => {
          const rowPath = `${path}.${index}`;
          const n = fill(t.listItemTitle, { n: index + 1 });
          return (
            // Записи без своего id: номер записи и есть её место в списке
            // biome-ignore lint/suspicious/noArrayIndexKey: запись списка — по месту
            <div key={index} className={bad(rowPath) ? "package-row package-row-bad" : "package-row"}>
              <p className="package-kind">{n}</p>
              <div className="form-grid">
                {field.fields.map((sub) => {
                  const subPath = `${rowPath}.${sub.key}`;
                  return (
                    <div key={sub.key} className="form-row">
                      <Scalar
                        field={sub}
                        value={item[sub.key]}
                        onChange={(value) => setItem(index, sub.key, value)}
                        id={`${idPrefix}-${field.key}-${index}-${sub.key}`}
                        invalid={bad(subPath)}
                        errorId={errorId(subPath)}
                        t={t}
                        lang={lang}
                        suffix={n}
                      />
                      {error(subPath)}
                    </div>
                  );
                })}
              </div>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() =>
                  onChange(
                    field.key,
                    items.filter((_, i) => i !== index),
                  )
                }
              >
                {fill(t.listRemove, { n: index + 1 })}
              </button>
            </div>
          );
        })}
        {bad(path) && !items.some((_, i) => bad(`${path}.${i}`)) ? error(path) : null}
        {items.length < field.maxItems ? (
          <button
            type="button"
            className="btn btn-ghost attr-add"
            onClick={() => onChange(field.key, [...items, emptyListItem(field)])}
          >
            {t.listAdd}: {categoryText(lang, field.label)}
          </button>
        ) : null}
      </fieldset>
    );
  };

  return (
    <div className="attr-form">
      {category.attributes.map((field) => {
        const draft = drafts[field.key];
        const path = `attributes.${field.key}`;
        const id = `${idPrefix}-${field.key}`;
        if (field.type === "list") return list(field, Array.isArray(draft) ? (draft as ListItemDraft[]) : []);
        if (field.type === "multi") {
          const chosen = new Set(Array.isArray(draft) ? (draft as string[]) : []);
          return (
            <fieldset key={field.key} className="choices attr-multi" aria-describedby={errorId(path)}>
              <legend className="field-label">{labelOf(field, t, lang)}</legend>
              <div className="attr-checks">
                {field.options.map((option) => (
                  <Checkbox
                    key={option.code}
                    checked={chosen.has(option.code)}
                    aria-invalid={bad(path)}
                    onChange={(on) => {
                      const next = new Set(chosen);
                      if (on) next.add(option.code);
                      else next.delete(option.code);
                      onChange(
                        field.key,
                        field.options.map((o) => o.code).filter((code) => next.has(code)),
                      );
                    }}
                  >
                    {choiceLabel(lang, field.options, option.code)}
                  </Checkbox>
                ))}
              </div>
              {error(path)}
            </fieldset>
          );
        }
        if (field.type === "text" && field.localized) {
          const value =
            typeof draft === "object" && draft !== null && !Array.isArray(draft)
              ? (draft as { ru: string; uz: string })
              : { ru: "", uz: "" };
          const label = categoryText(lang, field.label);
          const area = field.maxLength > 120;
          const input = (which: "ru" | "uz") => {
            const props = {
              id: `${id}-${which}`,
              className: "field",
              lang: which,
              maxLength: field.maxLength,
              value: value[which],
              "aria-invalid": bad(path) || undefined,
              "aria-describedby": errorId(path),
              onChange: (event: { target: { value: string } }) =>
                onChange(field.key, { ...value, [which]: event.target.value }),
            };
            return (
              <div className="form-row">
                <label className="field-label" htmlFor={props.id}>
                  {fill(which === "ru" ? t.textRu : t.textUz, { label })}
                  {field.required ? ` (${t.required})` : ""}
                </label>
                {area ? <textarea {...props} rows={3} /> : <input {...props} autoComplete="off" />}
              </div>
            );
          };
          return (
            <div key={field.key} className="form-grid">
              {input("ru")}
              {input("uz")}
              {error(path)}
            </div>
          );
        }
        return (
          <div key={field.key} className={field.type === "bool" ? "attr-flag" : "form-row"}>
            <Scalar
              field={field}
              value={typeof draft === "string" || typeof draft === "boolean" ? draft : undefined}
              onChange={(value) => onChange(field.key, value)}
              id={id}
              invalid={bad(path)}
              errorId={errorId(path)}
              t={t}
              lang={lang}
            />
            {error(path)}
          </div>
        );
      })}
    </div>
  );
}

/** Поля витрины словами: заполненные — «подпись: значение», да/нет — только «да» */
export function AttributeFacts({
  category,
  attributes,
  t,
  lang,
}: {
  category: CategoryConfig;
  attributes: ListingAttributes | Readonly<Record<string, unknown>>;
  t: VendorDict;
  lang: Lang;
}) {
  const rows = category.attributes
    .filter((field) => Object.hasOwn(attributes, field.key))
    .map((field) => ({
      key: field.key,
      label: categoryText(lang, field.label),
      value: attributeText(lang, field, attributes[field.key], t.yes) ?? t.notSet,
    }));
  if (rows.length === 0) return null;
  return (
    <dl className="detail-rows">
      {rows.map((row) => (
        <div key={row.key}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
