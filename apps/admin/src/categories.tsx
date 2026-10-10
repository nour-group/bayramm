/* Категории в панели: подписи по-русски из конфигурации (@bayramm/shared/categories), а не
   из справочника базы — те же ключи видят кабинет и клиент. Панель только на русском.
   Конфигурация категорий нужна только экранам вендоров, витрин, модерации и заявок — этот
   модуль импортируют лишь они, в основную часть сборки (оболочка, вход) он не попадает. */

import {
  CATEGORIES,
  type CategoryConfig,
  categoryConfig,
  categoryText,
  type DayPart,
  dayPartWindows,
  type PriceUnit,
  priceUnitLabel,
} from "@bayramm/shared/categories";
import { formatSum } from "./format";
import { t } from "./texts";

/** Категории, в которых можно завести витрину, — в порядке показа */
export const ENABLED_CATEGORIES: readonly CategoryConfig[] = CATEGORIES.filter((c) => c.enabled).sort(
  (a, b) => a.sort - b.sort,
);

/** Название категории по-русски; неизвестный код — сам код */
export function categoryName(code: string): string {
  const category = categoryConfig(code);
  return category === undefined ? code : categoryText("ru", category.label);
}

/** Варианты выбора категории: только включённые */
export function categoryOptions(): { value: string; label: string }[] {
  return ENABLED_CATEGORIES.map((c) => ({ value: c.code, label: categoryText("ru", c.label) }));
}

/** Код включённой категории из адреса (?category=) — или null: чужой код фильтром не станет */
export function knownCategory(code: string | undefined): string | null {
  return code !== undefined && ENABLED_CATEGORIES.some((c) => c.code === code) ? code : null;
}

/** «за час» — подпись единицы цены: одна на панель, кабинет и клиента (словарь категорий) */
export function unitName(unit: PriceUnit): string {
  return priceUnitLabel("ru", unit);
}

/** 150000 и за гостя → «150 000 сум за гостя»; без цены — прочерк */
export function formatPrice(value: number | null, unit: PriceUnit): string {
  return value === null ? t.none : `${formatSum(value)} ${unitName(unit)}`;
}

/** Окно части дня категории: «05:00–11:00» */
export function partWindow(category: CategoryConfig, part: DayPart): string {
  const window = dayPartWindows(category)[part];
  return `${window.from}–${window.to}`;
}

/** Категория витрины — плашкой рядом с названием */
export function CategoryChip({ code }: { code: string }) {
  return <span className="cat-chip">{categoryName(code)}</span>;
}

/** Строка из подписи по-русски: поля, услуги, варианты */
export const ru = (key: Parameters<typeof categoryText>[1]): string => categoryText("ru", key);
