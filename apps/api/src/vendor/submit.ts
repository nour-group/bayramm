// Отправка витрины на проверку из кабинета: владелец кабинета сделал свои пункты чек-листа
// (услуги, фото, описания, данные витрины) — черновик уходит команде (draft → review).
// Отклонённая — через черновик, одной транзакцией (как «Отправить на проверку» в панели).
//
// Переходы и готовность решает база: партнёру разрешены только draft → review и
// rejected → draft (listings_before_update), на review — без пунктов
// app.listing_publish_blockers(…, 'review') (иначе 422 publish_blocked с кодами). Оповещение
// тем, кто публикует, ставит триггер базы listings_submitted_notify (ops.listing_submitted).
// Только владелец кабинета (vendor/access.ts; в базе — app.edits_listing).
//
// Отозвать с проверки — обратный шаг: review → draft (listings_before_update партнёру его
// разрешает), чтобы снова править витрину напрямую. Очередь проверки у команды строится по
// статусу — витрина из неё уходит; неотправленное оповещение ops.listing_submitted при отправке
// видит, что витрина уже не на проверке, и пропускается. Команде отдельного оповещения нет.

import type { MediaEnv } from "@bayramm/media";
import type { VendorListing } from "@bayramm/shared/api/vendor";
import { type VendorActor, withActor } from "../db/actor";
import type { Db } from "../db/client";
import { ApiError, notFound } from "../errors";
import { assertVendorCan } from "./access";
import { readListing } from "./profile";

/** Шаги до проверки по статусу витрины; остальные статусы отправить нельзя */
const STEPS: Readonly<Partial<Record<VendorListing["status"], readonly VendorListing["status"][]>>> = {
  draft: ["review"],
  rejected: ["draft", "review"],
};

/** POST /vendor/listings/:id/submit */
export function submitListing(
  db: Db,
  actor: VendorActor,
  listingId: string,
  media: MediaEnv,
): Promise<VendorListing> {
  assertVendorCan(actor, "card.propose");
  return withActor(db, actor, async (trx) => {
    const current = await trx
      .selectFrom("app.listings")
      .select("status")
      .where("id", "=", listingId)
      .where("vendor_id", "=", actor.vendorId)
      .forUpdate()
      .executeTakeFirst();
    if (current === undefined) throw notFound();
    const steps = STEPS[current.status];
    if (steps === undefined)
      throw new ApiError(409, "illegal_transition", "Only a draft or rejected listing can be submitted");
    for (const status of steps) {
      await trx.updateTable("app.listings").set({ status }).where("id", "=", listingId).execute();
    }
    return readListing(trx, actor, listingId, media);
  });
}

/** POST /vendor/listings/:id/withdraw: с проверки обратно в черновик; в журнал — id витрины */
export function withdrawListing(
  db: Db,
  actor: VendorActor,
  listingId: string,
  media: MediaEnv,
): Promise<VendorListing> {
  assertVendorCan(actor, "card.propose");
  return withActor(db, actor, async (trx) => {
    const current = await trx
      .selectFrom("app.listings")
      .select("status")
      .where("id", "=", listingId)
      .where("vendor_id", "=", actor.vendorId)
      .forUpdate()
      .executeTakeFirst();
    if (current === undefined) throw notFound();
    if (current.status !== "review")
      throw new ApiError(409, "illegal_transition", "Only a listing on review can be withdrawn");
    await trx.updateTable("app.listings").set({ status: "draft" }).where("id", "=", listingId).execute();
    await trx
      .insertInto("app.audit_log")
      .values({
        action: "listing.withdraw",
        object_type: "listing",
        object_id: listingId,
        detail: JSON.stringify({ from: "review", to: "draft" }),
        source: "vendor_cabinet",
      })
      .execute();
    return readListing(trx, actor, listingId, media);
  });
}
