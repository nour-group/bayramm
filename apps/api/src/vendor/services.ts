// Услуги витрины из кабинета: партнёр заводит их из каталога категории (или «другую
// услугу» со своим названием) и правит — клиент видит только одобренное командой.
//
//   · новая услуга — на проверку (или черновиком: submit = false);
//   · черновик, отклонённую и ждущую проверки — правит сразу (и снова отправляет);
//   · активную у карточки на проверке или опубликованной — только предложением (proposal):
//     клиент видит прежнее, пока команда не решит (staff/services.ts);
//   · отозвать: на проверке — в черновик, предложение — отозвано, активную — снять с витрины;
//   · только владелец кабинета (vendor/access.ts, в базе — app.edits_listing).
// Чужая витрина или услуга — 404 (RLS и явная проверка вендора).

import type { ListingService, ListingServices } from "@bayramm/shared/api/vendor";
import { type Tx, type VendorActor, withActor } from "../db/actor";
import type { Db } from "../db/client";
import { notFound } from "../errors";
import {
  createService,
  deleteService,
  listServices,
  type ServiceActor,
  type ServiceListing,
  submitService,
  updateService,
  withdrawService,
} from "../listing-services/store";
import { assertVendorCan } from "./access";

async function ownListing(trx: Tx, actor: VendorActor, listingId: string): Promise<ServiceListing> {
  const listing = await trx
    .selectFrom("app.listings")
    .select(["id", "category_code", "status"])
    .where("id", "=", listingId)
    .where("vendor_id", "=", actor.vendorId)
    .executeTakeFirst();
  if (listing === undefined) throw notFound();
  return listing;
}

/** Партнёр не решает; после отправки карточки на проверку активные услуги — только предложением */
function partner(listing: ServiceListing): ServiceActor {
  return { decides: false, restricted: ["review", "active", "suspended"].includes(listing.status) };
}

/** GET /vendor/listings/:id/services */
export function listVendorServices(db: Db, actor: VendorActor, listingId: string): Promise<ListingServices> {
  return withActor(db, actor, async (trx) => {
    await ownListing(trx, actor, listingId);
    return { items: await listServices(trx, listingId) };
  });
}

/** POST /vendor/listings/:id/services */
export function createVendorService(
  db: Db,
  actor: VendorActor,
  listingId: string,
  body: unknown,
): Promise<ListingService> {
  assertVendorCan(actor, "card.propose");
  return withActor(db, actor, async (trx) => {
    const listing = await ownListing(trx, actor, listingId);
    return createService(trx, listing, body, partner(listing));
  });
}

/** PATCH /vendor/listings/:id/services/:serviceId */
export function updateVendorService(
  db: Db,
  actor: VendorActor,
  listingId: string,
  serviceId: string,
  body: unknown,
): Promise<ListingService> {
  assertVendorCan(actor, "card.propose");
  return withActor(db, actor, async (trx) => {
    const listing = await ownListing(trx, actor, listingId);
    return updateService(trx, listing, serviceId, body, partner(listing));
  });
}

/** POST /vendor/listings/:id/services/:serviceId/submit */
export function submitVendorService(
  db: Db,
  actor: VendorActor,
  listingId: string,
  serviceId: string,
): Promise<ListingService> {
  assertVendorCan(actor, "card.propose");
  return withActor(db, actor, async (trx) => {
    const listing = await ownListing(trx, actor, listingId);
    return submitService(trx, listing, serviceId, partner(listing));
  });
}

/** POST /vendor/listings/:id/services/:serviceId/withdraw */
export function withdrawVendorService(
  db: Db,
  actor: VendorActor,
  listingId: string,
  serviceId: string,
): Promise<ListingService> {
  assertVendorCan(actor, "card.propose");
  return withActor(db, actor, async (trx) =>
    withdrawService(trx, await ownListing(trx, actor, listingId), serviceId),
  );
}

/** DELETE /vendor/listings/:id/services/:serviceId */
export function deleteVendorService(
  db: Db,
  actor: VendorActor,
  listingId: string,
  serviceId: string,
): Promise<void> {
  assertVendorCan(actor, "card.propose");
  return withActor(db, actor, async (trx) =>
    deleteService(trx, await ownListing(trx, actor, listingId), serviceId),
  );
}
