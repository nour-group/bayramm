import type { CategoryDict, CategoryTextKey, Lang } from "./dict";
import { categoriesRu } from "./ru";
import { categoriesUz } from "./uz";

export type { CategoryDict, CategoryTextKey } from "./dict";
export { categoriesRu } from "./ru";
export { categoriesUz } from "./uz";

/** Тексты категорий по языкам */
export const categoryDictionaries: Readonly<Record<Lang, CategoryDict>> = {
  ru: categoriesRu,
  uz: categoriesUz,
};

/** Текст по ключу на языке */
export function categoryText(lang: Lang, key: CategoryTextKey): string {
  return categoryDictionaries[lang][key];
}

/** Текст на обоих языках: { ru, uz } — для API, сида базы и полей с двумя языками */
export function categoryTexts(key: CategoryTextKey): { readonly ru: string; readonly uz: string } {
  return { ru: categoriesRu[key], uz: categoriesUz[key] };
}
