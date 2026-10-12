// Поля витрины, которые разбирает и проверяет и панель (staff/listings.ts), и кабинет
// (vendor/listing.ts): название, описания, адрес, район, вместимость, поля витрины по
// конфигурации категории и ссылки на видео. Одни правила в одном месте — иначе панель и
// кабинет разошлись бы (партнёр смог бы то, что сотрудник не может, или наоборот).
// Ошибки — 422 invalid_input с именами полей (details), по ним формы подсвечивают поля.

import {
  type AttributeValue,
  type CategoryConfig,
  mergeAttributes,
  validateAttributePatch,
  validateVideoLinks,
} from "@bayramm/shared/categories";
import type { Tx } from "./db/actor";
import type { Json } from "./db/schema.generated";
import { type Input, invalidInput } from "./staff/input";

/** Границы вместимости: те же, что у столбцов cap_min и cap_max */
export const CAPACITY_LIMITS = { min: 1, max: 5000 } as const;

/** Столбцы витрины, которые партнёр и сотрудник пишут одинаково */
export interface CardFields {
  name?: string;
  district_code?: string | null;
  address_ru?: string | null;
  address_uz?: string | null;
  description_ru?: string | null;
  description_uz?: string | null;
  cap_min?: number | null;
  cap_max?: number | null;
}

/** Только заданные поля: undefined — «не менять» */
function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Название, описания, адрес, район и вместимость из тела (ключи — camelCase: capMin,
 * districtCode…). Нет в теле — не менять; null или пустая строка — убрать (название убрать
 * нельзя). Вместимость «до» не меньше «от» — по телу; с текущей карточкой сверяет вызывающий
 */
export function readCardFields(input: Input, creating: boolean): CardFields {
  const name = input.text("name", { min: 2, max: 80, required: creating });
  if (name === null) input.fail("name");
  const capMin = input.int("capMin", CAPACITY_LIMITS);
  const capMax = input.int("capMax", CAPACITY_LIMITS);
  if (typeof capMin === "number" && typeof capMax === "number" && capMax < capMin) input.fail("capMax");
  return defined<CardFields>({
    name: name ?? undefined,
    district_code: input.pattern("districtCode", /^[a-z_]{2,30}$/),
    address_ru: input.text("addressRu", { max: 300 }),
    address_uz: input.text("addressUz", { max: 300 }),
    description_ru: input.text("descriptionRu", { max: 4000, multiline: true }),
    description_uz: input.text("descriptionUz", { max: 4000, multiline: true }),
    cap_min: capMin,
    cap_max: capMax,
  });
}

/**
 * «До» не меньше «от» после слияния с карточкой: правка одного из двух тоже не должна их
 * разводить. field — как поле «до» зовётся в теле (cap_max в предложении, capMax в остальных)
 */
export function assertCapacityOrder(
  fields: Pick<CardFields, "cap_min" | "cap_max">,
  current: { cap_min: number | null; cap_max: number | null },
  field = "capMax",
): void {
  const min = fields.cap_min === undefined ? current.cap_min : fields.cap_min;
  const max = fields.cap_max === undefined ? current.cap_max : fields.cap_max;
  if (typeof min === "number" && typeof max === "number" && max < min) throw invalidInput([field]);
}

// Район — из справочника: внешний ключ дал бы непонятный 404. field — как поле зовётся в теле
// (в предложении из кабинета — district_code, в остальных телах — districtCode)
export async function assertDistrict(
  trx: Tx,
  code: string | null | undefined,
  field = "districtCode",
): Promise<void> {
  if (code === undefined || code === null) return;
  const found = await trx
    .selectFrom("app.districts")
    .select("code")
    .where("code", "=", code)
    .executeTakeFirst();
  if (!found) throw invalidInput([field]);
}

/** Поля витрины и ссылки на видео из тела — как пришли; проверяются по категории */
export interface RawCategoryFields {
  /** Правка полей витрины: { ключ: значение | null } */
  attributes: unknown;
  /** Ссылки на видео целиком; null — убрать все */
  videoLinks: unknown;
}

/** Проверенные поля витрины (только изменённые ключи) и ссылки на видео */
export interface CategoryPatch {
  attributes?: Readonly<Record<string, AttributeValue | null>>;
  videoLinks?: readonly string[];
}

/**
 * Поля витрины и ссылки на видео по конфигурации категории карточки. Неверные — 422
 * invalid_input (attributes.<поле>…, videoLinks.<номер>). Нет в теле (undefined) — не меняется
 */
export function validatedCategoryFields(
  category: CategoryConfig | undefined,
  raw: RawCategoryFields,
): CategoryPatch {
  const out: { attributes?: CategoryPatch["attributes"]; videoLinks?: readonly string[] } = {};
  const errors: string[] = [];
  if (raw.attributes !== undefined) {
    const result = category === undefined ? null : validateAttributePatch(category, raw.attributes);
    if (result === null || !result.ok) errors.push(...(result?.errors ?? ["attributes"]));
    else out.attributes = result.value;
  }
  if (raw.videoLinks !== undefined) {
    const result =
      raw.videoLinks === null
        ? ({ ok: true, value: [] as string[] } as const)
        : category === undefined
          ? null
          : validateVideoLinks(category, raw.videoLinks);
    if (result === null || !result.ok) errors.push(...(result?.errors ?? ["videoLinks"]));
    else out.videoLinks = result.value;
  }
  if (errors.length > 0) throw invalidInput(errors);
  return out;
}

/**
 * То же для записи в карточку: поля витрины сливаются с текущими (null — убрать), в ответе —
 * значения столбцов attributes (строкой JSON) и video_links
 */
export function categoryFields(
  category: CategoryConfig | undefined,
  raw: RawCategoryFields,
  current: Json,
): { attributes?: string; video_links?: string[] } {
  const patch = validatedCategoryFields(category, raw);
  const out: { attributes?: string; video_links?: string[] } = {};
  if (patch.attributes !== undefined) {
    const base =
      typeof current === "object" && current !== null && !Array.isArray(current)
        ? (current as Record<string, AttributeValue>)
        : {};
    out.attributes = JSON.stringify(mergeAttributes(base, patch.attributes));
  }
  if (patch.videoLinks !== undefined) out.video_links = [...patch.videoLinks];
  return out;
}
