// Публичные телефон и Telegram витрины из кабинета — те, что клиент видит по «Связаться»
// (правило продукта «телефон виден сразу»: клиенты всегда видят нынешние одобренные контакты).
//
//   · витрина вне сайта (черновик, отклонённая, лид) — владелец кабинета сохраняет сразу
//     (контакты витрины: RLS и база дают это владельцу; в журнал база пишет имена полей,
//     без значений);
//   · витрина на проверке, опубликована или приостановлена — те же статусы, где название и
//     описания меняются только правкой, — изменение уходит запросом на проверку
//     (таблица запросов: одна ждущая строка на витрину, новый запрос заменяет прежний);
//     прямая запись партнёра закрыта базой (BR036). Клиенты до решения команды видят прежние
//     контакты; решает администратор или модератор (staff/contact-changes.ts);
//   · телефон обязателен (витрина без него не публикуется), Telegram — нет: пусто — убрать;
//   · значения разбирает тот же код, что у панели (Input.phone, Input.telegram:
//     normalizeUzPhone, normalizeTelegram из @bayramm/shared); обращение к ПДн — только в модуле db/pii;
//   · только владелец кабинета (vendor/access.ts, contacts.write).

import type { MediaEnv } from "@bayramm/media";
import type { VendorContactsSave, VendorListing } from "@bayramm/shared/api/vendor";
import { type VendorActor, withActor } from "../db/actor";
import type { Db } from "../db/client";
import {
  readListingContacts,
  saveListingPhone,
  saveListingTelegram,
  submitContactChange,
  withdrawContactChange,
} from "../db/pii";
import { ApiError, notFound } from "../errors";
import { Input, invalidInput } from "../staff/input";
import { assertVendorCan } from "./access";
import { readListing } from "./profile";

/** Статусы, где контакты меняются запросом (как moderated_field_requires_revision в базе) */
const MODERATED: ReadonlySet<VendorListing["status"]> = new Set(["review", "active", "suspended"]);

const noChanges = () => new ApiError(422, "no_changes", "Contacts are the same as now");

export interface ParsedContacts {
  readonly phone: string;
  /** Имя без @; null — Telegram не нужен */
  readonly telegram: string | null;
}

/** Тело PUT …/contacts: phone обязателен, telegram — по желанию; неверное — 422 invalid_input (phone | telegram) */
export function parseContacts(body: unknown): ParsedContacts {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError(400, "invalid_request", "Body must be a JSON object");
  }
  const input = new Input(body as Record<string, unknown>);
  const phone = input.phone("phone", true);
  const telegram = input.telegram("telegram");
  input.done();
  if (typeof phone !== "string") throw invalidInput(["phone"]);
  return { phone, telegram: telegram ?? null };
}

/** PUT /vendor/listings/:id/contacts: сразу (витрина вне сайта) или запросом на проверку */
export function saveContacts(
  db: Db,
  actor: VendorActor,
  listingId: string,
  contacts: ParsedContacts,
  media: MediaEnv,
): Promise<VendorContactsSave> {
  assertVendorCan(actor, "contacts.write");
  return withActor(db, actor, async (trx) => {
    const listing = await trx
      .selectFrom("app.listings")
      .select("status")
      .where("id", "=", listingId)
      .where("vendor_id", "=", actor.vendorId)
      .executeTakeFirst();
    if (listing === undefined) throw notFound();

    const moderated = MODERATED.has(listing.status);
    if (moderated) {
      // null — значения те же, что сейчас; витрина успела выйти с сайта — BR038 (перечитайте)
      if ((await submitContactChange(trx, listingId, contacts.phone, contacts.telegram)) === null) {
        throw noChanges();
      }
    } else {
      const current = await readListingContacts(trx, listingId, null);
      if (current.phone === contacts.phone && current.telegram === contacts.telegram) throw noChanges();
      await saveListingPhone(trx, listingId, contacts.phone);
      if (!(await saveListingTelegram(trx, listingId, contacts.telegram))) throw invalidInput(["telegram"]);
    }
    return { sentForModeration: moderated, listing: await readListing(trx, actor, listingId, media) };
  });
}

/** POST /vendor/listings/:id/contact-change/withdraw: отозвать ждущий запрос (его нет — 409) */
export function withdrawContacts(
  db: Db,
  actor: VendorActor,
  listingId: string,
  media: MediaEnv,
): Promise<VendorListing> {
  assertVendorCan(actor, "contacts.write");
  return withActor(db, actor, async (trx) => {
    const listing = await trx
      .selectFrom("app.listings")
      .select("id")
      .where("id", "=", listingId)
      .where("vendor_id", "=", actor.vendorId)
      .executeTakeFirst();
    if (listing === undefined) throw notFound();
    await withdrawContactChange(trx, listingId);
    return readListing(trx, actor, listingId, media);
  });
}
