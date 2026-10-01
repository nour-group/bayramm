import type { Lang } from "../dict";
import type { categoriesRu } from "./ru";

/**
 * Тексты конфигурации категорий. Тип выводится из русского словаря, узбекский объявлен
 * этим типом — лишний или пропущенный ключ не скомпилируется. Значения — только строки.
 */
export type CategoryDict = { readonly [K in keyof typeof categoriesRu]: string };

/** Ключ текста конфигурации категорий: подписи полей, услуг, вариантов */
export type CategoryTextKey = keyof CategoryDict;

export type { Lang };
