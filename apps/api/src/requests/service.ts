// Заявки клиента: подать, «Мои заявки», отозвать. Всё — под актором клиента:
// RLS отдаёт только свои заявки, чужая для клиента не существует (404, не 403).
//
// Подача — одна транзакция:
//   1. листинг опубликован (иначе 404), активной заявки на этот листинг и дату
//      ещё нет (иначе 409 duplicate_request с existingId), повод из справочника;
//   2. тексты согласий: request_transfer обязателен, bot_notifications — если
//      клиент отдельно отметил уведомления;
//   3. согласие request_transfer на этот листинг (и bot_notifications) — в
//      журнал app.consents: что, когда, версия текста, откуда;
//   4. поля категории: число гостей по форме, details, выбранные услуги и часть дня
//      (requests/details.ts);
//   5. заявка и контакты (request_contacts, db/pii). Листинг, блокировку, согласие,
//      вместимость, часть дня и лимит заявок проверяют триггеры базы.
// Уведомление вендору ставит в очередь база (триггер на вставку заявки), не API.

import type { ClientRequest, ClientSource, RequestCreated } from "@bayramm/shared/api";
import type { RequestDetails } from "@bayramm/shared/categories";
import { sql } from "kysely";
import { type ClientActor, type Tx, withActor } from "../db/actor";
import type { Db } from "../db/client";
import { insertRequestContact } from "../db/pii";
import { ApiError, isPgError, notFound } from "../errors";
import { tashkentToday } from "../time";
import { checkDetails } from "./details";
import { type CreateRequestInput, consentRequired } from "./input";

/** «Мои заявки» — последние столько */
export const CLIENT_REQUESTS_LIMIT = 100;

const DUPLICATE_CONSTRAINT = "requests_client_listing_date_uq";

export const duplicateRequest = (existingId: string) =>
  new ApiError(409, "duplicate_request", "Request for this listing and date already exists", undefined, {
    existingId,
  });

// Активная (не отозванная) заявка клиента на листинг и дату — как в requests_client_listing_date_uq
async function findDuplicate(trx: Tx, clientId: string, listingId: string, eventDate: string) {
  return trx
    .selectFrom("app.requests")
    .select("id")
    .where("client_id", "=", clientId)
    .where("listing_id", "=", listingId)
    .where("event_date", "=", eventDate)
    .where("status", "<>", "withdrawn")
    .executeTakeFirst();
}

/** POST /requests */
export async function createRequest(
  db: Db,
  actor: ClientActor,
  input: CreateRequestInput,
  source: ClientSource,
  today: string = tashkentToday(),
): Promise<RequestCreated> {
  try {
    return await withActor(db, actor, (trx) => insertRequest(trx, actor, input, source, today));
  } catch (err) {
    // Параллельная заявка на ту же дату успела раньше: транзакция откатилась,
    // id победившей ищем уже в новой
    if (isPgError(err) && err.code === "23505" && err.constraint === DUPLICATE_CONSTRAINT) {
      const existing = await withActor(db, actor, (trx) =>
        findDuplicate(trx, actor.id, input.listingId, input.eventDate),
      );
      if (existing !== undefined) throw duplicateRequest(existing.id);
    }
    throw err;
  }
}

async function insertRequest(
  trx: Tx,
  actor: ClientActor,
  input: CreateRequestInput,
  source: ClientSource,
  today: string,
): Promise<RequestCreated> {
  const listing = await trx
    .selectFrom("app.listings")
    .select(["id", "vendor_id", "category_code", "attributes"])
    .where("id", "=", input.listingId)
    .where("status", "=", "active")
    .executeTakeFirst();
  if (listing === undefined) throw notFound();

  const duplicate = await findDuplicate(trx, actor.id, listing.id, input.eventDate);
  if (duplicate !== undefined) throw duplicateRequest(duplicate.id);

  const occasion = await trx
    .selectFrom("app.occasions")
    .select("code")
    .where("code", "=", input.occasionCode)
    .executeTakeFirst();
  if (occasion === undefined) {
    throw new ApiError(400, "invalid_request", "Unknown occasion", ["occasionCode"]);
  }

  const checked = await checkDetails(trx, listing, input, today);

  // Текст той цели, о которой спрашивали. Действует ли он ещё — проверяет
  // триггер согласий (consent_text_not_current)
  const textIds = [input.requestTransferConsentId, input.notifyConsentId].filter((id) => id !== null);
  const texts = await trx
    .selectFrom("app.consent_texts")
    .select(["id", "purpose"])
    .where("id", "in", textIds)
    .execute();
  const purposeOf = (id: string) => texts.find((t) => t.id === id)?.purpose;
  if (purposeOf(input.requestTransferConsentId) !== "request_transfer") {
    throw consentRequired("requestTransferConsentId");
  }
  if (input.notifyConsentId !== null && purposeOf(input.notifyConsentId) !== "bot_notifications") {
    throw consentRequired("notifyConsentId");
  }

  const consent = await trx
    .insertInto("app.consents")
    .values({
      subject_kind: "client",
      subject_id: actor.id,
      purpose: "request_transfer",
      action: "grant",
      text_id: input.requestTransferConsentId,
      scope_listing_id: listing.id,
      source,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  if (input.notifyConsentId !== null) {
    await trx
      .insertInto("app.consents")
      .values({
        subject_kind: "client",
        subject_id: actor.id,
        purpose: "bot_notifications",
        action: "grant",
        text_id: input.notifyConsentId,
        source,
      })
      .execute();
  }

  const request = await trx
    .insertInto("app.requests")
    .values({
      client_id: actor.id,
      listing_id: listing.id,
      // vendor_id и sla_due_at выставляет requests_before_insert (из листинга и
      // settings.sla_hours); здесь — только чтобы запрос был полным
      vendor_id: listing.vendor_id,
      sla_due_at: sql<Date>`now()`,
      consent_id: consent.id,
      occasion_code: input.occasionCode,
      event_date: input.eventDate,
      guests: checked.guests,
      details: JSON.stringify(checked.details),
      day_part: checked.dayPart,
      budget_min_uzs: input.budgetMinUzs,
      budget_max_uzs: input.budgetMaxUzs,
      source,
    })
    .returning(["id", "public_no", "status", "sla_due_at"])
    .executeTakeFirstOrThrow();

  await insertRequestContact(trx, {
    request_id: request.id,
    contact_name: input.contactName,
    contact_phone: input.contactPhone,
    comment: input.comment,
  });

  return {
    id: request.id,
    publicNo: Number(request.public_no),
    status: request.status,
    slaDueAt: request.sla_due_at.toISOString(),
  } satisfies RequestCreated;
}

// ── «Мои заявки» ───────────────────────────────────────────────────────────

// Срок ответа прошёл, а вендор не ответил: клиенту предлагаются похожие
const SLA_BREACHED = sql<boolean>`(r.status in ('new', 'viewed') and r.first_response_at is null and r.sla_due_at <= now())`;

// Заявки клиента с листингом и его обложкой. Листинг клиенту виден и после
// снятия с публикации (RLS: есть его заявка); фото — только публичные
function clientRequests(trx: Tx, clientId: string) {
  return trx
    .selectFrom("app.requests as r")
    .innerJoin("app.listings as l", "l.id", "r.listing_id")
    .leftJoinLateral(
      (eb) =>
        eb
          .selectFrom("app.photos as p")
          .select(["p.storage_key", "p.width", "p.height"])
          .whereRef("p.listing_id", "=", "l.id")
          .where("p.deleted_at", "is", null)
          .where("p.status", "=", "ready")
          .where("p.moderation", "=", "approved")
          .orderBy("p.is_cover", "desc")
          .orderBy("p.sort")
          .orderBy("p.created_at")
          .orderBy("p.id")
          .limit(1)
          .as("cv"),
      (j) => j.onTrue(),
    )
    .select([
      "r.id",
      "r.public_no",
      "r.status",
      "r.decline_reason",
      "r.event_date",
      "r.guests",
      "r.day_part",
      "r.details",
      "r.occasion_code",
      "r.created_at",
      "r.sla_due_at",
      "r.first_response_at",
      SLA_BREACHED.as("sla_breached"),
      "l.id as listing_id",
      "l.slug",
      "l.name",
      "l.district_code",
      "l.category_code",
      "cv.storage_key as cover_key",
      "cv.width as cover_width",
      "cv.height as cover_height",
    ])
    .where("r.client_id", "=", clientId);
}

type ClientRequestRow = Awaited<ReturnType<ReturnType<typeof clientRequests>["executeTakeFirstOrThrow"]>>;

function toClientRequest(row: ClientRequestRow): ClientRequest {
  const cover =
    row.cover_key !== null && row.cover_width !== null && row.cover_height !== null
      ? { key: row.cover_key, width: row.cover_width, height: row.cover_height }
      : null;
  return {
    id: row.id,
    publicNo: Number(row.public_no),
    status: row.status,
    declineReason: row.decline_reason,
    eventDate: row.event_date,
    guests: row.guests,
    dayPart: row.day_part,
    details: row.details as RequestDetails,
    occasionCode: row.occasion_code,
    createdAt: row.created_at.toISOString(),
    slaDueAt: row.sla_due_at.toISOString(),
    firstResponseAt: row.first_response_at?.toISOString() ?? null,
    slaBreached: row.sla_breached,
    listing: {
      id: row.listing_id,
      slug: row.slug,
      name: row.name,
      cover,
      districtCode: row.district_code,
      categoryCode: row.category_code,
    },
  } satisfies ClientRequest;
}

/** GET /requests — свои заявки, новые сверху */
export async function listClientRequests(db: Db, actor: ClientActor): Promise<ClientRequest[]> {
  const rows = await withActor(db, actor, (trx) =>
    clientRequests(trx, actor.id)
      .orderBy("r.created_at", "desc")
      .orderBy("r.id", "desc")
      .limit(CLIENT_REQUESTS_LIMIT)
      .execute(),
  );
  return rows.map(toClientRequest);
}

/**
 * POST /requests/:id/withdraw. Чужая или несуществующая — 404 (RLS её не
 * покажет); уже отозванная — как есть; из итогового статуса — 409 от триггера
 * переходов (illegal_transition). Источник пишется в журнал статусов.
 */
export async function withdrawRequest(
  db: Db,
  actor: ClientActor,
  requestId: string,
  source: ClientSource,
): Promise<ClientRequest> {
  return withActor(db, actor, async (trx) => {
    const current = await trx
      .selectFrom("app.requests")
      .select(["id", "status"])
      .where("id", "=", requestId)
      .where("client_id", "=", actor.id)
      .forUpdate()
      .executeTakeFirst();
    if (current === undefined) throw notFound();

    if (current.status !== "withdrawn") {
      // Источник смены статуса для request_status_log (иначе у клиента — tma)
      await sql`select set_config('app.source', ${source}, true)`.execute(trx);
      await trx
        .updateTable("app.requests")
        .set({ status: "withdrawn" })
        .where("id", "=", current.id)
        .execute();
    }
    const row = await clientRequests(trx, actor.id).where("r.id", "=", current.id).executeTakeFirst();
    if (row === undefined) throw notFound();
    return toClientRequest(row);
  });
}
