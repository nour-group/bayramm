/* Категории в панели: подписи по-русски из конфигурации (@bayramm/shared/categories), а не
   из справочника базы — те же ключи видят кабинет и клиент. Панель только на русском. */

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

/** Категории, в которых можно завести витрину, — в порядке показа */
export const ENABLED_CATEGORIES: readonly CategoryConfig[] = CATEGORIES.filter((c) => c.enabled);

/** Название категории по-русски; неизвестный код — сам код */
export function categoryName(code: string): string {
  const category = categoryConfig(code);
  return category === undefined ? code : categoryText("ru", category.label);
}

/** Варианты выбора категории: только включённые */
export function categoryOptions(): { value: string; label: string }[] {
  return ENABLED_CATEGORIES.map((c) => ({ value: c.code, label: categoryText("ru", c.label) }));
}

/** «за час» — подпись единицы цены */
export function unitName(unit: PriceUnit): string {
  return priceUnitLabel("ru", unit);
}

/** Окно части дня категории: «05:00–11:00» */
export function partWindow(category: CategoryConfig, part: DayPart): string {
  const window = dayPartWindows(category)[part];
  return `${window.from}–${window.to}`;
}

/** Строка из подписи по-русски: поля, услуги, варианты */
export const ru = (key: Parameters<typeof categoryText>[1]): string => categoryText("ru", key);
