/* Поля витрины в документе поиска: текстовые значения (марка машины в автопарке, зоны студии,
   часы работы) — по конфигурации категории. Коды вариантов (enum, multi) не ищутся: это коды, а
   не слова клиента. В базе то же делает app.listing_attrs_text (её пути собирает sql.ts из этой же
   конфигурации; тест сверяет миграцию). */

import { CATEGORIES } from "../categories/config";
import type { CategoryConfig } from "../categories/types";

/** Путь к текстовому значению: поле, поле записи списка; localized — { ru, uz } */
export interface AttrTextPath {
  readonly key: string;
  readonly sub?: string;
  readonly localized: boolean;
}

/** Текстовые поля категории в порядке конфигурации */
export function attrTextPaths(category: CategoryConfig): AttrTextPath[] {
  return category.attributes.flatMap((field): AttrTextPath[] => {
    if (field.type === "text") return [{ key: field.key, localized: field.localized }];
    if (field.type === "list")
      return field.fields
        .filter((sub) => sub.type === "text")
        .map((sub) => ({ key: field.key, sub: sub.key, localized: false }));
    return [];
  });
}

/** JSONPath значения в app.listings.attributes (как в SQL) */
export function attrTextJsonPath(path: AttrTextPath): string {
  if (path.sub !== undefined) return `$."${path.key}"[*]."${path.sub}"`;
  return path.localized ? `$."${path.key}".*` : `$."${path.key}"`;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Строки по пути — в том порядке, что и jsonb_path_query */
function valuesAt(attributes: Readonly<Record<string, unknown>>, path: AttrTextPath): string[] {
  const value = attributes[path.key];
  if (path.sub !== undefined) {
    const items = Array.isArray(value) ? value : [value];
    return items.flatMap((item) => {
      const sub = isRecord(item) ? item[path.sub as string] : undefined;
      return typeof sub === "string" ? [sub] : [];
    });
  }
  if (path.localized) {
    // У jsonb ключи одной длины — по алфавиту: ru, затем uz
    if (!isRecord(value)) return [];
    return Object.keys(value)
      .sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
      .flatMap((key) => (typeof value[key] === "string" ? [value[key] as string] : []));
  }
  return typeof value === "string" ? [value] : [];
}

/** Текстовые значения полей витрины одной строкой (до нормализации) — как app.listing_attrs_text */
export function listingAttrText(categoryCode: string, attributes: unknown): string {
  const category = CATEGORIES.find((c) => c.code === categoryCode);
  if (category === undefined || !isRecord(attributes)) return "";
  return attrTextPaths(category)
    .flatMap((path) => valuesAt(attributes, path))
    .join(" ");
}
