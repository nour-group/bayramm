// Профиль кабинета и карточка площадки — только чтение (кроме языка).
//
// Карточку партнёр меняет предложением правки (vendor/revisions.ts) и загрузкой фото
// (vendor/photos.ts): это модерируемые данные, решает команда. Адрес, вместимость и
// телефон меняет менеджер. Кабинет показывает карточку как есть в базе.

import { type MediaEnv, mediaSrcSet, mediaUrl } from "@bayramm/media";
import type { Locale, VendorListing, VendorMe, VendorPhoto } from "@bayramm/shared/api/vendor";
import { sql } from "kysely";
import { type Tx, type VendorActor, withActor } from "../db/actor";
import type { Db } from "../db/client";
import { listingPhone, vendorContactsAs, vendorUserProfilesAs } from "../db/pii";
import { ApiError, notFound } from "../errors";

const LOCALES: readonly Locale[] = ["ru", "uz"];

export function parseLocale(body: unknown): Locale {
  const locale =
    typeof body === "object" && body !== null ? (body as { locale?: unknown }).locale : undefined;
  if (!(LOCALES as readonly unknown[]).includes(locale)) {
    throw new ApiError(422, "invalid_input", "Invalid input", ["locale"]);
  }
  return locale as Locale;
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
    .select(["id", "name", "status"])
    .where("vendor_id", "=", actor.vendorId)
    .orderBy("created_at")
    .orderBy("id")
    .execute();

  return {
    user: {
      id: user.id,
      locale: user.locale,
      fullName: user.full_name,
      role: user.role === "owner" ? "owner" : "member",
    },
    vendor: { id: user.vendor_id, code: user.public_code, name: user.legal_name },
    listings: listings.map((l) => ({ id: l.id, name: l.name, status: l.status })),
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
    isCover: p.is_cover,
    src: mediaUrl(p.storage_key, PHOTO_WIDTH, media),
    srcSet: mediaSrcSet(p.storage_key, media, [320, 640, 960]),
  };
}

/** GET /vendor/listings/:id: своя площадка как есть в базе; чужая (даже опубликованная) — 404 */
export async function getListing(
  db: Db,
  actor: VendorActor,
  listingId: string,
  media: MediaEnv,
): Promise<VendorListing> {
  return withActor(db, actor, async (trx) => {
    const listing = await trx
      .selectFrom("app.listings")
      .selectAll()
      .select([
        sql<string[] | null>`app.listing_publish_blockers(id, 'active')`.as("blockers"),
        listingPhone("id").as("phone"),
        sql<number>`greatest(3, coalesce(app.setting_int('min_photos'), 3))`.as("min_photos"),
        sql<number>`coalesce(app.setting_int('max_photos'), 10)`.as("max_photos"),
      ])
      .where("id", "=", listingId)
      .where("vendor_id", "=", actor.vendorId)
      .executeTakeFirst();
    if (listing === undefined) throw notFound();

    const packages = await trx
      .selectFrom("app.listing_packages")
      .select(["kind", "name_ru", "name_uz", "price_uzs", "price_unit"])
      .where("listing_id", "=", listingId)
      .orderBy("sort")
      .orderBy("created_at")
      .execute();

    const photos = await trx
      .selectFrom("app.photos")
      .select(["id", "storage_key", "width", "height", "moderation", "is_cover"])
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
      packages: packages.map((p) => ({
        kind: p.kind,
        name: { ru: p.name_ru, uz: p.name_uz },
        priceUzs: Number(p.price_uzs),
        priceUnit: p.price_unit,
      })),
      photos: photos.flatMap((p) => vendorPhoto(p, media) ?? []),
      phone: listing.phone,
      blockers: listing.blockers ?? [],
      photoLimits: { min: listing.min_photos, max: listing.max_photos },
    };
  });
}
