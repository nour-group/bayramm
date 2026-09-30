// Правка карточки против текущей карточки: в правку попадают только изменённые поля.
// Общее для предложения партнёра (vendor/revisions.ts) и правки опубликованной карточки
// менеджером (staff/listings.ts) — оба уходят на модерацию одинаковым payload.

import type { RevisionField } from "@bayramm/shared/api/staff";
import type { ListingRevisionPayload, RevisionPackage } from "@bayramm/shared/api/vendor";
import type { Tx } from "../db/actor";
import type { AppPriceUnit } from "../db/schema.generated";

/** Значения правки: столбцы карточки и набор пакетов (как в staff/revisions.ts) */
export interface ProposedValues {
  readonly fields: {
    readonly name?: string;
    readonly price_from_uzs?: number;
    readonly price_unit?: "per_guest" | "per_event";
    readonly description_ru?: string;
    readonly description_uz?: string;
  };
  readonly packages:
    | readonly {
        readonly kind: "weekday" | "weekend" | "custom";
        readonly nameRu: string;
        readonly nameUz: string;
        readonly priceUzs: number;
        readonly priceUnit: "per_guest" | "per_event";
      }[]
    | undefined;
}

/** Модерируемые столбцы карточки — как их видит правка */
export interface ModeratedColumns {
  readonly name: string;
  readonly price_from_uzs: string | number | null;
  readonly price_unit: AppPriceUnit;
  readonly description_ru: string | null;
  readonly description_uz: string | null;
}

/** Ключ payload (столбец базы) → поле контракта панели, в порядке показа */
export const REVISION_FIELDS = [
  ["name", "name"],
  ["price_from_uzs", "priceFromUzs"],
  ["price_unit", "priceUnit"],
  ["description_ru", "descriptionRu"],
  ["description_uz", "descriptionUz"],
  ["packages", "packages"],
] as const satisfies readonly (readonly [keyof ListingRevisionPayload, RevisionField])[];

/** Какие поля меняет правка — ключи payload в поля контракта, в порядке показа */
export function revisionFields(keys: readonly string[]): RevisionField[] {
  return REVISION_FIELDS.filter(([key]) => keys.includes(key)).map(([, field]) => field);
}

/** Пакеты карточки в форме правки, по порядку */
export async function currentPackages(trx: Tx, listingId: string): Promise<RevisionPackage[]> {
  const rows = await trx
    .selectFrom("app.listing_packages")
    .select(["kind", "name_ru", "name_uz", "price_uzs", "price_unit"])
    .where("listing_id", "=", listingId)
    .orderBy("sort")
    .orderBy("created_at")
    .execute();
  return rows.map((p) => ({
    kind: p.kind,
    name_ru: p.name_ru,
    name_uz: p.name_uz,
    price_uzs: Number(p.price_uzs),
    price_unit: p.price_unit,
  }));
}

/** Правка без полей, которые совпадают с карточкой. Пакеты сравниваются набором по порядку */
export function changedOnly(
  values: ProposedValues,
  listing: ModeratedColumns,
  packages: readonly RevisionPackage[],
): ListingRevisionPayload {
  const { fields } = values;
  const payload: { -readonly [K in keyof ListingRevisionPayload]: ListingRevisionPayload[K] } = {};
  if (fields.name !== undefined && fields.name !== listing.name) payload.name = fields.name;
  const price = listing.price_from_uzs === null ? null : Number(listing.price_from_uzs);
  if (fields.price_from_uzs !== undefined && fields.price_from_uzs !== price)
    payload.price_from_uzs = fields.price_from_uzs;
  if (fields.price_unit !== undefined && fields.price_unit !== listing.price_unit)
    payload.price_unit = fields.price_unit;
  if (fields.description_ru !== undefined && fields.description_ru !== (listing.description_ru ?? ""))
    payload.description_ru = fields.description_ru;
  if (fields.description_uz !== undefined && fields.description_uz !== (listing.description_uz ?? ""))
    payload.description_uz = fields.description_uz;
  if (values.packages !== undefined) {
    const proposed = values.packages.map(
      (p): RevisionPackage => ({
        kind: p.kind,
        name_ru: p.nameRu,
        name_uz: p.nameUz,
        price_uzs: p.priceUzs,
        price_unit: p.priceUnit,
      }),
    );
    if (JSON.stringify(proposed) !== JSON.stringify(packages)) payload.packages = proposed;
  }
  return payload;
}
