// Правки карточки из кабинета: партнёр предлагает новое название, описания, поля витрины
// и ссылки на видео — карточку меняет только решение команды (staff/revisions.ts); цены —
// в услугах (vendor/services.ts). Клиент видит одобренную версию, пока правка ждёт. Поля
// витрины проверяются по конфигурации категории витрины.
//
//   · одна открытая правка на площадку (индекс listing_revisions_one_pending): вторая —
//     409 revision_pending, открытую можно отозвать;
//   · в правку попадают только поля, которые отличаются от карточки: команде видно,
//     что именно меняется; ничего не изменилось — 422 no_changes;
//   · проверка полей — та же, что при решении (revisionFromBody): правка, которая её
//     не прошла бы, сюда не попадает;
//   · кто подал и когда, ставит триггер listing_revisions_guard, оповещение команде
//     (ops.revision_submitted, без ПДн) — триггер listing_revisions_notify;
//   · подать и отозвать может только владелец кабинета (vendor/access.ts, в базе —
//     app.edits_listing). Правку опубликованной карточки предлагает и менеджер Bayramm
//     (staff/listings.ts): её партнёр видит с отметкой byTeam и не отзывает.
//
// Чужая площадка или правка — 404 (RLS и явная проверка вендора).

import type { ListingRevisionPayload, VendorRevision, VendorRevisionList } from "@bayramm/shared/api/vendor";
import { REVISION_KEYS } from "@bayramm/shared/api/vendor";
import { sql } from "kysely";
import { type Tx, type VendorActor, withActor } from "../db/actor";
import type { Db } from "../db/client";
import type { Json } from "../db/schema.generated";
import { ApiError, notFound } from "../errors";
import type { Body } from "../staff/input";
import { changedOnly } from "../staff/revision-diff";
import { revisionFromBody } from "../staff/revisions";
import { assertVendorCan } from "./access";

/** Сколько последних предложений показывать партнёру */
const HISTORY = 10;

const noChanges = () => new ApiError(422, "no_changes", "Proposal does not change the listing");

interface RevisionRow {
  readonly id: string;
  readonly status: VendorRevision["status"];
  readonly payload: Json;
  readonly submitted_at: Date;
  readonly decided_at: Date | null;
  readonly decision_reason: string | null;
  readonly by_team: boolean;
}

// Предложил не партнёр (менеджер из панели): submitted_by — не пользователь вендора
const byTeam = sql<boolean>`not exists (select 1 from app.vendor_users u
  where u.id = app.listing_revisions.submitted_by)`.as("by_team");

const COLUMNS = ["id", "status", "payload", "submitted_at", "decided_at", "decision_reason", byTeam] as const;

/** Сохранённый payload глазами партнёра: только известные ключи */
function payloadView(payload: Json): ListingRevisionPayload {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return {};
  const known: Record<string, unknown> = {};
  for (const key of REVISION_KEYS) if (Object.hasOwn(payload, key)) known[key] = payload[key];
  return known as ListingRevisionPayload;
}

function view(row: RevisionRow): VendorRevision {
  return {
    id: row.id,
    status: row.status,
    submittedAt: row.submitted_at.toISOString(),
    decidedAt: row.decided_at?.toISOString() ?? null,
    // Причину сотрудник пишет для партнёра; у остальных решений её нет
    decisionReason: row.status === "declined" ? row.decision_reason : null,
    payload: payloadView(row.payload),
    byTeam: row.by_team,
  };
}

/**
 * Своя площадка или 404. version — база правки: если карточку потом изменят, команда
 * увидит, что правка считалась от старой версии
 */
async function ownListing(trx: Tx, actor: VendorActor, listingId: string) {
  const listing = await trx
    .selectFrom("app.listings")
    .select([
      "id",
      "version",
      "category_code",
      "name",
      "description_ru",
      "description_uz",
      "attributes",
      "video_links",
    ])
    .where("id", "=", listingId)
    .where("vendor_id", "=", actor.vendorId)
    .executeTakeFirst();
  if (listing === undefined) throw notFound();
  return listing;
}

/** GET /vendor/listings/:id/revisions: последние предложения по своей площадке, новые первыми */
export function listRevisions(db: Db, actor: VendorActor, listingId: string): Promise<VendorRevisionList> {
  return withActor(db, actor, async (trx) => {
    await ownListing(trx, actor, listingId);
    const rows = await trx
      .selectFrom("app.listing_revisions")
      .select(COLUMNS)
      .where("listing_id", "=", listingId)
      .orderBy("submitted_at", "desc")
      .orderBy("id")
      .limit(HISTORY)
      .execute();
    return { items: rows.map(view) };
  });
}

/** POST /vendor/listings/:id/revisions: предложить правку карточки */
export function submitRevision(
  db: Db,
  actor: VendorActor,
  listingId: string,
  body: unknown,
): Promise<VendorRevision> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError(400, "invalid_request", "Body must be a JSON object");
  }
  assertVendorCan(actor, "card.propose");
  return withActor(db, actor, async (trx) => {
    const listing = await ownListing(trx, actor, listingId);
    const values = revisionFromBody(body as Body, listing.category_code);
    const payload = changedOnly(values, listing);
    if (Object.keys(payload).length === 0) throw noChanges();
    const row = await trx
      .insertInto("app.listing_revisions")
      .values({ listing_id: listingId, payload: payload as Json, base_version: listing.version })
      .returning(COLUMNS)
      .executeTakeFirstOrThrow();
    return view(row);
  });
}

/** POST /vendor/listings/:id/revisions/:revisionId/withdraw: отозвать открытое предложение */
export function withdrawRevision(
  db: Db,
  actor: VendorActor,
  listingId: string,
  revisionId: string,
): Promise<VendorRevision> {
  assertVendorCan(actor, "card.propose");
  return withActor(db, actor, async (trx) => {
    await ownListing(trx, actor, listingId);
    const current = await trx
      .selectFrom("app.listing_revisions")
      .select(["status", byTeam])
      .where("id", "=", revisionId)
      .where("listing_id", "=", listingId)
      .forUpdate()
      .executeTakeFirst();
    if (current === undefined) throw notFound();
    if (current.status !== "pending") {
      throw new ApiError(409, "illegal_transition", "Proposal is already decided");
    }
    // Предложение команды партнёр не отзывает — решает модератор (listing_revisions_guard)
    if (current.by_team) throw new ApiError(403, "forbidden_for_actor", "Proposal was made by the team");
    const row = await trx
      .updateTable("app.listing_revisions")
      .set({ status: "withdrawn" })
      .where("id", "=", revisionId)
      .returning(COLUMNS)
      .executeTakeFirstOrThrow();
    return view(row);
  });
}
