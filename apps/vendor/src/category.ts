/* Категория витрины глазами кабинета: подпись, модель занятости, части дня, цена услуги
   словами. Всё — из @bayramm/shared/categories (CATEGORIES и тексты категорий); здесь только
   то, что кабинет показывает одинаково на разных экранах. Неизвестная категория (новая в
   базе, а сборка старая) не ломает экран: подпись — код, занятость — день целиком. */

import type { Lang } from "@bayramm/shared";
import {
  type AvailabilityMode,
  type CategoryConfig,
  categoryConfig,
  categoryText,
  type DayPart,
  DEFAULT_DAY_PARTS,
  dayPartWindows,
  type PriceUnit,
  priceUnitLabel,
} from "@bayramm/shared/categories";
import { formatMoney } from "./format";
import type { VendorDict } from "./i18n";

/** Название категории на языке кабинета: «Кортеж» */
export function categoryName(lang: Lang, code: string): string {
  const config = categoryConfig(code);
  return config === undefined ? code : categoryText(lang, config.label);
}

/** Модель занятости категории; неизвестная — день целиком, как у залов */
export function availabilityOf(code: string): AvailabilityMode {
  return categoryConfig(code)?.availability ?? "day";
}

/** Часть дня словами: «Вечер» */
export function partName(t: VendorDict, part: DayPart): string {
  return t[`part_${part}`];
}

/** Окно части дня категории: «17:00–24:00» */
export function partWindow(category: CategoryConfig | undefined, part: DayPart): string {
  const window = (category === undefined ? DEFAULT_DAY_PARTS : dayPartWindows(category))[part];
  return `${window.from}–${window.to}`;
}

/** Цена услуги или опции: «150 000 сум за час», «2,5 млн сум за мероприятие» */
export function priceText(uzs: number, unit: PriceUnit, t: VendorDict, lang: Lang): string {
  return `${formatMoney(uzs, t, lang)} ${priceUnitLabel(lang, unit)}`;
}
