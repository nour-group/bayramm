// PATCH /vendor/listings/:id — партнёр сам настраивает витрину: название, описания, поля
// витрины, ссылки на видео, вместимость, район и адрес. Одно правило:
//
//   · витрины нет на сайте (lead, draft, rejected) — изменённое сохраняется сразу;
//   · на проверке, в каталоге, приостановлена (review, active, suspended) — изменённые поля
//     уходят предложением (app.listing_revisions, как POST …/revisions): клиент видит
//     одобренное, пока команда не решит. Одно открытое предложение на витрину (409
//     revision_pending).
//
// Так решает и база (listings_before_update: BR005 у партнёра на проверке и позже, BR006 на
// адрес страницы), здесь выбирается путь. Цена — в услугах, адрес страницы и категорию меняет
// сотрудник. Только владелец кабинета (vendor/access.ts). Версия — как у панели: карточку с
// тех пор меняли — 409 version_conflict. Правка партнёра, сохранённая сразу, попадает в
// журнал (listing.vendor_update — только имена полей, триггер audit_vendor_listing).
//
// Разбор полей — общий с панелью (listing-fields.ts); поля, которых нет у категории
// (вместимость без guest_capacity, район без district), и лишние ключи — 422 invalid_input.

import type { MediaEnv } from "@bayramm/media";
import type { RevisionField } from "@bayramm/shared/api/staff";
import type { VendorListingSaved } from "@bayramm/shared/api/vendor";
import { type AttributeValue, categoryConfig, mergeAttributes } from "@bayramm/shared/categories";
import { type Tx, type VendorActor, withActor } from "../db/actor";
import type { Db } from "../db/client";
import type { Json } from "../db/schema.generated";
import { ApiError, notFound, versionConflict } from "../errors";
import {
  assertCapacityOrder,
  assertDistrict,
  type CardFields,
  type CategoryPatch,
  readCardFields,
  validatedCategoryFields,
} from "../listing-fields";
import { type Body, Input, invalidInput } from "../staff/input";
import { changedOnly, type ProposedValues, revisionFields } from "../staff/revision-diff";
import { assertVendorCan } from "./access";
import { readListing } from "./profile";
import { insertRevision, noChanges } from "./revisions";

/** Статусы, где партнёр меняет карточку только предложением (как в listings_before_update) */
const MODERATED_STATUSES: ReadonlySet<string> = new Set(["review", "active", "suspended"]);

const KEYS: readonly string[] = [
  "version",
  "name",
  "descriptionRu",
  "descriptionUz",
  "districtCode",
  "addressRu",
  "addressUz",
  "capMin",
  "capMax",
  "attributes",
  "videoLinks",
];

export interface ParsedPatch {
  readonly version: number;
  readonly fields: CardFields;
  /** Поля витрины и ссылки как пришли — проверяются по категории витрины */
  readonly attributes: unknown;
  readonly videoLinks: unknown;
}

/**
 * Тело PATCH → значения; без базы. Лишний ключ — ошибка поля; район и вместимость партнёр
 * только заменяет (убрать нельзя), название — тоже
 */
export function parsePatch(body: Body): ParsedPatch {
  const input = new Input(body);
  for (const key of Object.keys(body)) if (!KEYS.includes(key)) input.fail(key);
  const version = input.int("version", { min: 1, max: 2_147_483_647, required: true });
  const fields = readCardFields(input, false);
  if (fields.district_code === null) input.fail("districtCode");
  if (fields.cap_min === null) input.fail("capMin");
  if (fields.cap_max === null) input.fail("capMax");
  input.done();
  if (typeof version !== "number") throw invalidInput(["version"]);
  return { version, fields, attributes: input.peek("attributes"), videoLinks: input.peek("videoLinks") };
}

/** Вместимость и район — только там, где они есть у категории (listingFields) */
function assertCategoryHas(fields: CardFields, listingFields: readonly string[]): void {
  const wrong: string[] = [];
  if (!listingFields.includes("guest_capacity")) {
    if (fields.cap_min !== undefined) wrong.push("capMin");
    if (fields.cap_max !== undefined) wrong.push("capMax");
  }
  if (!listingFields.includes("district") && fields.district_code !== undefined) wrong.push("districtCode");
  if (wrong.length > 0) throw invalidInput(wrong);
}

/** Текст как в предложении: убрать = пустая строка */
const orEmpty = (value: string | null | undefined) => (value === null ? "" : value);

/**
 * Значения для сравнения с карточкой и для предложения. На витрине с проверкой очистить
 * описание нельзя — без него она не готова
 */
function proposed(parsed: ParsedPatch, patch: CategoryPatch, moderated: boolean): ProposedValues {
  const { fields } = parsed;
  if (moderated) {
    const cleared = [
      ...(fields.description_ru === null ? ["descriptionRu"] : []),
      ...(fields.description_uz === null ? ["descriptionUz"] : []),
    ];
    if (cleared.length > 0) throw invalidInput(cleared);
  }
  return {
    fields: {
      ...(fields.name === undefined ? {} : { name: fields.name }),
      ...(fields.description_ru === undefined ? {} : { description_ru: orEmpty(fields.description_ru) }),
      ...(fields.description_uz === undefined ? {} : { description_uz: orEmpty(fields.description_uz) }),
      ...(fields.address_ru === undefined ? {} : { address_ru: orEmpty(fields.address_ru) }),
      ...(fields.address_uz === undefined ? {} : { address_uz: orEmpty(fields.address_uz) }),
      ...(fields.district_code ? { district_code: fields.district_code } : {}),
      ...(typeof fields.cap_min === "number" ? { cap_min: fields.cap_min } : {}),
      ...(typeof fields.cap_max === "number" ? { cap_max: fields.cap_max } : {}),
    },
    ...(patch.attributes === undefined ? {} : { attributes: patch.attributes }),
    ...(patch.videoLinks === undefined ? {} : { videoLinks: patch.videoLinks }),
  };
}

/** Изменённое — в столбцы карточки; пустой текст — NULL, поля витрины сливаются с текущими */
function columnsOf(payload: ReturnType<typeof changedOnly>, currentAttributes: Json) {
  const base =
    typeof currentAttributes === "object" && currentAttributes !== null && !Array.isArray(currentAttributes)
      ? (currentAttributes as Record<string, AttributeValue>)
      : {};
  const text = (value: string | undefined) => (value === "" ? null : value);
  return {
    ...(payload.name === undefined ? {} : { name: payload.name }),
    ...(payload.description_ru === undefined ? {} : { description_ru: text(payload.description_ru) }),
    ...(payload.description_uz === undefined ? {} : { description_uz: text(payload.description_uz) }),
    ...(payload.address_ru === undefined ? {} : { address_ru: text(payload.address_ru) }),
    ...(payload.address_uz === undefined ? {} : { address_uz: text(payload.address_uz) }),
    ...(payload.district_code === undefined ? {} : { district_code: payload.district_code }),
    ...(payload.cap_min === undefined ? {} : { cap_min: payload.cap_min }),
    ...(payload.cap_max === undefined ? {} : { cap_max: payload.cap_max }),
    ...(payload.attributes === undefined
      ? {}
      : { attributes: JSON.stringify(mergeAttributes(base, payload.attributes)) }),
    ...(payload.video_links === undefined ? {} : { video_links: [...payload.video_links] }),
  };
}

const lockListing = (trx: Tx, actor: VendorActor, listingId: string) =>
  trx
    .selectFrom("app.listings")
    .select([
      "id",
      "version",
      "status",
      "category_code",
      "name",
      "description_ru",
      "description_uz",
      "attributes",
      "video_links",
      "cap_min",
      "cap_max",
      "district_code",
      "address_ru",
      "address_uz",
    ])
    .where("id", "=", listingId)
    .where("vendor_id", "=", actor.vendorId)
    .forUpdate()
    .executeTakeFirst();

/** PATCH /vendor/listings/:id */
export function patchListing(
  db: Db,
  actor: VendorActor,
  listingId: string,
  body: unknown,
  media: MediaEnv,
): Promise<VendorListingSaved> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError(400, "invalid_request", "Body must be a JSON object");
  }
  // Роль — до разбора и базы
  assertVendorCan(actor, "card.propose");
  const parsed = parsePatch(body as Body);
  return withActor(db, actor, async (trx) => {
    const current = await lockListing(trx, actor, listingId);
    if (current === undefined) throw notFound();
    if (current.version !== parsed.version) throw versionConflict();

    const category = categoryConfig(current.category_code);
    assertCategoryHas(parsed.fields, category?.listingFields ?? []);
    assertCapacityOrder(parsed.fields, current);
    await assertDistrict(trx, parsed.fields.district_code);
    const moderated = MODERATED_STATUSES.has(current.status);
    const values = proposed(parsed, validatedCategoryFields(category, parsed), moderated);

    let sent: RevisionField[] = [];
    if (moderated) {
      // Предложение: только изменённое, ничего — 422 no_changes; открытое уже есть — 409
      const revision = await insertRevision(trx, current, values);
      sent = revisionFields(Object.keys(revision.payload));
    } else {
      const payload = changedOnly(values, current);
      if (Object.keys(payload).length === 0) throw noChanges();
      await trx
        .updateTable("app.listings")
        .set(columnsOf(payload, current.attributes))
        .where("id", "=", listingId)
        .where("version", "=", current.version)
        .execute();
    }
    return { listing: await readListing(trx, actor, listingId, media), sentForModeration: sent };
  });
}
