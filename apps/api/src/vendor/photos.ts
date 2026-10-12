// Фото площадки из кабинета: владелец кабинета загружает и удаляет фото своей площадки.
//
// Путь тот же, что у сотрудника (photos/service.ts): файл готовит браузер
// (compressForUpload — перекодирование, без EXIF и GPS), сервер проверяет байты
// (assertUploadable), кладёт объект в Storage и пишет строку под актором партнёра —
// чужую площадку RLS не покажет (404), лимит и повтор файла проверит база.
//
//   · новое фото ждёт решения модератора (moderation = pending): клиенты видят только
//     одобренные фото (каталог и RLS), пока модератор не решит или не опубликует
//     карточку целиком. Фото опубликованной карточки — оповещение команде
//     ops.photos_submitted (триггер photos_notify, в payload только id площадки);
//   · удалить можно любое фото своей площадки — и ждущее, и отклонённое, и
//     одобренное; опубликованная площадка не останется без минимума одобренных фото
//     (триггер photos_keep_ready → 422 publish_blocked);
//   · порядок и обложку выбирает владелец кабинета сам, сразу, без проверки — у одобренных фото
//     (клиентам видны только они): новое фото встаёт в конец, команда при модерации тоже
//     может переставить. Обложка — одобренное фото, первое в порядке (в базе — photos_vendor_guard);
//     ждущие решения и отклонённые фото порядок не затрагивает. В журнал — id витрины и число
//     фото или id фото, без ПДн;
//   · только владелец кабинета (vendor/access.ts; в базе — app.edits_listing).

import type { MediaEnv } from "@bayramm/media";
import type { VendorPhoto, VendorPhotoList } from "@bayramm/shared/api/vendor";
import { type Tx, type VendorActor, withActor } from "../db/actor";
import type { Db } from "../db/client";
import { ApiError, notFound } from "../errors";
import { addListingPhoto, type PhotoAck, type PhotoDeps, removeListingPhoto } from "../photos/service";
import { invalidInput } from "../staff/input";
import { assertVendorCan } from "./access";
import { loadVendorPhotos, vendorPhoto } from "./profile";

/**
 * POST /vendor/listings/:id/photos — подтверждение из заголовков (X-No-Faces, X-Photo-Consent):
 * какое нужно, решает правило фото категории витрины
 */
export async function uploadPhoto(
  deps: PhotoDeps,
  actor: VendorActor,
  listingId: string,
  bytes: Uint8Array,
  media: MediaEnv,
  ack: PhotoAck | null,
): Promise<VendorPhoto> {
  assertVendorCan(actor, "photos.write");
  const photo = await addListingPhoto(deps, actor, listingId, bytes, { ack });
  const view = vendorPhoto(
    {
      id: photo.id,
      storage_key: photo.storageKey,
      width: photo.width,
      height: photo.height,
      moderation: photo.moderation,
      moderation_reason: null,
      is_cover: false,
    },
    media,
  );
  // Файл проверен сервером: размеры известны всегда
  if (view === null) throw new Error("vendor photos: uploaded photo has no size");
  return view;
}

/** DELETE /vendor/listings/:id/photos/:photoId */
export async function deletePhoto(
  deps: PhotoDeps,
  actor: VendorActor,
  listingId: string,
  photoId: string,
): Promise<void> {
  assertVendorCan(actor, "photos.write");
  await removeListingPhoto(deps, actor, listingId, photoId);
}

/** Одобренные фото своей витрины в порядке показа (под блокировкой строк): id, порядок, обложка */
async function approvedPhotos(trx: Tx, actor: VendorActor, listingId: string) {
  const listing = await trx
    .selectFrom("app.listings")
    .select("id")
    .where("id", "=", listingId)
    .where("vendor_id", "=", actor.vendorId)
    .executeTakeFirst();
  if (listing === undefined) throw notFound();
  return trx
    .selectFrom("app.photos")
    .select(["id", "sort", "is_cover"])
    .where("listing_id", "=", listingId)
    .where("deleted_at", "is", null)
    .where("status", "=", "ready")
    .where("moderation", "=", "approved")
    .orderBy("is_cover", "desc")
    .orderBy("sort")
    .orderBy("created_at")
    .orderBy("id")
    .forUpdate()
    .execute();
}

/**
 * Одобренные фото — в этом порядке, на тех же местах: каждое получает значение sort, которое
 * было у фото на его новом месте. Ждущие решения и отклонённые остаются как были (и после
 * одобренных, куда их ставит загрузка)
 */
async function placeApproved(
  trx: Tx,
  current: readonly { readonly id: string; readonly sort: number }[],
  order: readonly string[],
): Promise<void> {
  const slots = current.map((photo) => photo.sort).sort((a, b) => a - b);
  for (const [index, id] of order.entries()) {
    const sort = slots[index];
    if (sort === undefined) continue;
    await trx.updateTable("app.photos").set({ sort }).where("id", "=", id).execute();
  }
}

/** Запись в журнал действий: кто и когда — из транзакции; в detail только id и числа */
async function logPhotoAction(
  trx: Tx,
  listingId: string,
  action: "photo.order" | "photo.cover",
  detail: Record<string, string | number>,
): Promise<void> {
  await trx
    .insertInto("app.audit_log")
    .values({
      action,
      object_type: "listing",
      object_id: listingId,
      detail: JSON.stringify(detail),
      source: "vendor_cabinet",
    })
    .execute();
}

/**
 * PUT /vendor/listings/:id/photos/order { ids }: порядок одобренных фото. ids — все одобренные
 * фото витрины, без лишних и пропущенных (иначе 422 invalid_input ids); обложка остаётся первой
 */
export function reorderPhotos(
  db: Db,
  actor: VendorActor,
  listingId: string,
  ids: readonly string[],
  media: MediaEnv,
): Promise<VendorPhotoList> {
  assertVendorCan(actor, "photos.write");
  return withActor(db, actor, async (trx) => {
    const current = await approvedPhotos(trx, actor, listingId);
    const known = new Set(current.map((photo) => photo.id));
    if (ids.length !== known.size || new Set(ids).size !== ids.length || !ids.every((id) => known.has(id))) {
      throw invalidInput(["ids"]);
    }
    // Обложка — всегда первой, как её видят клиенты: порядок ставится после неё
    const cover = current.find((photo) => photo.is_cover);
    const order = cover === undefined ? ids : [cover.id, ...ids.filter((id) => id !== cover.id)];
    await placeApproved(trx, current, order);
    await logPhotoAction(trx, listingId, "photo.order", { count: ids.length });
    return { photos: await loadVendorPhotos(trx, listingId, media) };
  });
}

/**
 * POST /vendor/listings/:id/photos/:photoId/cover: обложка — одобренное фото (первым в порядке);
 * ждущее решения, отклонённое и чужое — 422 invalid_input photoId / 404
 */
export function setCoverPhoto(
  db: Db,
  actor: VendorActor,
  listingId: string,
  photoId: string,
  media: MediaEnv,
): Promise<VendorPhotoList> {
  assertVendorCan(actor, "photos.write");
  return withActor(db, actor, async (trx) => {
    const current = await approvedPhotos(trx, actor, listingId);
    if (!current.some((photo) => photo.id === photoId)) {
      const exists = await trx
        .selectFrom("app.photos")
        .select("id")
        .where("id", "=", photoId)
        .where("listing_id", "=", listingId)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (exists === undefined) throw notFound();
      throw new ApiError(422, "invalid_input", "Only an approved photo can be the cover", ["photoId"]);
    }
    // Одна обложка на витрину (уникальный индекс): сначала снять старую
    await trx
      .updateTable("app.photos")
      .set({ is_cover: false })
      .where("listing_id", "=", listingId)
      .where("is_cover", "=", true)
      .where("deleted_at", "is", null)
      .execute();
    await trx.updateTable("app.photos").set({ is_cover: true }).where("id", "=", photoId).execute();
    await placeApproved(trx, current, [
      photoId,
      ...current.map((photo) => photo.id).filter((id) => id !== photoId),
    ]);
    await logPhotoAction(trx, listingId, "photo.cover", { photo_id: photoId });
    return { photos: await loadVendorPhotos(trx, listingId, media) };
  });
}
