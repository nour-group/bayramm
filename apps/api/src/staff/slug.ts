// Адрес карточки (slug) из названия: латиница, цифры и дефис, 3–40 символов —
// как CHECK в app.listings. Перевод в латиницу — slugFromName из @bayramm/shared: тот же
// делает «из названия» в форме витрины панели.

import { MAX_SLUG, SLUG_RE, slugFromName } from "@bayramm/shared";
import type { Tx } from "../db/actor";

export { SLUG_RE };

/** Основа адреса из названия; пусто или слишком коротко — «hall» */
export function slugify(name: string): string {
  const slug = slugFromName(name);
  return SLUG_RE.test(slug) ? slug : "hall";
}

/** Свободный адрес: основа, а если занята — основа-2, основа-3, … */
export function freeSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, MAX_SLUG - suffix.length).replace(/-+$/g, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base.slice(0, MAX_SLUG - 9)}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Свободный адрес карточки по названию — под актором транзакции (сотрудник видит все) */
export async function pickSlug(trx: Tx, name: string): Promise<string> {
  const base = slugify(name);
  const taken = await trx
    .selectFrom("app.listings")
    .select("slug")
    .where("slug", "like", `${base}%`)
    .execute();
  return freeSlug(base, new Set(taken.map((row) => row.slug)));
}
