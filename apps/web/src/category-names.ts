import type { Dict, Lang } from "@bayramm/shared";
import { categoryConfig, categoryText } from "@bayramm/shared/categories";

/* Название раздела каталога глазами клиента — отдельным модулем без React и значков: его
   же берёт воркер (заголовки страниц каталога, worker/meta.ts) */

/**
 * Название раздела каталога для клиента — короткое, из глоссария (t.catName: «Тойханы»,
 * «Кортежи»): одно и то же в переключателе, плитках, заголовке каталога, карточках и заявках.
 * Категории без своего названия в глоссарии — название из её описания; неизвестный код — null
 */
/** Что есть в разделе — одной строкой (t.catDesc): плитка лендинга, шапка каталога, описание для поисковиков */
export function categoryDesc(code: string | null | undefined, t: Dict): string | null {
  if (!code) return null;
  return (t.catDesc as Readonly<Record<string, string | undefined>>)[code] ?? null;
}

export function categoryName(code: string | null | undefined, t: Dict, lang: Lang): string | null {
  if (!code) return null;
  const own = (t.catName as Readonly<Record<string, string | undefined>>)[code];
  if (own) return own;
  const config = categoryConfig(code);
  return config ? categoryText(lang, config.label) : null;
}
