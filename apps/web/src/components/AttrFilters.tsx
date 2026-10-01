import type { Lang } from "@bayramm/shared";
import type { CategoryConfig, FilterSpec } from "@bayramm/shared/categories";
import { Checkbox, NumberStepper } from "@bayramm/ui/react";
import { useEffect, useId, useRef, useState } from "react";
import { catText } from "../categories";
import { useLang } from "../context";
import {
  type AttrFilters,
  type FilterValue,
  filterSpecs,
  filterValue,
  parseFilterInt,
  withFilter,
} from "../screens/catalog-filters";

/* Фильтры по полям витрины категории — из её описания (categoryFilters): галочка у «да/нет»,
   галочки вариантов у списков, число «не меньше / не больше» у чисел. Одна и та же форма —
   в колонке слева на компьютере и в шторке «Фильтры» на телефоне и планшете (id у каждой
   свои: useId). Каждое изменение сразу уходит в адрес и в выдачу. */

/** Подпись фильтра; у поля записи списка — с названием списка: «Автопарк: Класс» */
export function filterLabel(category: CategoryConfig, spec: FilterSpec, lang: Lang): string {
  const own = catText(lang, spec.label);
  if (spec.path.length < 2) return own;
  const list = category.attributes.find((a) => a.key === spec.path[0]);
  return list ? `${catText(lang, list.label)}: ${own}` : own;
}

// Пока человек печатает число, выдачу не дёргаем на каждую цифру
const INT_DEBOUNCE_MS = 600;

function IntFilter({
  label,
  spec,
  value,
  onCommit,
}: {
  label: string;
  spec: FilterSpec;
  value: number | null;
  onCommit: (value: number | null) => void;
}) {
  const { t } = useLang();
  const id = useId();
  const [text, setText] = useState(value === null ? "" : String(value));
  const commit = useRef(onCommit);
  commit.current = onCommit;
  const field = spec.field.type === "int" ? spec.field : null;

  useEffect(() => {
    setText(value === null ? "" : String(value));
  }, [value]);

  useEffect(() => {
    const parsed = parseFilterInt(spec, text);
    if (parsed === value || (text.trim() !== "" && parsed === null)) return;
    const timer = setTimeout(() => commit.current(parsed), INT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, value, spec]);

  if (!field) return null;
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <NumberStepper
        id={id}
        min={field.min}
        max={field.max}
        placeholder={t.anyGuestV}
        value={text}
        maxLength={String(field.max).length}
        aria-describedby={`${id}-hint`}
        onChange={setText}
        onBlur={() => {
          const parsed = parseFilterInt(spec, text);
          if (parsed !== value) onCommit(parsed);
        }}
      />
      <p className="fld-hint" id={`${id}-hint`}>
        {field.filter === "max" ? t.filterAtMost : t.filterAtLeast}
      </p>
    </div>
  );
}

function CodesFilter({
  label,
  spec,
  codes,
  onChange,
}: {
  label: string;
  spec: FilterSpec;
  codes: readonly string[];
  onChange: (codes: string[]) => void;
}) {
  const { t, lang } = useLang();
  const id = useId();
  const options = "options" in spec.field ? spec.field.options : [];
  // «Все из отмеченных» (команда фотографа) — подсказка, иначе отмеченные читаются как «любой»
  const all = spec.field.type === "multi" && spec.field.filter === "all";
  return (
    <fieldset className="filter-group" aria-describedby={all ? `${id}-hint` : undefined}>
      <legend className="field-label">{label}</legend>
      {options.map((option) => (
        <Checkbox
          key={option.code}
          className="filter-check"
          checked={codes.includes(option.code)}
          onChange={(on) =>
            onChange(on ? [...codes, option.code] : codes.filter((code) => code !== option.code))
          }
        >
          {catText(lang, option.label)}
        </Checkbox>
      ))}
      {all ? (
        <p className="fld-hint" id={`${id}-hint`}>
          {t.filterAll}
        </p>
      ) : null}
    </fieldset>
  );
}

/** Форма фильтров по полям витрины категории */
export function AttrFiltersForm({
  category,
  attrs,
  onChange,
}: {
  category: CategoryConfig;
  attrs: AttrFilters;
  onChange: (attrs: AttrFilters) => void;
}) {
  const { lang } = useLang();
  const set = (spec: FilterSpec, value: FilterValue) => onChange(withFilter(attrs, spec, value));
  return (
    <div className="attr-filters">
      {filterSpecs(category).map((spec) => {
        const value = filterValue(spec, attrs);
        const label = filterLabel(category, spec, lang);
        if (value.kind === "bool")
          return (
            <Checkbox
              key={spec.param}
              className="filter-check filter-bool"
              checked={value.on}
              onChange={(on) => set(spec, { kind: "bool", on })}
            >
              {label}
            </Checkbox>
          );
        if (value.kind === "int")
          return (
            <IntFilter
              key={spec.param}
              label={label}
              spec={spec}
              value={value.value}
              onCommit={(n) => set(spec, { kind: "int", value: n })}
            />
          );
        return (
          <CodesFilter
            key={spec.param}
            label={label}
            spec={spec}
            codes={value.codes}
            onChange={(codes) => set(spec, { kind: "codes", codes })}
          />
        );
      })}
    </div>
  );
}
