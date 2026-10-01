import type { Dict, Lang } from "@bayramm/shared";
import type { DayPart } from "@bayramm/shared/api";
import {
  CATEGORIES,
  type CategoryConfig,
  type CategoryTextKey,
  categoryConfig,
  categoryText,
} from "@bayramm/shared/categories";
import type { IconName } from "./icons";
import { type CATEGORY_CODES, DEFAULT_CATEGORY } from "./routes";

/* Категории глазами клиента. Описание категории (поля витрины, форма заявки, услуги,
   модель занятости) — @bayramm/shared/categories: экраны строят по нему фильтры, витрину и
   форму, а не пишут их под каждую категорию. Здесь — что из описания нужно экранам:
   какие категории есть в каталоге, их значки и названия, есть ли у категории вместимость,
   район и календарь. */

/** Категории каталога: включённые, по порядку показа */
export const CLIENT_CATEGORIES: readonly CategoryConfig[] = CATEGORIES.filter((c) => c.enabled).sort(
  (a, b) => a.sort - b.sort,
);

/** Значок категории — смысловой, duotone */
const ICONS: Readonly<Record<(typeof CATEGORY_CODES)[number], IconName>> = {
  hall: "hall",
  car: "car",
  studio: "studio",
  flowers: "flowers",
  photo: "camera",
  cake: "cake",
  gifts: "gift",
  decor: "decor",
};

export const categoryIcon = (code: string): IconName =>
  (ICONS as Readonly<Record<string, IconName>>)[code] ?? "decor";

const DEFAULT = categoryConfig(DEFAULT_CATEGORY) as CategoryConfig;

/** Категория каталога по коду; неизвестная или выключенная — залы, как у API без параметра */
export function clientCategory(code: string | null | undefined): CategoryConfig {
  return CLIENT_CATEGORIES.find((c) => c.code === code) ?? DEFAULT;
}

/**
 * Название раздела каталога для клиента — короткое, из глоссария (t.catName: «Залы и тойханы»,
 * «Кортежи»): одно и то же в переключателе, плитках, заголовке каталога, карточках и заявках.
 * Категории без своего названия в глоссарии — название из её описания; неизвестный код — null
 */
export function categoryName(code: string | null | undefined, t: Dict, lang: Lang): string | null {
  if (!code) return null;
  const own = (t.catName as Readonly<Record<string, string | undefined>>)[code];
  if (own) return own;
  const config = categoryConfig(code);
  return config ? categoryText(lang, config.label) : null;
}

/** Подпись из словаря категорий (поля, варианты, услуги, опции) */
export const catText = (lang: Lang, key: CategoryTextKey): string => categoryText(lang, key);

/** Вместимость в гостях (cap_min, cap_max) — у залов: по ней фильтр «гости» и строка «до N гостей» */
export const hasCapacity = (category: CategoryConfig): boolean =>
  category.listingFields.includes("guest_capacity");

/** Район у карточки — у залов и студий: по нему фильтр «район» */
export const hasDistrict = (category: CategoryConfig): boolean => category.listingFields.includes("district");

/** Календарь занятости: у всех, кроме «заказ за N дней» (цветы, торты, подарки) */
export const hasCalendar = (category: CategoryConfig): boolean => category.availability !== "lead";

/** Число гостей в форме заявки: обязательно, по желанию или не спрашивается */
export const guestsMode = (category: CategoryConfig) => category.requestForm.guests;

/** Порядок частей дня — как в DAY_PARTS */
export const DAY_PART_ORDER: readonly DayPart[] = ["morning", "day", "evening"];
