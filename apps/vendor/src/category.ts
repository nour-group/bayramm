/* Категория витрины глазами кабинета: подпись, модель занятости, части дня, цена услуги
   словами. Всё — из @bayramm/shared/categories (CATEGORIES и тексты категорий); здесь только
   то, что кабинет показывает одинаково на разных экранах. Неизвестная категория (новая в
   базе, а сборка старая) не ломает экран: подпись — код, занятость — календарь по частям. */

import type { Lang } from "@bayramm/shared";
import {
  type AvailabilityMode,
  categoryConfig,
  categoryText,
  type DayPart,
  type DayPartWindows,
  hasDayParts,
  type PriceUnit,
  priceUnitLabel,
  windowText,
} from "@bayramm/shared/categories";
import { formatMoney } from "./format";
import type { VendorDict } from "./i18n";

/** Название категории на языке кабинета: «Кортеж» */
export function categoryName(lang: Lang, code: string): string {
  const config = categoryConfig(code);
  return config === undefined ? code : categoryText(lang, config.label);
}

/** Модель занятости категории; неизвестная — календарь по частям дня */
export function availabilityOf(code: string): AvailabilityMode {
  return categoryConfig(code)?.availability ?? "parts";
}

/** Часть дня словами: «Вечер» */
export function partName(t: VendorDict, part: DayPart): string {
  return t[`part_${part}`];
}

/**
 * Части дня заявки словами: «Утро, вечер»; пусто — «Весь день». У категории без календаря
 * (срок заказа) — null: время дня там ни при чём
 */
export function partsLabel(
  t: VendorDict,
  categoryCode: string,
  parts: readonly DayPart[],
  windows?: DayPartWindows | null,
): string | null {
  const category = categoryConfig(categoryCode);
  if (category !== undefined && !hasDayParts(category)) return null;
  if (parts.length === 0) return t.wholeDay;
  return parts
    .map((part, i) => {
      const name = i === 0 ? partName(t, part) : partName(t, part).toLowerCase();
      // С окнами витрины — и время части: «Вечер 18:00–24:00»
      return windows ? `${name} ${windowText(windows[part])}` : name;
    })
    .join(", ");
}

/** Цена услуги или опции: «150 000 сум за час», «2,5 млн сум за мероприятие» */
export function priceText(uzs: number, unit: PriceUnit, t: VendorDict, lang: Lang): string {
  return `${formatMoney(uzs, t, lang)} ${priceUnitLabel(lang, unit)}`;
}
