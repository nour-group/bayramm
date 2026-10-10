// Профиль кабинета и карточка площадки — только чтение (кроме языка).
//
// Карточку партнёр меняет предложением правки (vendor/revisions.ts), услугами
// (vendor/services.ts) и загрузкой фото (vendor/photos.ts): это модерируемые данные,
// решает команда. Адрес, вместимость и телефон меняет менеджер. Кабинет показывает
// карточку как есть в базе. У вендора бывают витрины в нескольких категориях: getMe
// отдаёт их все с категорией — для переключателя витрин.

import { type MediaEnv, mediaSrcSet, mediaUrl } from "@bayramm/media";
import type {
  Locale,
  VendorAttention,
  VendorListing,
  VendorMe,
  VendorPhoto,
} from "@bayramm/shared/api/vendor";
import { categoryConfig, missingAttributes, readAttributes } from "@bayramm/shared/categories";
import { sql } from "kysely";
import { type Tx, type VendorActor, withActor } from "../db/actor";
import type { Db } from "../db/client";
import { listingPhone, vendorContactsAs, vendorUserProfilesAs } from "../db/pii";
import { ApiError, notFound } from "../errors";
import { listServices } from "../listing-services/store";

const LOCALES: readonly Locale[] = ["ru", "uz"];

export function parseLocale(body: unknown): Locale {
  const locale =
    typeof body === "object" && body !== null ? (body as { locale?: unknown }).locale : undefined;
  if (!(LOCALES as readonly unknown[]).includes(locale)) {
    throw new ApiError(422, "invalid_input", "Invalid input", ["locale"]);
  }
  return locale as Locale;
}

const NO_ATTENTION: VendorAttention = { services: 0, photos: 0, proposals: 0 };

/**
 * Что на витринах вендора ждёт действия партнёра (VendorListingRef.attention): считается
 * при каждом чтении, своих столбцов в базе нет.
 *   · услуги — отклонённые (status rejected); отклонённое предложение правки активной услуги
 *     не считается: услуга на витрине как была, а числу «чинить» без выхода из него не место;
 *   · фото — отклонённые, которые ещё в кабинете (как в getListing: готовые, с размерами,
 *     не удалённые);
 *   · предложения — последнее по времени (как в listRevisions) отклонено, и подал его партнёр,
 *     а не команда (byTeam в vendor/revisions.ts): нового открытого за ним нет, иначе оно
 *     было бы последним.
 * Исправляет всё это только владелец кабинета, поэтому сотруднику площадки (member) считать
 * не нужно — у него нули.
 */
async function attentionOf(trx: Tx, vendorId: string): Promise<ReadonlyMap<string, VendorAttention>> {
  const rows = await trx
    .selectFrom("app.listings as l")
    .select([
      "l.id",
      sql<number>`(select count(*)::int from app.listing_services s
        where s.listing_id = l.id and s.status = 'rejected')`.as("services"),
      sql<number>`(select count(*)::int from app.photos p
        where p.listing_id = l.id and p.moderation = 'declined' and p.deleted_at is null
          and p.status = 'ready' and p.width is not null and p.height is not null)`.as("photos"),
      sql<number>`(select count(*)::int from (
          select r.status, r.submitted_by from app.listing_revisions r
          where r.listing_id = l.id order by r.submitted_at desc, r.id limit 1) last
        where last.status = 'declined'
          and exists (select 1 from app.vendor_users u where u.id = last.submitted_by))`.as("proposals"),
    ])
    .where("l.vendor_id", "=", vendorId)
    .execute();
  return new Map(
    rows.map((row) => [
      row.id,
      { services: Number(row.services), photos: Number(row.photos), proposals: Number(row.proposals) },
    ]),
  );
}

async function readMe(trx: Tx, actor: VendorActor): Promise<VendorMe> {
  const user = await trx
    .selectFrom("app.vendor_users as vu")
    .innerJoin("app.vendor_accounts as va", "va.id", "vu.vendor_id")
    .leftJoin(vendorUserProfilesAs("p"), "p.vendor_user_id", "vu.id")
    .leftJoin(vendorContactsAs("vc"), "vc.vendor_id", "va.id")
    .select([
      "vu.id",
      "vu.locale",
      "vu.role",
      "p.full_name",
      "va.id as vendor_id",
      "va.public_code",
      "vc.legal_name",
    ])
    .where("vu.id", "=", actor.id)
    .executeTakeFirst();
  if (user === undefined) throw notFound();

  const listings = await trx
    .selectFrom("app.listings")
    .select(["id", "name", "status", "category_code"])
    .where("vendor_id", "=", actor.vendorId)
    .orderBy("created_at")
    .orderBy("id")
    .execute();

  const owner = user.role === "owner";
  const attention = owner ? await attentionOf(trx, actor.vendorId) : new Map<string, VendorAttention>();

  return {
    user: {
      id: user.id,
      locale: user.locale,
      fullName: user.full_name,
      role: owner ? "owner" : "member",
    },
    vendor: { id: user.vendor_id, code: user.public_code, name: user.legal_name },
    listings: listings.map((l) => ({
      id: l.id,
      name: l.name,
      status: l.status,
      categoryCode: l.category_code,
      attention: attention.get(l.id) ?? NO_ATTENTION,
    })),
  };
}

/** GET /vendor/me */
export function getMe(db: Db, actor: VendorActor): Promise<VendorMe> {
  return withActor(db, actor, (trx) => readMe(trx, actor));
}

/** PATCH /vendor/me { locale }: язык кабинета и сообщений бота вендору */
export function setLocale(db: Db, actor: VendorActor, locale: Locale): Promise<VendorMe> {
  return withActor(db, actor, async (trx) => {
    await trx.updateTable("app.vendor_users").set({ locale }).where("id", "=", actor.id).execute();
    return readMe(trx, actor);
  });
}

/** Ширина основного варианта фото в карточке */
const PHOTO_WIDTH = 640;

interface PhotoRow {
  readonly id: string;
  readonly storage_key: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly moderation: "pending" | "approved" | "declined" | "withdrawn";
  /** Причина отказа модератора (только у declined) */
  readonly moderation_reason: string | null;
  readonly is_cover: boolean;
}

/** Фото глазами партнёра; без размеров (файл не проверен) — не показывается */
export function vendorPhoto(p: PhotoRow, media: MediaEnv): VendorPhoto | null {
  if (p.width === null || p.height === null || p.moderation === "withdrawn") return null;
  return {
    id: p.id,
    width: p.width,
    height: p.height,
    moderation: p.moderation,
    declineReason: p.moderation === "declined" ? p.moderation_reason : null,
    isCover: p.is_cover,
    src: mediaUrl(p.storage_key, PHOTO_WIDTH, media),
    srcSet: mediaSrcSet(p.storage_key, media, [320, 640, 960]),
  };
}

/** GET /vendor/listings/:id: своя площадка как есть в базе; чужая (даже опубликованная) — 404 */
export function getListing(
  db: Db,
  actor: VendorActor,
  listingId: string,
  media: MediaEnv,
): Promise<VendorListing> {
  return withActor(db, actor, (trx) => readListing(trx, actor, listingId, media));
}

/** Своя площадка в транзакции актора: после действия (отправка на проверку) — как GET */
export async function readListing(
  trx: Tx,
  actor: VendorActor,
  listingId: string,
  media: MediaEnv,
): Promise<VendorListing> {
  const listing = await trx
    .selectFrom("app.listings")
    .selectAll()
    .select([
      sql<string[] | null>`app.listing_publish_blockers(id, 'active')`.as("blockers"),
      // Чего не хватает, чтобы отправить на проверку: услуги и фото на проверке засчитываются
      sql<string[] | null>`app.listing_publish_blockers(id, 'review')`.as("review_blockers"),
      listingPhone("id").as("phone"),
      sql<number>`greatest(3, coalesce(app.setting_int('min_photos'), 3),
        (select c.min_photos from app.categories c where c.code = category_code))`.as("min_photos"),
      sql<number>`coalesce(app.setting_int('max_photos'), 10)`.as("max_photos"),
    ])
    .where("id", "=", listingId)
    .where("vendor_id", "=", actor.vendorId)
    .executeTakeFirst();
  if (listing === undefined) throw notFound();

  const services = await listServices(trx, listingId);
  const category = categoryConfig(listing.category_code);
  const attributes = category === undefined ? {} : readAttributes(category, listing.attributes);

  const photos = await trx
    .selectFrom("app.photos")
    .select(["id", "storage_key", "width", "height", "moderation", "moderation_reason", "is_cover"])
    .where("listing_id", "=", listingId)
    .where("deleted_at", "is", null)
    .where("status", "=", "ready")
    .orderBy("is_cover", "desc")
    .orderBy("sort")
    .orderBy("created_at")
    .execute();

  return {
    id: listing.id,
    slug: listing.slug,
    name: listing.name,
    status: listing.status,
    statusReason: listing.status_reason,
    categoryCode: listing.category_code,
    districtCode: listing.district_code,
    address: { ru: listing.address_ru ?? "", uz: listing.address_uz ?? "" },
    description: { ru: listing.description_ru ?? "", uz: listing.description_uz ?? "" },
    priceFromUzs: listing.price_from_uzs === null ? null : Number(listing.price_from_uzs),
    priceUnit: listing.price_unit,
    capMin: listing.cap_min,
    capMax: listing.cap_max,
    attributes,
    missingAttributes: category === undefined ? [] : missingAttributes(category, attributes),
    videoLinks: listing.video_links,
    parallelCapacity: listing.parallel_capacity,
    services,
    photos: photos.flatMap((p) => vendorPhoto(p, media) ?? []),
    phone: listing.phone,
    blockers: listing.blockers ?? [],
    reviewBlockers: listing.review_blockers ?? [],
    photoLimits: { min: listing.min_photos, max: listing.max_photos },
  };
}
