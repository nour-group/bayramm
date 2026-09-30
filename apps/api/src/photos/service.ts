// Фото листинга: добавить и удалить. Маршруты — панель (staff/photos.ts) и кабинет
// (routes/vendor.ts → vendor/photos.ts: только владелец кабинета). Сироты в хранилище
// и строки, удалённые больше 30 дней назад, убирает ежедневная сверка (photos/sweep.ts).
//
// Добавление:
//   1. проверка файла по байтам (@bayramm/media): WebP/JPEG/PNG, ≤ 10 МБ,
//      длинная сторона ≤ 2560, без EXIF/XMP — клиенту не верим;
//   2. предварительная проверка под актором: листинг свой (или сотрудник),
//      лимит фото, такой же файл ещё не загружен — чтобы не класть в хранилище
//      заведомо лишнее;
//   3. объект в Storage: listings/<листинг>/<id фото>.<расширение>;
//   4. строка в app.photos под актором (RLS и триггеры решают окончательно),
//      затем в той же транзакции system отмечает фото готовым — вендор сам
//      этого сделать не может (photos_guard);
//   5. если запись в базу не удалась — объект удаляется.
//
// Удаление: отметка deleted_at под актором (опубликованный листинг не
// останется меньше чем с 3 фото — триггер), затем удаление объекта.

import { assertUploadable, ImageError, type ImageInfo, listingPhotoKey } from "@bayramm/media";
import { sql } from "kysely";
import { type Actor, continueAsSystem, withActor } from "../db/actor";
import type { Db } from "../db/client";
import type { AppModerationStatus, AppPhotoStatus } from "../db/schema.generated";
import { ApiError, notFound, unauthorized } from "../errors";
import { type ObjectStorage, StorageError } from "../storage/supabase";

export interface PhotoDeps {
  readonly db: Db;
  readonly storage: ObjectStorage;
}

export interface ListingPhoto {
  readonly id: string;
  readonly listingId: string;
  /** Ключ объекта; адрес варианта — mediaUrl(storageKey, ширина, окружение) */
  readonly storageKey: string;
  readonly mime: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly sort: number;
  readonly status: AppPhotoStatus;
  readonly moderation: AppModerationStatus;
}

export interface AddPhotoOptions {
  /** Загрузивший подтвердил: на фото нет лиц (правило продукта, столбец no_faces_ack) */
  readonly noFacesAck: true;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Фото загружают вендор (в свои листинги) и сотрудники; клиент и гость — нет
function assertUploader(actor: Actor): void {
  if (actor.kind === "guest") throw unauthorized();
  if (actor.kind === "client") {
    throw new ApiError(403, "forbidden_for_actor", "Action is not allowed for this actor");
  }
}

/** Отказ проверки файла → ответ API. Код из ImageError — в details, по нему интерфейс выбирает текст */
export function imageApiError(err: ImageError): ApiError {
  if (err.code === "too_large") {
    return new ApiError(413, "payload_too_large", "Photo is too large", [err.code]);
  }
  return new ApiError(422, "invalid_image", "Photo is not accepted", [err.code]);
}

function inspect(bytes: Uint8Array): ImageInfo {
  try {
    return assertUploadable(bytes);
  } catch (err) {
    if (err instanceof ImageError) throw imageApiError(err);
    throw err;
  }
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

const storageUnavailable = (cause: unknown) => {
  console.error("photos: storage failed", cause instanceof StorageError ? cause.reason : "unknown", cause);
  return new ApiError(503, "storage_unavailable", "Photo storage is temporarily unavailable");
};

export async function addListingPhoto(
  deps: PhotoDeps,
  actor: Actor,
  listingId: string,
  bytes: Uint8Array,
  options: AddPhotoOptions,
): Promise<ListingPhoto> {
  assertUploader(actor);
  if (!UUID_RE.test(listingId)) throw notFound();
  if (options.noFacesAck !== true) {
    throw new ApiError(422, "invalid_input", "Confirmation that the photo has no faces is required");
  }
  const listing = listingId.toLowerCase();
  const info = inspect(bytes);
  const digest = await sha256(bytes);

  // Предварительно: до хранилища отсекаем чужой листинг, лимит и повтор.
  // Окончательно то же проверяют RLS, photos_guard и photos_dedupe при вставке
  const state = await withActor(deps.db, actor, (trx) =>
    trx
      .selectFrom("app.listings as l")
      .select([
        sql<number>`(select count(*)::int from app.photos p
                     where p.listing_id = l.id and p.deleted_at is null)`.as("photos"),
        sql<boolean>`exists (select 1 from app.photos p
                             where p.listing_id = l.id and p.deleted_at is null and p.sha256 = ${digest})`.as(
          "duplicate",
        ),
        sql<number | null>`app.setting_int('max_photos')`.as("max_photos"),
      ])
      .where("l.id", "=", listing)
      .where(sql<boolean>`app.is_privileged() or app.owns_listing(l.id)`)
      .executeTakeFirst(),
  );
  if (state === undefined) throw notFound();
  if (state.photos >= (state.max_photos ?? 10)) {
    throw new ApiError(409, "too_many_photos", "Photo limit reached");
  }
  if (state.duplicate) throw new ApiError(409, "duplicate_photo", "This photo is already uploaded");

  const id = crypto.randomUUID();
  const key = listingPhotoKey(listing, id, info.format);
  try {
    await deps.storage.put(key, bytes, info.mime);
  } catch (err) {
    throw storageUnavailable(err);
  }

  try {
    return await withActor(deps.db, actor, async (trx) => {
      await trx
        .insertInto("app.photos")
        .values({
          id,
          listing_id: listing,
          storage_key: key,
          mime: info.mime,
          bytes: info.bytes,
          width: info.width,
          height: info.height,
          sha256: digest,
          no_faces_ack: true,
          // В конец списка листинга
          sort: sql<number>`(select coalesce(max(p.sort) + 1, 0) from app.photos p
                             where p.listing_id = ${listing} and p.deleted_at is null)`,
        })
        .execute();

      // Файл проверил сервер, а не вендор: «готово» ставит system
      await continueAsSystem(trx);
      const row = await trx
        .updateTable("app.photos")
        .set({ status: "ready", processed_at: sql<Date>`now()` })
        .where("id", "=", id)
        .returning([
          "id",
          "listing_id",
          "storage_key",
          "mime",
          "bytes",
          "width",
          "height",
          "sort",
          "status",
          "moderation",
        ])
        .executeTakeFirstOrThrow();
      return {
        id: row.id,
        listingId: row.listing_id,
        storageKey: row.storage_key,
        mime: row.mime ?? info.mime,
        bytes: row.bytes ?? info.bytes,
        width: row.width ?? info.width,
        height: row.height ?? info.height,
        sort: row.sort,
        status: row.status,
        moderation: row.moderation,
      };
    });
  } catch (err) {
    // Строки нет — объект никому не нужен. Не удалился — останется сиротой (через
    // сутки его удалит ежедневная сверка), но это не повод прятать исходную ошибку
    await deps.storage.remove(key).catch((removeErr: unknown) => {
      console.error("photos: orphan object after failed insert", key, removeErr);
    });
    throw err;
  }
}

export interface RemovedPhoto {
  readonly id: string;
  readonly storageKey: string;
  /** false — объект не удалился (хранилище недоступно); строка всё равно помечена удалённой */
  readonly objectRemoved: boolean;
}

export async function removeListingPhoto(
  deps: PhotoDeps,
  actor: Actor,
  listingId: string,
  photoId: string,
): Promise<RemovedPhoto> {
  assertUploader(actor);
  if (!UUID_RE.test(listingId) || !UUID_RE.test(photoId)) throw notFound();

  // Под актором: чужое фото RLS не покажет; триггер не даст опубликованному
  // листингу остаться меньше чем с 3 фото (publish_blocked)
  const row = await withActor(deps.db, actor, (trx) =>
    trx
      .updateTable("app.photos")
      .set({ deleted_at: sql<Date>`now()` })
      .where("id", "=", photoId.toLowerCase())
      .where("listing_id", "=", listingId.toLowerCase())
      .where("deleted_at", "is", null)
      .returning(["id", "storage_key"])
      .executeTakeFirst(),
  );
  if (row === undefined) throw notFound();

  try {
    await deps.storage.remove(row.storage_key);
    return { id: row.id, storageKey: row.storage_key, objectRemoved: true };
  } catch (err) {
    // Фото уже нигде не показывается (строка удалена), но объект остался: его удалит
    // ежедневная сверка вместе со строкой, когда той исполнится 30 дней (photos/sweep.ts)
    console.error("photos: object not removed", row.storage_key, err);
    return { id: row.id, storageKey: row.storage_key, objectRemoved: false };
  }
}
