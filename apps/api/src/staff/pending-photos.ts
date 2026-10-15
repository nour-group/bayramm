// Фото, ждущие решения, для очереди «Новые фото»: одним запросом на всю страницу очереди,
// а не по запросу на карточку. Фильтр — тот же, что у самой очереди (GET /staff/listings?photos=pending):
// готовые, не удалённые, moderation = pending; старые загрузки первыми. У каждого — что отметил
// загрузивший (лиц нет или люди согласны): модератор сверяет это с правилом категории.

import { PENDING_PHOTOS_CAP, type PendingPhoto, type PhotoAck } from "@bayramm/shared/api/staff";
import type { Tx } from "../db/actor";

export interface PendingPhotoRow {
  readonly id: string;
  readonly listing_id: string;
  readonly storage_key: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly no_faces_ack: boolean;
  readonly people_consent_ack: boolean;
}

/** Отметка загрузившего: «лиц нет» главнее (как при загрузке — photoAckFromHeaders) */
export const photoAckOf = (row: Pick<PendingPhotoRow, "no_faces_ack" | "people_consent_ack">): PhotoAck =>
  row.no_faces_ack || !row.people_consent_ack ? "no_faces" : "people_consent";

/** Строки (уже по порядку загрузки) → фото по карточкам, не больше cap на карточку */
export function groupPendingPhotos(
  rows: readonly PendingPhotoRow[],
  cap: number = PENDING_PHOTOS_CAP,
): Map<string, PendingPhoto[]> {
  const byListing = new Map<string, PendingPhoto[]>();
  for (const row of rows) {
    const list = byListing.get(row.listing_id) ?? [];
    if (list.length < cap) {
      list.push({
        id: row.id,
        key: row.storage_key,
        width: row.width ?? 0,
        height: row.height ?? 0,
        ack: photoAckOf(row),
      });
    }
    byListing.set(row.listing_id, list);
  }
  return byListing;
}

export async function loadPendingPhotos(
  trx: Tx,
  listingIds: readonly string[],
): Promise<Map<string, PendingPhoto[]>> {
  if (listingIds.length === 0) return new Map();
  const rows = await trx
    .selectFrom("app.photos")
    .select(["id", "listing_id", "storage_key", "width", "height", "no_faces_ack", "people_consent_ack"])
    .where("listing_id", "in", [...listingIds])
    .where("deleted_at", "is", null)
    .where("status", "=", "ready")
    .where("moderation", "=", "pending")
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  return groupPendingPhotos(rows);
}
