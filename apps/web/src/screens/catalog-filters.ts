import {
  ATTRIBUTE_FILTER_PREFIX,
  type CategoryConfig,
  categoryFilters,
  type FilterSpec,
  parseAttributeFilters,
} from "@bayramm/shared/categories";

/* Фильтры по полям витрины категории (a.<поле>, a.<список>.<поле>) — из описания категории
   (categoryFilters), а не вписаны под каждую: новое поле с фильтром появится в каталоге само.
   Значения живут в адресе как у API: bool — 1, варианты — коды через запятую, число — число.
   Модуль без React: его же проверяют тесты. */

export type AttrFilters = Readonly<Record<string, string>>;

export const NO_ATTRS: AttrFilters = {};

/** Значение фильтра для контрола: да/нет, выбранные коды или число */
export type FilterValue =
  | { readonly kind: "bool"; readonly on: boolean }
  | { readonly kind: "codes"; readonly codes: readonly string[] }
  | { readonly kind: "int"; readonly value: number | null };

/** Фильтры категории для формы: в порядке полей витрины */
export function filterSpecs(category: CategoryConfig): FilterSpec[] {
  return categoryFilters(category);
}

/**
 * Фильтры по полям витрины из адреса: только фильтры этой категории и только верные значения
 * (по тем же правилам, что у API: parseAttributeFilters). Неверный отбрасывается по одному —
 * чужой или испорченный параметр не ломает выдачу (иначе API ответит 400)
 */
export function readAttrFilters(category: CategoryConfig, query: URLSearchParams): AttrFilters {
  const out: Record<string, string> = {};
  for (const spec of categoryFilters(category)) {
    const value = query.get(spec.param);
    if (value === null || value === "") continue;
    const parsed = parseAttributeFilters(category, { [spec.param]: [value] });
    // Пустой результат — «нет» у галочки (0, false): в адресе он не нужен
    if (parsed.ok && parsed.value.length > 0) out[spec.param] = value;
  }
  return out;
}

/** Значение фильтра для контрола */
export function filterValue(spec: FilterSpec, attrs: AttrFilters): FilterValue {
  const raw = attrs[spec.param];
  switch (spec.field.type) {
    case "bool":
      return { kind: "bool", on: raw === "1" || raw === "true" };
    case "int":
      return { kind: "int", value: raw === undefined ? null : Number(raw) };
    case "enum":
    case "multi":
      return { kind: "codes", codes: raw ? raw.split(",") : [] };
    case "text":
      // У текста фильтров нет (categoryFilters их не отдаёт)
      return { kind: "codes", codes: [] };
  }
}

/** Фильтры с новым значением одного из них; пустое значение убирает фильтр из адреса */
export function withFilter(attrs: AttrFilters, spec: FilterSpec, value: FilterValue): AttrFilters {
  const next: Record<string, string> = { ...attrs };
  delete next[spec.param];
  if (value.kind === "bool" && value.on) next[spec.param] = "1";
  if (value.kind === "int" && value.value !== null) next[spec.param] = String(value.value);
  if (value.kind === "codes" && value.codes.length > 0) {
    // Порядок — как в описании поля: одинаковый выбор — одинаковый адрес
    const options = "options" in spec.field ? spec.field.options : [];
    next[spec.param] = options
      .map((o) => o.code)
      .filter((code) => value.codes.includes(code))
      .join(",");
  }
  return next;
}

/** Сколько фильтров по полям витрины задано — число на кнопке «Фильтры» */
export const attrFilterCount = (attrs: AttrFilters): number =>
  Object.keys(attrs).filter((key) => key.startsWith(ATTRIBUTE_FILTER_PREFIX)).length;

/** Число из поля фильтра: в границах поля, иначе null (пусто) */
export function parseFilterInt(spec: FilterSpec, text: string): number | null {
  if (spec.field.type !== "int" || !/^\d{1,9}$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= spec.field.min && n <= spec.field.max ? n : null;
}
