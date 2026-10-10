// Отправка витрины на проверку из кабинета: владелец кабинета сделал свои пункты чек-листа
// (услуги, фото, описания, данные витрины) — черновик уходит команде (draft → review).
// Отклонённая — через черновик, одной транзакцией (как «Отправить на проверку» в панели).
//
// Переходы и готовность решает база: партнёру разрешены только draft → review и
// rejected → draft (listings_before_update), на review — без пунктов
// app.listing_publish_blockers(…, 'review') (иначе 422 publish_blocked с кодами). Оповещение
// тем, кто публикует, ставит триггер базы listings_submitted_notify (ops.listing_submitted).
// Только владелец кабинета (vendor/access.ts; в базе — app.edits_listing).

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
