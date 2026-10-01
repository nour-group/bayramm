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
//   · порядок и обложку выбирает команда при модерации: новое фото встаёт в конец;
//   · только владелец кабинета (vendor/access.ts; в базе — app.edits_listing).

import type { MediaEnv } from "@bayramm/media";
import type { VendorPhoto } from "@bayramm/shared/api/vendor";
import type { VendorActor } from "../db/actor";
import { addListingPhoto, type PhotoAck, type PhotoDeps, removeListingPhoto } from "../photos/service";
import { assertVendorCan } from "./access";
import { vendorPhoto } from "./profile";

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
