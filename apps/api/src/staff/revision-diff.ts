// Правка карточки против текущей карточки: в правку попадают только изменённые поля.
// Общее для предложения партнёра (vendor/revisions.ts) и правки опубликованной карточки
// менеджером (staff/listings.ts) — оба уходят на модерацию одинаковым payload. Цен в
// правке нет: они в услугах (listing-services/store.ts).

import type { RevisionField } from "@bayramm/shared/api/staff";
import type { ListingRevisionPayload } from "@bayramm/shared/api/vendor";
import type { AttributeValue } from "@bayramm/shared/categories";
import type { Json } from "../db/schema.generated";

/** Значения правки: столбцы карточки, поля витрины и ссылки (как в staff/revisions.ts) */
export interface ProposedValues {
  readonly fields: {
    readonly name?: string;
    readonly description_ru?: string;
    readonly description_uz?: string;
  };
  /** Поля витрины: { ключ: значение | null } — проверены по категории */
  readonly attributes?: Readonly<Record<string, AttributeValue | null>>;
  /** Ссылки на видео целиком — проверены по категории */
  readonly videoLinks?: readonly string[];
}

/** Модерируемые столбцы карточки — как их видит правка */
export interface ModeratedColumns {
  readonly name: string;
  readonly description_ru: string | null;
  readonly description_uz: string | null;
  readonly attributes?: Json;
  readonly video_links?: readonly string[];
}

/** Ключ payload (столбец базы) → поле контракта панели, в порядке показа */
export const REVISION_FIELDS = [
  ["name", "name"],
  ["description_ru", "descriptionRu"],
  ["description_uz", "descriptionUz"],
  ["attributes", "attributes"],
  ["video_links", "videoLinks"],
] as const satisfies readonly (readonly [keyof ListingRevisionPayload, RevisionField])[];

/** Какие поля меняет правка — ключи payload в поля контракта, в порядке показа */
export function revisionFields(keys: readonly string[]): RevisionField[] {
  return REVISION_FIELDS.filter(([key]) => keys.includes(key)).map(([, field]) => field);
}

/** Правка без полей, которые совпадают с карточкой */
export function changedOnly(values: ProposedValues, listing: ModeratedColumns): ListingRevisionPayload {
  const { fields } = values;
  const payload: { -readonly [K in keyof ListingRevisionPayload]: ListingRevisionPayload[K] } = {};
  if (fields.name !== undefined && fields.name !== listing.name) payload.name = fields.name;
  if (fields.description_ru !== undefined && fields.description_ru !== (listing.description_ru ?? ""))
    payload.description_ru = fields.description_ru;
  if (fields.description_uz !== undefined && fields.description_uz !== (listing.description_uz ?? ""))
    payload.description_uz = fields.description_uz;
  if (values.attributes !== undefined) {
    const current =
      typeof listing.attributes === "object" &&
      listing.attributes !== null &&
      !Array.isArray(listing.attributes)
        ? listing.attributes
        : {};
    const changed = Object.entries(values.attributes).filter(
      ([key, value]) => JSON.stringify(value) !== JSON.stringify(current[key] ?? null),
    );
    if (changed.length > 0) payload.attributes = Object.fromEntries(changed);
  }
  if (
    values.videoLinks !== undefined &&
    JSON.stringify(values.videoLinks) !== JSON.stringify(listing.video_links ?? [])
  ) {
    payload.video_links = values.videoLinks;
  }
  return payload;
}
