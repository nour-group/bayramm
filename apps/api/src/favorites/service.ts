// Избранное клиента: площадки, отмеченные сердечком (app.favorites, миграция
// 20260930230000_favorites.sql).
//
// Гость хранит свой список в браузере (id площадок) и берёт карточки публичным
// GET /catalog/cards; вошедший клиент — в аккаунте, под своим актором: RLS отдаёт
// только его строки. При входе гостевой список сливается с аккаунтом
// (app.client_favorites_merge). Добавляют только функции базы: они же держат лимит
// FAVORITES_MAX и пускают только опубликованные площадки.
//
// Показываются только опубликованные: снятая с публикации площадка остаётся в таблице,
// но в список не попадает — без ошибок, а с новой публикацией возвращается.

import { FAVORITES_MAX, type ListingCard } from "@bayramm/shared/api";
import type { Favorites } from "@bayramm/shared/api/me";
import { sql } from "kysely";
import { listingCards } from "../catalog/service";
import { type ClientActor, withActor } from "../db/actor";
import type { Db } from "../db/client";
import { ApiError, notFound } from "../errors";

export { FAVORITES_MAX };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const favoritesFull = () =>
  new ApiError(409, "favorites_full", `Favorites list is full (${FAVORITES_MAX})`);

/** id листинга из пути: не UUID — такого листинга нет (404), как у любого чужого id */
export function listingIdParam(value: string): string {
  if (!UUID_RE.test(value)) throw notFound();
  return value.toLowerCase();
}

/**
 * Список id: массив UUID, не больше FAVORITES_MAX; повторы убираются, порядок — как
 * прислали. Иначе — 400 invalid_request с именем поля
 */
export function parseListingIds(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length > FAVORITES_MAX ||
    !value.every((id) => typeof id === "string" && UUID_RE.test(id))
  ) {
    throw new ApiError(400, "invalid_request", `${field} must be up to ${FAVORITES_MAX} listing ids`, [
      field,
    ]);
  }
  return [...new Set(value.map((id: string) => id.toLowerCase()))];
}

/** id из строки запроса «a,b,c» (GET /catalog/cards?ids=…) */
export function parseIdsQuery(value: string | undefined): string[] {
  if (value === undefined || value === "") return [];
  return parseListingIds(value.split(","), "ids");
}

/** Отмеченные опубликованные площадки клиента, последние — первыми */
export async function listFavorites(db: Db, actor: ClientActor): Promise<Favorites> {
  const items: ListingCard[] = await withActor(db, actor, async (trx) => {
    const rows = await trx
      .selectFrom("app.favorites")
      .select("listing_id")
      .where("client_id", "=", actor.id)
      .orderBy("created_at", "desc")
      .orderBy("listing_id")
      .limit(FAVORITES_MAX)
      .execute();
    return listingCards(
      trx,
      rows.map((row) => row.listing_id),
    );
  });
  return { items };
}

type AddResult = "added" | "already" | "not_found" | "full";

/** Отметить площадку: опубликованной нет — 404; уже FAVORITES_MAX — 409 favorites_full */
export async function addFavorite(db: Db, actor: ClientActor, listingId: string): Promise<void> {
  const result = await withActor(db, actor, async (trx) => {
    const { rows } = await sql<{ result: AddResult }>`
      select app.client_favorite_add(${listingId}::uuid) as result`.execute(trx);
    return rows[0]?.result;
  });
  if (result === undefined) throw new Error("client_favorite_add: нет результата");
  if (result === "not_found") throw notFound();
  if (result === "full") throw favoritesFull();
}

/** Снять отметку; её не было — тоже успех */
export async function removeFavorite(db: Db, actor: ClientActor, listingId: string): Promise<void> {
  await withActor(db, actor, (trx) =>
    trx
      .deleteFrom("app.favorites")
      .where("client_id", "=", actor.id)
      .where("listing_id", "=", listingId)
      .execute(),
  );
}

/** Гостевой список — в аккаунт (при входе); ответ — весь список после слияния */
export async function mergeFavorites(db: Db, actor: ClientActor, listingIds: readonly string[]) {
  if (listingIds.length > 0) {
    await withActor(db, actor, (trx) =>
      sql`select app.client_favorites_merge(${listingIds}::uuid[])`.execute(trx),
    );
  }
  return listFavorites(db, actor);
}
