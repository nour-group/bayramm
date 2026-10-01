// Поля заявки категории (app.requests.details) — проверка по форме категории витрины.
//
//   · число гостей — по форме: обязательно, можно не указывать или не спрашивается;
//   · поля категории — validateRequestDetails из @bayramm/shared/categories (те же правила,
//     что в форме клиента); район — из справочника;
//   · выбранные услуги — только одобренные услуги этой витрины, опции — только этих услуг,
//     количество — не меньше минимального у услуги. Названия и цены сохраняются в заявке
//     как есть сейчас: вендор мог их потом поменять, а заявка — о том, что видел клиент;
//   · часть дня (режим parts) — из времени начала (dayPartOf по окнам категории);
//   · срок подготовки — поле витрины lead_days и срок выбранных услуг: заказ позже —
//     422 lead_time_too_short.
// Свободного текста в details нет — всё, что клиент пишет словами, в комментарии (ПДн,
// по согласию). Ошибки полей — 400 invalid_request, как у остальных полей заявки.

import type { DayPart } from "@bayramm/shared/api";
import {
  type CategoryConfig,
  type ChosenServiceSnapshot,
  categoryConfig,
  type DetailValue,
  dayPartOf,
  guestsAllowed,
  hasDayParts,
  type RequestDetails,
  validateRequestDetails,
} from "@bayramm/shared/categories";
import type { Tx } from "../db/actor";
import type { Json } from "../db/schema.generated";
import { ApiError } from "../errors";
import { type ServiceRow, selectServices, serviceView } from "../listing-services/store";
import { addDays } from "../time";

export interface DetailsListing {
  readonly id: string;
  readonly category_code: string;
  readonly attributes: Json;
}

export interface CheckedDetails {
  readonly guests: number | null;
  readonly details: RequestDetails;
  readonly dayPart: DayPart | null;
}

const invalidRequest = (fields: string[]) =>
  new ApiError(400, "invalid_request", "Invalid request body", [...new Set(fields)]);

/** Срок подготовки витрины (поле lead_days), если он есть и это число */
function listingLeadDays(attributes: Json): number {
  if (typeof attributes !== "object" || attributes === null || Array.isArray(attributes)) return 0;
  const value = attributes.lead_days;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export async function checkDetails(
  trx: Tx,
  listing: DetailsListing,
  input: { readonly guests: number | null; readonly details: unknown; readonly eventDate: string },
  today: string,
): Promise<CheckedDetails> {
  const category: CategoryConfig | undefined = categoryConfig(listing.category_code);
  if (category === undefined) throw invalidRequest(["listingId"]);

  const bad: string[] = [];
  if (!guestsAllowed(category, input.guests)) bad.push("guests");
  const parsed = validateRequestDetails(category, input.details);
  if (!parsed.ok) bad.push(...parsed.errors);
  if (bad.length > 0 || !parsed.ok) throw invalidRequest(bad);
  const { values, services: choices } = parsed.value;

  // Районы — из справочника
  const districtFields = category.requestForm.fields.filter((f) => f.type === "district" && f.key in values);
  if (districtFields.length > 0) {
    const codes = districtFields.map((f) => values[f.key] as string);
    const known = await trx.selectFrom("app.districts").select("code").where("code", "in", codes).execute();
    const found = new Set(known.map((d) => d.code));
    for (const field of districtFields) {
      if (!found.has(values[field.key] as string)) bad.push(`details.${field.key}`);
    }
  }

  // Выбранные услуги — одобренные услуги этой витрины
  const snapshots: ChosenServiceSnapshot[] = [];
  let leadDays = listingLeadDays(listing.attributes);
  if (choices.length > 0) {
    const rows = await selectServices(trx)
      .where("s.listing_id", "=", listing.id)
      .where("s.status", "=", "active")
      .where(
        "s.id",
        "in",
        choices.map((c) => c.id),
      )
      .execute();
    const byId = new Map(rows.map((row) => [row.id, row as ServiceRow]));
    choices.forEach((choice, index) => {
      const at = `details.services.${index}`;
      const row = byId.get(choice.id);
      if (row === undefined) {
        bad.push(`${at}.id`);
        return;
      }
      const service = serviceView(row);
      if (choice.qty !== null && service.minQty !== null && choice.qty < service.minQty)
        bad.push(`${at}.qty`);
      const options = choice.options.map((id) => service.options.find((o) => o.id === id));
      if (options.some((o) => o === undefined)) {
        bad.push(`${at}.options`);
        return;
      }
      leadDays = Math.max(leadDays, service.leadDays ?? 0);
      snapshots.push({
        id: service.id,
        type: service.type,
        name: service.name,
        priceUzs: service.priceUzs,
        priceUnit: service.priceUnit,
        qty: choice.qty,
        options: options.flatMap((o) =>
          o === undefined ? [] : [{ id: o.id, name: o.name, priceUzs: o.priceUzs, priceUnit: o.priceUnit }],
        ),
      });
    });
  }
  if (bad.length > 0) throw invalidRequest(bad);

  // Заказ не позже срока подготовки витрины и выбранных услуг
  if (leadDays > 0 && input.eventDate < addDays(today, leadDays)) {
    throw new ApiError(422, "lead_time_too_short", "Event date is earlier than the preparation time", [
      "eventDate",
    ]);
  }

  const details: Record<string, DetailValue | readonly ChosenServiceSnapshot[]> = { ...values };
  const servicesField = category.requestForm.fields.find((f) => f.type === "services");
  if (servicesField !== undefined && snapshots.length > 0) details[servicesField.key] = snapshots;

  // Часть дня — из времени начала (у режима parts оно в форме обязательно)
  let dayPart: DayPart | null = null;
  if (hasDayParts(category)) {
    const start = values.start_time;
    if (typeof start !== "string") throw invalidRequest(["details.start_time"]);
    dayPart = dayPartOf(category, start);
  }
  return { guests: input.guests, details, dayPart };
}
