// Общее для маршрутов панели оператора: даты и числа в ответах, id из пути,
// краткие карточки вендора.

import type { ListingBrief, ListingStatus, PublishBlocker } from "@bayramm/shared/api/staff";
import { type RawBuilder, sql } from "kysely";
import type { Tx } from "../db/actor";
import { notFound } from "../errors";
import { isUuid } from "./input";

// Имя сотрудника по столбцу с его id — из db/pii, здесь для разделов панели
export { staffName } from "../db/pii";

export const LISTING_STATUSES = [
  "lead",
  "draft",
  "review",
  "active",
  "suspended",
  "rejected",
] as const satisfies readonly ListingStatus[];

/** Момент → ISO 8601 (UTC) */
export function iso(value: Date): string;
export function iso(value: Date | null): string | null;
export function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** bigint из pg приходит строкой; суммы в сумах меньше 2^53 — число без потерь */
export function num(value: string | number): number;
export function num(value: string | number | null): number | null;
export function num(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

/** id из пути: не UUID — 404 (такого объекта нет), без похода в базу */
export function pathId(raw: string | undefined): string {
  if (raw === undefined || !isUuid(raw)) throw notFound();
  return raw.toLowerCase();
}

/** Чего не хватает карточке для статуса target — коды app.listing_publish_blockers */
export function blockers(column: string, target: "review" | "active"): RawBuilder<PublishBlocker[]> {
  return sql<
    PublishBlocker[]
  >`coalesce(app.listing_publish_blockers(${sql.ref(column)}, ${target}::app.listing_status), '{}')`;
}

/** Карточки вендора — для его страницы */
export async function listingBriefs(trx: Tx, vendorId: string): Promise<ListingBrief[]> {
  const rows = await trx
    .selectFrom("app.listings as l")
    .select([
      "l.id",
      "l.name",
      "l.status",
      "l.slug",
      "l.district_code",
      "l.price_from_uzs",
      "l.price_unit",
      "l.cap_max",
      "l.updated_at",
      blockers("l.id", "active").as("blockers"),
    ])
    .where("l.vendor_id", "=", vendorId)
    .orderBy("l.created_at")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    slug: row.slug,
    districtCode: row.district_code,
    priceFromUzs: num(row.price_from_uzs),
    priceUnit: row.price_unit,
    capMax: row.cap_max,
    updatedAt: iso(row.updated_at),
    blockers: row.blockers,
  }));
}
