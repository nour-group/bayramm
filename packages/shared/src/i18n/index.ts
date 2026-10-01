import type { Dict, Lang } from "./dict";
import { ru } from "./ru";
import { uz } from "./uz";

export type { Dict, DictKey, Lang } from "./dict";
export { GLOSSARY_FORBIDDEN, glossaryRu } from "./glossary";
export { ruPlural } from "./plural";
export { type Block, type Inline, inlineText, type RichText, richText } from "./rich";
export { ru } from "./ru";
export { uz } from "./uz";
export { hasNonCanonicalApostrophe, normalizeUz, UZ_OKINA, UZ_TUTUQ } from "./uz-apostrophe";

/** Словари клиентского приложения по языкам */
export const dictionaries: Readonly<Record<Lang, Dict>> = { ru, uz };

/** Языки в порядке показа в переключателе */
export const LANGS: readonly Lang[] = ["ru", "uz"];
