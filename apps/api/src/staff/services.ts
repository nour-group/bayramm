// Услуги витрин в панели оператора. Контракт — @bayramm/shared/api/staff (ServiceInput,
// ListingService, ServiceQueue), правила — listing-services/store.ts и база.
//
//   GET    /staff/listings/:id/services                     услуги витрины
//   POST   /staff/listings/:id/services                     новая услуга
//   PATCH  /staff/listings/:id/services/:sid                правка (менеджер у активной услуги
//                                                           опубликованной витрины — предложением)
//   POST   /staff/listings/:id/services/:sid/pause | resume снять с витрины / вернуть
//   DELETE /staff/listings/:id/services/:sid
//
//   GET    /staff/services?status=pending|review|proposal&limit=&offset=   очередь модерации
//   POST   /staff/services/:sid/approve                     одобрить услугу или предложение
//   POST   /staff/services/:sid/decline { reason }          отклонить (причину увидит партнёр)
//
//   POST   /staff/vendors/:id/listings { categoryCode, name?, slug? }   новая витрина вендору
//
// Решает по модерации тот, у кого revisions.moderate (администратор, модератор): его
// услуги сразу одобрены. Менеджер заводит услуги на проверку (у неопубликованной
// витрины их одобрит публикация). Решение по услуге опубликованной витрины —
// уведомление владельцам кабинета (триггер базы listing_services_notify).

import type { ServiceQueue, ServiceQueueItem, ServiceQueueKind } from "@bayramm/shared/api/staff";
import { Hono } from "hono";
import { sql } from "kysely";
import { staffOf } from "../auth/session";
import { type StaffActor, type Tx, withActor } from "../db/actor";
import { staffName } from "../db/pii";
import type { AppEnv } from "../env";
import { notFound } from "../errors";
import {
  approveService,
  createService,
  declineService,
  deleteService,
  listServices,
  pauseService,
  SERVICE_COLUMNS,
  type ServiceListing,
  type ServiceRow,
  serviceView,
  submitService,
  updateService,
} from "../listing-services/store";
import { outboxKick } from "../notify/kick";
import { requirePermission } from "./access";
import { Input, invalidInput, limitJson, paging, readBody } from "./input";
import { loadListing, staffServiceActor } from "./listings";
import { iso, pathId } from "./shared";
import { pickSlug } from "./slug";

/** Маршруты услуг под /staff/listings */
export const listingServices = new Hono<AppEnv>();
/** Очередь модерации услуг: /staff/services */
export const serviceModeration = new Hono<AppEnv>();
/** Витрины вендора: /staff/vendors/:id/listings */
export const vendorListings = new Hono<AppEnv>();

async function serviceListing(trx: Tx, listingId: string): Promise<ServiceListing> {
  const listing = await trx
    .selectFrom("app.listings")
    .select(["id", "category_code", "status"])
    .where("id", "=", listingId)
    .executeTakeFirst();
  if (listing === undefined) throw notFound();
  return listing;
}

function actorFor(actor: StaffActor, listing: ServiceListing) {
  return staffServiceActor(actor.role, listing.status);
}

// ── услуги витрины ──────────────────────────────────────────────────────────

listingServices.get("/:id/services", requirePermission("catalog.read"), async (c) => {
  const id = pathId(c.req.param("id"));
  const items = await withActor(c.var.db, staffOf(c), async (trx) => {
    await serviceListing(trx, id);
    return listServices(trx, id);
  });
  return c.json({ items });
});

listingServices.post(
  "/:id/services",
  requirePermission("listings.write"),
  limitJson,
  outboxKick,
  async (c) => {
    const id = pathId(c.req.param("id"));
    const body = await readBody(c.req.raw);
    const actor = staffOf(c);
    const service = await withActor(c.var.db, actor, async (trx) => {
      const listing = await serviceListing(trx, id);
      return createService(trx, listing, body, actorFor(actor, listing));
    });
    return c.json(service, 201);
  },
);

listingServices.patch(
  "/:id/services/:sid",
  requirePermission("listings.write"),
  limitJson,
  outboxKick,
  async (c) => {
    const id = pathId(c.req.param("id"));
    const sid = pathId(c.req.param("sid"));
    const body = await readBody(c.req.raw);
    const actor = staffOf(c);
    const service = await withActor(c.var.db, actor, async (trx) => {
      const listing = await serviceListing(trx, id);
      return updateService(trx, listing, sid, body, actorFor(actor, listing));
    });
    return c.json(service);
  },
);

listingServices.post("/:id/services/:sid/pause", requirePermission("listings.write"), async (c) => {
  const id = pathId(c.req.param("id"));
  const sid = pathId(c.req.param("sid"));
  const service = await withActor(c.var.db, staffOf(c), async (trx) =>
    pauseService(trx, await serviceListing(trx, id), sid),
  );
  return c.json(service);
});

listingServices.post(
  "/:id/services/:sid/resume",
  requirePermission("listings.write"),
  outboxKick,
  async (c) => {
    const id = pathId(c.req.param("id"));
    const sid = pathId(c.req.param("sid"));
    const actor = staffOf(c);
    const service = await withActor(c.var.db, actor, async (trx) => {
      const listing = await serviceListing(trx, id);
      return submitService(trx, listing, sid, actorFor(actor, listing));
    });
    return c.json(service);
  },
);

listingServices.delete("/:id/services/:sid", requirePermission("listings.write"), async (c) => {
  const id = pathId(c.req.param("id"));
  const sid = pathId(c.req.param("sid"));
  await withActor(c.var.db, staffOf(c), async (trx) =>
    deleteService(trx, await serviceListing(trx, id), sid),
  );
  return c.body(null, 204);
});

// ── очередь модерации ───────────────────────────────────────────────────────

const QUEUE_FILTERS = ["pending", "review", "proposal"] as const;

serviceModeration.get("/", requirePermission("revisions.moderate"), async (c) => {
  const filter = QUEUE_FILTERS.find((f) => f === c.req.query("status")) ?? "pending";
  const { limit, offset } = paging((key) => c.req.query(key));
  const body: ServiceQueue = await withActor(c.var.db, staffOf(c), async (trx) => {
    const rows = await trx
      .selectFrom("app.listing_services as s")
      .innerJoin("app.listings as l", "l.id", "s.listing_id")
      .innerJoin("app.vendor_accounts as v", "v.id", "l.vendor_id")
      .select(SERVICE_COLUMNS)
      .select([
        "l.name as listing_name",
        "l.status as listing_status",
        "l.category_code as listing_category",
        "v.id as vendor_id",
        "v.public_code",
        "v.name as vendor_name",
        sql<boolean>`exists (select 1 from app.staff st where st.id = coalesce(s.proposal_by, s.submitted_by))`.as(
          "by_staff",
        ),
        staffName("s.proposal_by").as("proposal_staff"),
        staffName("s.submitted_by").as("submitted_staff"),
        sql<Date>`coalesce(s.proposal_at, s.submitted_at, s.updated_at)`.as("queued_at"),
        sql<number>`(count(*) over ())::int`.as("total"),
      ])
      // Неопубликованную витрину решают вместе с карточкой — публикацией
      .where("l.status", "in", ["active", "suspended"])
      .$if(filter === "pending", (qb) =>
        qb.where((eb) => eb.or([eb("s.status", "=", "review"), eb("s.proposal", "is not", null)])),
      )
      .$if(filter === "review", (qb) => qb.where("s.status", "=", "review"))
      .$if(filter === "proposal", (qb) => qb.where("s.proposal", "is not", null))
      .orderBy(sql`coalesce(s.proposal_at, s.submitted_at, s.updated_at)`, "asc")
      .orderBy("s.id")
      .limit(limit)
      .offset(offset)
      .execute();
    return {
      total: rows[0]?.total ?? 0,
      items: rows.map((row): ServiceQueueItem => {
        const kind: ServiceQueueKind = row.proposal !== null ? "proposal" : "review";
        return {
          kind,
          service: serviceView(row as unknown as ServiceRow),
          listing: {
            id: row.listing_id,
            name: row.listing_name,
            status: row.listing_status,
            categoryCode: row.listing_category,
          },
          vendor: { id: row.vendor_id, code: row.public_code, name: row.vendor_name },
          proposedBy: row.by_staff
            ? { kind: "staff", name: kind === "proposal" ? row.proposal_staff : row.submitted_staff }
            : { kind: "partner", name: null },
          submittedAt: iso(row.queued_at),
        };
      }),
    };
  });
  return c.json(body);
});

async function serviceOf(trx: Tx, sid: string): Promise<ServiceListing> {
  const row = await trx
    .selectFrom("app.listing_services as s")
    .innerJoin("app.listings as l", "l.id", "s.listing_id")
    .select(["l.id", "l.category_code", "l.status"])
    .where("s.id", "=", sid)
    .executeTakeFirst();
  if (row === undefined) throw notFound();
  return row;
}

serviceModeration.post("/:sid/approve", requirePermission("revisions.moderate"), outboxKick, async (c) => {
  const sid = pathId(c.req.param("sid"));
  const service = await withActor(c.var.db, staffOf(c), async (trx) =>
    approveService(trx, await serviceOf(trx, sid), sid),
  );
  return c.json(service);
});

serviceModeration.post(
  "/:sid/decline",
  requirePermission("revisions.moderate"),
  limitJson,
  outboxKick,
  async (c) => {
    const sid = pathId(c.req.param("sid"));
    const input = new Input(await readBody(c.req.raw));
    const reason = input.text("reason", { max: 1000, required: true, multiline: true });
    input.done();
    if (typeof reason !== "string") throw invalidInput(["reason"]);
    const service = await withActor(c.var.db, staffOf(c), async (trx) =>
      declineService(trx, await serviceOf(trx, sid), sid, reason),
    );
    return c.json(service);
  },
);

// ── витрина вендору в другой категории ──────────────────────────────────────

vendorListings.post("/:id/listings", requirePermission("listings.write"), limitJson, async (c) => {
  const vendorId = pathId(c.req.param("id"));
  const input = new Input(await readBody(c.req.raw));
  const categoryCode = input.pattern("categoryCode", /^[a-z_]{2,20}$/, true);
  const name = input.text("name", { min: 2, max: 80 });
  const slug = input.pattern("slug", /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/);
  input.done();
  if (typeof categoryCode !== "string") throw invalidInput(["categoryCode"]);
  const listing = await withActor(c.var.db, staffOf(c), async (trx) => {
    const vendor = await trx
      .selectFrom("app.vendor_accounts")
      .select(["id", "name"])
      .where("id", "=", vendorId)
      .executeTakeFirst();
    if (vendor === undefined) throw notFound();
    const title = name ?? vendor.name ?? vendor.id.slice(0, 8);
    const address = slug ?? (await pickSlug(trx, title));
    const { rows } = await sql<{ id: string }>`
      select app.staff_add_listing(${vendorId}::uuid, ${categoryCode}, ${title}, ${address}) as id
    `.execute(trx);
    const id = rows[0]?.id;
    if (id === undefined) throw notFound();
    return loadListing(trx, id);
  });
  return c.json(listing, 201);
});
