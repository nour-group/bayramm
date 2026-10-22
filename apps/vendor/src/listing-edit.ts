/* Изменения витрины по группам — чистая часть: что в какой группе, значения форм, «только
   изменённое» для PATCH /vendor/listings/:id и проверки до запроса (те же правила, что на
   сервере: вместимость 1–5000 и «до» не меньше «от», остальное — @bayramm/shared/categories).
   Окна и карточки групп — ListingEdit.tsx и VenueGroups.tsx. */

import type { Lang } from "@bayramm/shared";
import type { Dictionaries } from "@bayramm/shared/api";
import type { ListingRevisionPayload, VendorListing, VendorListingPatch } from "@bayramm/shared/api/vendor";
import {
  type AttributeDrafts,
  type AttributeValue,
  attributeDrafts,
  attributeErrors,
  attributePatch,
  type CategoryConfig,
  videoLinkErrors,
  videoLinksValue,
} from "@bayramm/shared/categories";
import type { SelectOption } from "@bayramm/ui/react";
import type { TextKey } from "./i18n";

/** Группа сведений: у каждой своя карточка и своё окно «Изменить» */
export const EDIT_GROUPS = ["basics", "place", "attributes", "videos"] as const;
export type EditGroup = (typeof EDIT_GROUPS)[number];

/** Границы вместимости — как у столбцов базы и сервера */
export const CAPACITY_RANGE = { min: 1, max: 5000 } as const;

/** Что партнёр отправляет: версия добавляется при отправке */
export type ListingChanges = Omit<VendorListingPatch, "version">;

/** Группа, в которой ключ предложения (столбец базы) показывается и меняется */
const GROUP_OF_KEY: Readonly<Record<keyof ListingRevisionPayload, EditGroup>> = {
  name: "basics",
  description_ru: "basics",
  description_uz: "basics",
  attributes: "attributes",
  video_links: "videos",
  cap_min: "place",
  cap_max: "place",
  district_code: "place",
  address_ru: "place",
  address_uz: "place",
};

/** Какие группы затрагивает предложение — у их карточек метка «на проверке» */
export function touchedGroups(payload: ListingRevisionPayload | undefined): ReadonlySet<EditGroup> {
  const groups = new Set<EditGroup>();
  if (!payload) return groups;
  for (const key of Object.keys(payload)) {
    const group = GROUP_OF_KEY[key as keyof ListingRevisionPayload];
    if (group !== undefined) groups.add(group);
  }
  return groups;
}

/** Витрина не на сайте: изменения сохраняются сразу. На проверке и позже — только предложением */
export const savesDirectly = (status: VendorListing["status"]) =>
  status !== "review" && status !== "active" && status !== "suspended";

/** Есть ли у категории вместимость в гостях / район (listingFields) */
export const hasCapacity = (category: CategoryConfig | undefined) =>
  category?.listingFields.includes("guest_capacity") ?? false;
export const hasDistrict = (category: CategoryConfig | undefined) =>
  category?.listingFields.includes("district") ?? false;

// ── значения форм ──────────────────────────────────────────────────────────

export interface BasicsValues {
  readonly name: string;
  readonly descriptionRu: string;
  readonly descriptionUz: string;
}

export interface PlaceValues {
  /** Код района; пусто — не выбран */
  readonly districtCode: string;
  readonly addressRu: string;
  readonly addressUz: string;
  /** Строки — как в поле: человек может стереть и набрать заново */
  readonly capMin: string;
  readonly capMax: string;
}

export const basicsOf = (listing: VendorListing): BasicsValues => ({
  name: listing.name,
  descriptionRu: listing.description.ru,
  descriptionUz: listing.description.uz,
});

export const placeOf = (listing: VendorListing): PlaceValues => ({
  districtCode: listing.districtCode ?? "",
  addressRu: listing.address.ru,
  addressUz: listing.address.uz,
  capMin: listing.capMin === null ? "" : String(listing.capMin),
  capMax: listing.capMax === null ? "" : String(listing.capMax),
});

/** Ссылки на видео в форме: сохранённые, а если их нет — одно пустое поле */
export const videoDraftsOf = (listing: VendorListing): string[] =>
  listing.videoLinks.length > 0 ? [...listing.videoLinks] : [""];

export const attributeDraftsOf = (listing: VendorListing, category: CategoryConfig): AttributeDrafts =>
  attributeDrafts(category, listing.attributes);

// ── только изменённое ──────────────────────────────────────────────────────

export function basicsChanges(listing: VendorListing, values: BasicsValues): ListingChanges {
  const changes: { -readonly [K in keyof ListingChanges]: ListingChanges[K] } = {};
  const name = values.name.trim();
  if (name !== listing.name) changes.name = name;
  const ru = values.descriptionRu.trim();
  if (ru !== listing.description.ru.trim()) changes.descriptionRu = ru;
  const uz = values.descriptionUz.trim();
  if (uz !== listing.description.uz.trim()) changes.descriptionUz = uz;
  return changes;
}

/** Целое число из поля; пусто или не число — null */
const whole = (text: string): number | null => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : null);

export function placeChanges(
  listing: VendorListing,
  category: CategoryConfig | undefined,
  values: PlaceValues,
): ListingChanges {
  const changes: { -readonly [K in keyof ListingChanges]: ListingChanges[K] } = {};
  if (hasDistrict(category) && values.districtCode !== "" && values.districtCode !== listing.districtCode) {
    changes.districtCode = values.districtCode;
  }
  const ru = values.addressRu.trim();
  if (ru !== listing.address.ru.trim()) changes.addressRu = ru;
  const uz = values.addressUz.trim();
  if (uz !== listing.address.uz.trim()) changes.addressUz = uz;
  if (hasCapacity(category)) {
    // Стёртое поле не отправляется (убрать вместимость нельзя): его показывает capacityErrors
    const min = whole(values.capMin);
    if (min !== null && min !== listing.capMin) changes.capMin = min;
    const max = whole(values.capMax);
    if (max !== null && max !== listing.capMax) changes.capMax = max;
  }
  return changes;
}

export function attributesChanges(
  category: CategoryConfig,
  drafts: AttributeDrafts,
  before: AttributeDrafts,
): ListingChanges {
  const patch = attributePatch(category, drafts, before);
  return Object.keys(patch).length > 0
    ? { attributes: patch as Readonly<Record<string, AttributeValue | null>> }
    : {};
}

export function videosChanges(
  listing: VendorListing,
  category: CategoryConfig,
  videos: readonly string[],
): ListingChanges {
  if (category.maxVideoLinks === 0) return {};
  const links = videoLinksValue(videos);
  return JSON.stringify(links) === JSON.stringify(listing.videoLinks) ? {} : { videoLinks: links };
}

// ── проверки до запроса ────────────────────────────────────────────────────

/** Неверные поля формы → текст ошибки: ключи — как в ответе API (capMax, attributes.fleet.0.class…) */
export type FieldErrors = Readonly<Record<string, TextKey>>;

export function basicsErrors(values: BasicsValues, moderated: boolean): FieldErrors {
  const errors: Record<string, TextKey> = {};
  const name = values.name.trim();
  if (name.length < 2 || name.length > 80) errors.name = "errNameLength";
  // На проверке и на сайте без описания витрина не готова — стереть его нельзя
  if (moderated) {
    if (values.descriptionRu.trim() === "") errors.descriptionRu = "errDescriptionRequired";
    if (values.descriptionUz.trim() === "") errors.descriptionUz = "errDescriptionRequired";
  }
  return errors;
}

/**
 * Вместимость: каждое число 1–5000, «до» не меньше «от». Стереть поле, где число уже было,
 * нельзя — вместимость остаётся (в предложении её не убрать, на сайте — не опубликовать без неё)
 */
export function capacityErrors(listing: VendorListing, values: PlaceValues): FieldErrors {
  const errors: Record<string, TextKey> = {};
  const range = (n: number | null) => n !== null && n >= CAPACITY_RANGE.min && n <= CAPACITY_RANGE.max;
  const min = whole(values.capMin);
  const max = whole(values.capMax);
  if (values.capMin.trim() !== "" ? !range(min) : listing.capMin !== null) errors.capMin = "capErrRange";
  if (values.capMax.trim() !== "" ? !range(max) : listing.capMax !== null) errors.capMax = "capErrRange";
  if (!errors.capMin && !errors.capMax && min !== null && max !== null && max < min) {
    errors.capMax = "capErrOrder";
  }
  return errors;
}

export function placeErrors(
  listing: VendorListing,
  category: CategoryConfig | undefined,
  values: PlaceValues,
): FieldErrors {
  const errors: Record<string, TextKey> = hasCapacity(category) ? { ...capacityErrors(listing, values) } : {};
  if (values.addressRu.trim().length > 300) errors.addressRu = "errAddressLong";
  if (values.addressUz.trim().length > 300) errors.addressUz = "errAddressLong";
  return errors;
}

export function attributesErrors(category: CategoryConfig, drafts: AttributeDrafts): ReadonlySet<string> {
  return new Set(attributeErrors(category, drafts));
}

export function videosErrors(category: CategoryConfig, videos: readonly string[]): ReadonlySet<number> {
  return category.maxVideoLinks > 0 ? new Set(videoLinkErrors(category, videos)) : new Set();
}

/**
 * Ошибки ответа сервера (422 invalid_input, details) → ключи формы. Номера ссылок на видео
 * приходят как videoLinks.N (и video_links.N у старых ответов); весь список — без номера
 */
export function videoErrorIndexes(details: readonly string[], count: number): number[] {
  if (details.some((d) => d === "videoLinks" || d === "video_links"))
    return Array.from({ length: count }, (_, i) => i);
  return details.flatMap((path) => {
    const match = /^(?:videoLinks|video_links)\.(\d+)$/.exec(path);
    return match ? [Number(match[1])] : [];
  });
}

/**
 * Районы списком по городам, как в панели и на сайте: город — заголовок группы (выбрать нельзя —
 * витрина в районе), районы — вложенными под ним. Район без города в справочнике — в конце
 */
export function districtOptions(
  dictionaries: Pick<Dictionaries, "cities" | "districts"> | null,
  lang: Lang,
): SelectOption[] {
  const cities = dictionaries?.cities ?? [];
  const districts = dictionaries?.districts ?? [];
  const known = new Set(cities.map((city) => city.code));
  return [
    ...cities.flatMap((city) => {
      const inside = districts.filter((district) => district.city === city.code);
      return inside.length === 0
        ? []
        : [
            { value: `city:${city.code}`, label: city.name[lang], disabled: true },
            ...inside.map((district) => ({ value: district.code, label: district.name[lang], nested: true })),
          ];
    }),
    ...districts
      .filter((district) => !known.has(district.city))
      .map((district) => ({ value: district.code, label: district.name[lang] })),
  ];
}
