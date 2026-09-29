// Фото карточки в панели оператора. Файл готовит браузер (compressForUpload из
// @bayramm/media/browser: уменьшение, перекодирование, без EXIF), сервер
// проверяет байты и кладёт в Storage (photos/service.ts).
//
//   GET    /staff/listings/:id/photos                          список
//   POST   /staff/listings/:id/photos                          загрузить: тело — файл,
//          X-No-Faces: 1 — сотрудник подтвердил, что лиц на фото нет
//   PUT    /staff/listings/:id/photos/order      { ids }       порядок
//   POST   /staff/listings/:id/photos/:photoId/cover           обложка (и первой в порядке)
//   POST   /staff/listings/:id/photos/:photoId/moderation { decision }  одобрить / отклонить
//   DELETE /staff/listings/:id/photos/:photoId                 удалить
//
// Все, кроме загрузки, отвечают списком фото карточки в новом порядке.

import { MAX_UPLOAD_BYTES } from "@bayramm/media";
import type { StaffPhoto } from "@bayramm/shared/api/staff";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { staffOf } from "../auth/session";
import { type Tx, withActor } from "../db/actor";
import type { AppEnv } from "../env";
import { ApiError, notFound } from "../errors";
import { addListingPhoto, type PhotoDeps, removeListingPhoto } from "../photos/service";
import { listingPhotoStorage } from "../storage/supabase";
import { requirePermission } from "./access";
import { Input, invalidInput, isUuid, limitJson, readBody } from "./input";
import { loadPhotos } from "./listings";
import { iso, pathId } from "./shared";

export const photos = new Hono<AppEnv>();

// Сам файл — до 10 МБ; запас на случай, если клиент пришлёт чуть больше: точный
// предел проверяет assertUploadable и отвечает понятной ошибкой
const limitUpload = bodyLimit({
  maxSize: MAX_UPLOAD_BYTES + 64 * 1024,
  onError: (c) =>
    c.json(new ApiError(413, "payload_too_large", "Photo is too large", ["too_large"]).toBody(), 413),
});

function deps(c: Context<AppEnv>): PhotoDeps {
  return { db: c.var.db, storage: listingPhotoStorage(c.env) };
}

async function listingExists(trx: Tx, id: string): Promise<void> {
  const found = await trx.selectFrom("app.listings").select("id").where("id", "=", id).executeTakeFirst();
  if (!found) throw notFound();
}

photos.get("/:id/photos", requirePermission("catalog.read"), async (c) => {
  const id = pathId(c.req.param("id"));
  const list = await withActor(c.var.db, staffOf(c), async (trx) => {
    await listingExists(trx, id);
    return loadPhotos(trx, id);
  });
  return c.json(list);
});

photos.post("/:id/photos", requirePermission("listings.write"), limitUpload, async (c) => {
  const id = pathId(c.req.param("id"));
  // Правило продукта: на фото площадки нет лиц. Без подтверждения не принимаем
  if (c.req.header("X-No-Faces") !== "1") {
    throw new ApiError(422, "no_faces_ack_required", "Confirm that the photo shows no faces");
  }
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  const photo = await addListingPhoto(deps(c), staffOf(c), id, bytes, { noFacesAck: true });
  const body: StaffPhoto = {
    id: photo.id,
    key: photo.storageKey,
    width: photo.width,
    height: photo.height,
    bytes: photo.bytes,
    sort: photo.sort,
    isCover: false,
    moderation: photo.moderation === "withdrawn" ? "declined" : photo.moderation,
    createdAt: iso(new Date()),
  };
  return c.json(body, 201);
});

photos.put("/:id/photos/order", requirePermission("listings.write"), limitJson, async (c) => {
  const id = pathId(c.req.param("id"));
  const body = await readBody(c.req.raw);
  const ids = Array.isArray(body.ids) ? body.ids : null;
  if (!ids || ids.length > 50 || !ids.every((v): v is string => typeof v === "string" && isUuid(v))) {
    throw invalidInput(["ids"]);
  }
  const order = ids.map((v) => v.toLowerCase());

  const list = await withActor(c.var.db, staffOf(c), async (trx) => {
    await listingExists(trx, id);
    const current = await loadPhotos(trx, id);
    // Порядок — перестановка всех фото карточки, без лишних и пропущенных
    const known = new Set(current.map((p) => p.id));
    if (
      order.length !== known.size ||
      new Set(order).size !== order.length ||
      !order.every((v) => known.has(v))
    ) {
      throw invalidInput(["ids"]);
    }
    for (const [index, photoId] of order.entries()) {
      await trx.updateTable("app.photos").set({ sort: index }).where("id", "=", photoId).execute();
    }
    return loadPhotos(trx, id);
  });
  return c.json(list);
});

function photoIds(c: Context<AppEnv>) {
  return { listing: pathId(c.req.param("id")), photo: pathId(c.req.param("photoId")) };
}

async function photoOf(trx: Tx, listing: string, photo: string) {
  const current = await loadPhotos(trx, listing);
  const found = current.find((p) => p.id === photo);
  if (!found) throw notFound();
  return current;
}

photos.post("/:id/photos/:photoId/cover", requirePermission("listings.write"), async (c) => {
  const ids = photoIds(c);
  const list = await withActor(c.var.db, staffOf(c), async (trx) => {
    const current = await photoOf(trx, ids.listing, ids.photo);
    // Одна обложка на карточку (уникальный индекс): сначала снять старую
    await trx
      .updateTable("app.photos")
      .set({ is_cover: false })
      .where("listing_id", "=", ids.listing)
      .where("is_cover", "=", true)
      .execute();
    await trx.updateTable("app.photos").set({ is_cover: true }).where("id", "=", ids.photo).execute();
    // Обложка — первой: так её видят и каталог, и кабинет, где порядок — по sort
    const order = [ids.photo, ...current.map((p) => p.id).filter((id) => id !== ids.photo)];
    for (const [index, photoId] of order.entries()) {
      await trx.updateTable("app.photos").set({ sort: index }).where("id", "=", photoId).execute();
    }
    return loadPhotos(trx, ids.listing);
  });
  return c.json(list);
});

photos.post("/:id/photos/:photoId/moderation", requirePermission("photos.moderate"), limitJson, async (c) => {
  const ids = photoIds(c);
  const input = new Input(await readBody(c.req.raw));
  const decision = input.oneOf("decision", ["approved", "declined"] as const, true);
  input.done();
  if (!decision) throw invalidInput(["decision"]);

  const list = await withActor(c.var.db, staffOf(c), async (trx) => {
    await photoOf(trx, ids.listing, ids.photo);
    // У опубликованной карточки одобренных фото не станет меньше минимума — триггер
    await trx.updateTable("app.photos").set({ moderation: decision }).where("id", "=", ids.photo).execute();
    return loadPhotos(trx, ids.listing);
  });
  return c.json(list);
});

photos.delete("/:id/photos/:photoId", requirePermission("listings.write"), async (c) => {
  const ids = photoIds(c);
  const actor = staffOf(c);
  await removeListingPhoto(deps(c), actor, ids.listing, ids.photo);
  const list = await withActor(c.var.db, actor, (trx) => loadPhotos(trx, ids.listing));
  return c.json(list);
});
