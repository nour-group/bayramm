/* Данные витрины — поля категории из конфигурации (@bayramm/shared/categories): форма не
   пишется под каждую категорию, а строится по описанию полей. Число — текстовым полем с
   цифровой клавиатурой, да/нет — галочкой, один вариант — списком, несколько — галочками,
   текст на двух языках — двумя полями, список (автопарк) — записями с «Добавить» и «Убрать».
   Ошибки — по путям ответа API и проверки формы: «attributes.fleet.0.class». */

import type { AttributeField, CategoryConfig, ListField, ListItemField } from "@bayramm/shared/categories";
import {
  type AttributeDraft,
  type AttributeDrafts,
  emptyListItem,
  type ListItemDraft,
} from "@bayramm/shared/categories";
import { Checkbox, Select } from "@bayramm/ui/react";
import { useId } from "react";
import { ru } from "../categories";
import { t } from "../texts";
import { Field } from "../ui";

interface AttributeFieldsProps {
  category: CategoryConfig;
  drafts: AttributeDrafts;
  onChange: (key: string, draft: AttributeDraft) => void;
  /** Пути ошибок: attributes.<поле>[.<номер>.<поле записи>] */
  errors: readonly string[];
  /** Обязательные поля без значения — подсказка «обязательно» у них */
  missing: readonly string[];
  readOnly?: boolean;
}

/** Текст ошибки поля: у числа — границы, у остального — «проверьте значение» */
function errorText(field: AttributeField | ListItemField): string {
  return field.type === "int" ? t.attributeIntError(field.min, field.max) : t.attributeError;
}

export function AttributeFields({
  category,
  drafts,
  onChange,
  errors,
  missing,
  readOnly,
}: AttributeFieldsProps) {
  const has = (path: string) => errors.includes(path);
  return (
    <div className="fields">
      {category.attributes.map((field) => {
        const path = `attributes.${field.key}`;
        const draft = drafts[field.key];
        const label = ru(field.label);
        const hint = field.required && missing.includes(field.key) ? t.required : undefined;
        const error = has(path) ? errorText(field) : undefined;
        switch (field.type) {
          case "int":
          case "enum":
            return (
              <Scalar
                key={field.key}
                field={field}
                label={label}
                value={typeof draft === "string" ? draft : ""}
                error={error}
                hint={hint}
                readOnly={readOnly}
                onChange={(value) => onChange(field.key, value)}
              />
            );
          case "bool":
            return (
              <div key={field.key} className="field attr-bool">
                <Checkbox
                  checked={draft === true}
                  disabled={readOnly}
                  onChange={(checked) => onChange(field.key, checked)}
                >
                  {label}
                </Checkbox>
              </div>
            );
          case "multi": {
            const chosen = Array.isArray(draft) ? (draft as readonly string[]) : [];
            return (
              <fieldset key={field.key} className={`attr-group field-full${error ? " field-bad" : ""}`}>
                <legend>{label}</legend>
                {error || hint ? (
                  <p className={error ? "field-error" : "field-hint"}>{error ?? hint}</p>
                ) : null}
                <div className="attr-options">
                  {field.options.map((option) => (
                    <Checkbox
                      key={option.code}
                      checked={chosen.includes(option.code)}
                      disabled={readOnly}
                      aria-invalid={Boolean(error)}
                      onChange={(checked) =>
                        onChange(
                          field.key,
                          checked ? [...chosen, option.code] : chosen.filter((code) => code !== option.code),
                        )
                      }
                    >
                      {ru(option.label)}
                    </Checkbox>
                  ))}
                </div>
              </fieldset>
            );
          }
          case "text":
            if (!field.localized) {
              return (
                <Field key={field.key} label={label} error={error} hint={hint}>
                  {(props) => (
                    <input
                      {...props}
                      className="input"
                      value={typeof draft === "string" ? draft : ""}
                      maxLength={field.maxLength}
                      autoComplete="off"
                      readOnly={readOnly}
                      onChange={(event) => onChange(field.key, event.target.value)}
                    />
                  )}
                </Field>
              );
            }
            return (
              <Localized
                key={field.key}
                label={label}
                maxLength={field.maxLength}
                value={
                  typeof draft === "object" && !Array.isArray(draft)
                    ? (draft as { ru: string; uz: string })
                    : { ru: "", uz: "" }
                }
                error={error}
                hint={hint}
                readOnly={readOnly}
                onChange={(value) => onChange(field.key, value)}
              />
            );
          case "list":
            return (
              <ListEditor
                key={field.key}
                field={field}
                label={label}
                items={Array.isArray(draft) ? (draft as readonly ListItemDraft[]) : []}
                errors={errors}
                hint={hint}
                readOnly={readOnly}
                onChange={(items) => onChange(field.key, items)}
              />
            );
        }
        return null;
      })}
    </div>
  );
}

interface ScalarProps {
  field: ListItemField;
  label: string;
  value: string;
  error: string | undefined;
  hint?: string | undefined;
  readOnly: boolean | undefined;
  onChange: (value: string) => void;
}

/** Число, вариант или строка текста — одно поле */
function Scalar({ field, label, value, error, hint, readOnly, onChange }: ScalarProps) {
  return (
    <Field label={label} error={error} hint={hint}>
      {(props) =>
        field.type === "enum" ? (
          <Select
            {...props}
            className="input"
            label={label}
            value={value}
            disabled={readOnly}
            onChange={onChange}
            options={[
              { value: "", label: t.none },
              ...field.options.map((option) => ({ value: option.code, label: ru(option.label) })),
            ]}
          />
        ) : (
          <input
            {...props}
            className="input"
            value={value}
            inputMode={field.type === "int" ? "numeric" : undefined}
            maxLength={field.type === "int" ? 6 : field.type === "text" ? field.maxLength : 200}
            autoComplete="off"
            enterKeyHint="done"
            readOnly={readOnly}
            onChange={(event) => onChange(event.target.value)}
          />
        )
      }
    </Field>
  );
}

interface LocalizedProps {
  label: string;
  value: { ru: string; uz: string };
  maxLength: number;
  error: string | undefined;
  hint: string | undefined;
  readOnly: boolean | undefined;
  onChange: (value: { ru: string; uz: string }) => void;
}

/** Текст для клиентов на двух языках: клиент видит свой */
function Localized({ label, value, maxLength, error, hint, readOnly, onChange }: LocalizedProps) {
  return (
    <>
      {(["ru", "uz"] as const).map((lang) => (
        <Field key={lang} label={`${label} (${lang.toUpperCase()})`} error={error} hint={hint}>
          {(props) => (
            <textarea
              {...props}
              className="input"
              lang={lang}
              rows={2}
              value={value[lang]}
              maxLength={maxLength}
              readOnly={readOnly}
              onChange={(event) => onChange({ ...value, [lang]: event.target.value })}
            />
          )}
        </Field>
      ))}
    </>
  );
}

interface ListEditorProps {
  field: ListField;
  label: string;
  items: readonly ListItemDraft[];
  errors: readonly string[];
  hint: string | undefined;
  readOnly: boolean | undefined;
  onChange: (items: ListItemDraft[]) => void;
}

/** Список однотипных записей — автопарк: у каждой записи свои поля и «Убрать» */
function ListEditor({ field, label, items, errors, hint, readOnly, onChange }: ListEditorProps) {
  const headId = useId();
  const listError = errors.includes(`attributes.${field.key}`);
  const put = (index: number, key: string, value: string | boolean) =>
    onChange(items.map((item, i) => (i === index ? { ...item, [key]: value } : item)));
  return (
    <fieldset className={`attr-list field-full${listError ? " field-bad" : ""}`} aria-describedby={headId}>
      <legend>{label}</legend>
      <p id={headId} className={listError ? "field-error" : "field-hint"}>
        {listError ? t.attributeError : (hint ?? t.listLimit(field.maxItems))}
      </p>
      {items.length === 0 ? <p className="muted small">{t.listEmpty}</p> : null}
      {items.map((item, index) => {
        const title = t.listItem(label, index + 1);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: у записи нет своего id — порядок и есть её место
          <section key={index} className="attr-item" aria-label={title}>
            <p className="attr-item-title">{title}</p>
            <div className="fields">
              {field.fields.map((sub) => {
                const subLabel = ru(sub.label);
                const error = errors.includes(`attributes.${field.key}.${index}.${sub.key}`)
                  ? errorText(sub)
                  : undefined;
                const value = item[sub.key];
                if (sub.type === "bool") {
                  return (
                    <div key={sub.key} className="field attr-bool">
                      <Checkbox
                        checked={value === true}
                        disabled={readOnly}
                        onChange={(checked) => put(index, sub.key, checked)}
                      >
                        {subLabel}
                      </Checkbox>
                    </div>
                  );
                }
                return (
                  <Scalar
                    key={sub.key}
                    field={sub}
                    label={subLabel}
                    value={typeof value === "string" ? value : ""}
                    error={error}
                    hint={sub.required ? t.required : undefined}
                    readOnly={readOnly}
                    onChange={(next) => put(index, sub.key, next)}
                  />
                );
              })}
            </div>
            {readOnly ? null : (
              <div>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => onChange(items.filter((_, i) => i !== index))}
                >
                  {t.listRemove}
                  <span className="visually-hidden">: {title}</span>
                </button>
              </div>
            )}
          </section>
        );
      })}
      {readOnly || items.length >= field.maxItems ? null : (
        <div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => onChange([...items, emptyListItem(field)])}
          >
            {t.listAdd}: {label.toLowerCase()}
          </button>
        </div>
      )}
    </fieldset>
  );
}
