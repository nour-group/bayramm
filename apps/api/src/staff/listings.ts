// Карточки (листинги) в панели оператора. Контракт — @bayramm/shared/api/staff.
//
//   GET   /staff/listings?status=&q=&vendorId=&limit=&offset=   список, очередь проверки
//   POST  /staff/listings                                       создать (vendorId, name)
//   GET   /staff/listings/:id                                   карточка целиком
//   PATCH /staff/listings/:id                                   правка (version обязателен)
//   POST  /staff/listings/:id/submit | publish | suspend | reject | draft   { version, reason? }
//   POST  /staff/listings/:id/phone  { reason? }                телефон для заявок (в журнал)
//
// Жизненный цикл и правила публикации — в базе (listings_before_update,
// app.listing_publish_blockers): API только выбирает шаги и переводит ошибки.
// Оптимистичная блокировка — по version: правка и действие проходят, только если
// карточку с тех пор не меняли (триггер увеличивает version на каждом UPDATE).

import type {
  ListingAction,
  ListingDetail,
  ListingList,
  ListingStatus,
  PriceUnit,
  StaffListingPackage,
  StaffPermission,
  StaffPhoto,
} from "@bayramm/shared/api/staff";
import { Hono } from "hono";
import { sql } from "kysely";
import { staffOf } from "../auth/session";
import { type Tx, withActor } from "../db/actor";
import { hasListingPhone, readListingPhone, saveListingPhone, staffName } from "../db/pii";
import type { AppEnv } from "../env";
import { ApiError, notFound, versionConflict } from "../errors";
import { requirePermission } from "./access";
import { Input, invalidInput, likePattern, limitJson, paging, readBody } from "./input";
import { blockers, iso, LISTING_STATUSES, num, pathId } from "./shared";
import { freeSlug, SLUG_RE, slugify } from "./slug";
import { definedOnly, readReason } from "./vendors";

export const listings = new Hono<AppEnv>();

export const PRICE_UNITS = ["per_guest", "per_event"] as const satisfies readonly PriceUnit[];
export const PACKAGE_KINDS = ["weekday", "weekend", "custom"] as const;
export const MAX_PRICE = 99_999_999_999;
export const MAX_PACKAGES = 10;

// ── чтение ──────────────────────────────────────────────────────────────────

export async function loadPhotos(trx: Tx, listingId: string): Promise<StaffPhoto[]> {
  const rows = await trx
    .selectFrom("app.photos")
    .select(["id", "storage_key", "width", "height", "bytes", "sort", "is_cover", "moderation", "created_at"])
    .where("listing_id", "=", listingId)
    .where("deleted_at", "is", null)
    .where("status", "=", "ready")
    .orderBy("sort")
    .orderBy("created_at")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    key: row.storage_key,
    width: row.width ?? 0,
    height: row.height ?? 0,
    bytes: row.bytes ?? 0,
    sort: row.sort,
    isCover: row.is_cover,
    moderation: row.moderation === "withdrawn" ? "declined" : row.moderation,
    createdAt: iso(row.created_at),
  }));
}

export async function loadListing(trx: Tx, id: string): Promise<ListingDetail> {
  const row = await trx
    .selectFrom("app.listings as l")
    .innerJoin("app.vendor_accounts as v", "v.id", "l.vendor_id")
    .select([
      "l.id",
      "l.slug",
      "l.category_code",
      "l.status",
      "l.status_reason",
      "l.status_changed_at",
      "l.name",
      "l.district_code",
      "l.address_ru",
      "l.address_uz",
      "l.description_ru",
      "l.description_uz",
      "l.price_from_uzs",
      "l.price_unit",
      "l.cap_min",
      "l.cap_max",
      "l.submitted_at",
      "l.published_at",
      "l.version",
      "l.created_at",
      "l.updated_at",
      "v.id as vendor_id",
      "v.public_code",
      "v.name as vendor_name",
      hasListingPhone("l.id").as("has_phone"),
      blockers("l.id", "review").as("blockers_review"),
      blockers("l.id", "active").as("blockers_active"),
    ])
    .where("l.id", "=", id)
    .executeTakeFirst();
  if (row === undefined) throw notFound();

  const packages = await trx
    .selectFrom("app.listing_packages")
    .select(["kind", "name_ru", "name_uz", "price_uzs", "price_unit"])
    .where("listing_id", "=", id)
    .orderBy("sort")
    .orderBy("created_at")
    .execute();

  const history = await trx
    .selectFrom("app.listing_status_log as h")
    .select([
      "h.from_status",
      "h.to_status",
      "h.reason",
      "h.actor_kind",
      "h.at",
      sql<string | null>`case when h.actor_kind = 'staff' then ${staffName("h.actor_id")} end`.as(
        "actor_name",
      ),
    ])
    .where("h.listing_id", "=", id)
    .orderBy("h.at", "desc")
    .orderBy("h.id", "desc")
    .limit(50)
    .execute();

  return {
    id: row.id,
    slug: row.slug,
    categoryCode: row.category_code,
    status: row.status,
    statusReason: row.status_reason,
    statusChangedAt: iso(row.status_changed_at),
    name: row.name,
    districtCode: row.district_code,
    addressRu: row.address_ru,
    addressUz: row.address_uz,
    descriptionRu: row.description_ru,
    descriptionUz: row.description_uz,
    priceFromUzs: num(row.price_from_uzs),
    priceUnit: row.price_unit,
    capMin: row.cap_min,
    capMax: row.cap_max,
    submittedAt: iso(row.submitted_at),
    publishedAt: iso(row.published_at),
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    hasPhone: row.has_phone,
    packages: packages.map((p) => ({
      kind: p.kind,
      nameRu: p.name_ru,
      nameUz: p.name_uz,
      priceUzs: num(p.price_uzs),
      priceUnit: p.price_unit,
    })),
    photos: await loadPhotos(trx, id),
    blockers: { review: row.blockers_review, active: row.blockers_active },
    vendor: { id: row.vendor_id, code: row.public_code, name: row.vendor_name },
    history: history.map((h) => ({
      from: h.from_status,
      to: h.to_status,
      reason: h.reason,
      actorKind: h.actor_kind,
      actorName: h.actor_name,
      at: iso(h.at),
    })),
  };
}

// ── список ──────────────────────────────────────────────────────────────────

listings.get("/", requirePermission("catalog.read"), async (c) => {
  const q = (c.req.query("q") ?? "").trim().slice(0, 100);
  const statusParam = c.req.query("status");
  const status = LISTING_STATUSES.find((s) => s === statusParam);
  const vendorParam = c.req.query("vendorId");
  const vendorId = vendorParam ? pathId(vendorParam) : undefined;
  const { limit, offset } = paging((key) => c.req.query(key));

  const result = await withActor(c.var.db, staffOf(c), async (trx) => {
    let query = trx
      .selectFrom("app.listings as l")
      .innerJoin("app.vendor_accounts as v", "v.id", "l.vendor_id")
      .select([
        "l.id",
        "l.name",
        "l.slug",
        "l.status",
        "l.status_reason",
        "l.district_code",
        "l.price_from_uzs",
        "l.price_unit",
        "l.cap_min",
        "l.cap_max",
        "l.submitted_at",
        "l.updated_at",
        "v.id as vendor_id",
        "v.public_code",
        "v.name as vendor_name",
        blockers("l.id", "active").as("blockers"),
        sql<number>`(select count(*)::int from app.photos p
                     where p.listing_id = l.id and p.deleted_at is null and p.status = 'ready')`.as(
          "photos_ready",
        ),
        sql<number>`(select count(*)::int from app.photos p
                     where p.listing_id = l.id and p.deleted_at is null and p.status = 'ready'
                       and p.moderation = 'approved')`.as("photos_approved"),
        sql<number>`(count(*) over ())::int`.as("total"),
      ]);
    if (status) query = query.where("l.status", "=", status);
    if (vendorId) query = query.where("l.vendor_id", "=", vendorId);
    if (q !== "") {
      const pattern = likePattern(q);
      query = query.where((eb) =>
        eb.or([
          eb("l.name", "ilike", pattern),
          eb("l.slug", "ilike", pattern),
          eb("v.name", "ilike", pattern),
          eb("v.public_code", "ilike", pattern),
        ]),
      );
    }
    // Очередь проверки — по порядку отправки, остальное — свежие сверху
    query =
      status === "review"
        ? query.orderBy("l.submitted_at", "asc").orderBy("l.id")
        : query.orderBy("l.updated_at", "desc").orderBy("l.id");
    const rows = await query.limit(limit).offset(offset).execute();

    const counts = await trx
      .selectFrom("app.listings")
      .select(["status", sql<number>`count(*)::int`.as("n")])
      .groupBy("status")
      .execute();
    return { rows, counts };
  });

  const counts = Object.fromEntries(LISTING_STATUSES.map((s) => [s, 0])) as Record<ListingStatus, number>;
  for (const row of result.counts) counts[row.status] = row.n;

  const body: ListingList = {
    total: result.rows[0]?.total ?? 0,
    counts,
    items: result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status,
      statusReason: row.status_reason,
      districtCode: row.district_code,
      priceFromUzs: num(row.price_from_uzs),
      priceUnit: row.price_unit,
      capMin: row.cap_min,
      capMax: row.cap_max,
      submittedAt: iso(row.submitted_at),
      updatedAt: iso(row.updated_at),
      blockers: row.blockers,
      vendor: { id: row.vendor_id, code: row.public_code, name: row.vendor_name },
      photos: { ready: row.photos_ready, approved: row.photos_approved },
    })),
  };
  return c.json(body);
});

// ── разбор полей карточки ───────────────────────────────────────────────────

interface ListingFields {
  name?: string;
  slug?: string;
  district_code?: string | null;
  address_ru?: string | null;
  address_uz?: string | null;
  description_ru?: string | null;
  description_uz?: string | null;
  price_from_uzs?: number | null;
  price_unit?: PriceUnit;
  cap_min?: number | null;
  cap_max?: number | null;
}

interface ParsedListing {
  fields: ListingFields;
  packages: StaffListingPackage[] | undefined;
  phone: string | null | undefined;
}

function parsePackage(item: Input): StaffListingPackage | undefined {
  const kind = item.oneOf("kind", PACKAGE_KINDS, true);
  const nameRu = item.text("nameRu", { max: 80, required: true });
  const nameUz = item.text("nameUz", { max: 80, required: true });
  const priceUzs = item.int("priceUzs", { min: 1, max: MAX_PRICE, required: true });
  const priceUnit = item.oneOf("priceUnit", PRICE_UNITS) ?? "per_guest";
  if (!kind || !nameRu || !nameUz || typeof priceUzs !== "number") return undefined;
  return { kind, nameRu, nameUz, priceUzs, priceUnit };
}

function parseListing(input: Input, creating: boolean): ParsedListing {
  const name = input.text("name", { min: 2, max: 80, required: creating });
  if (name === null) input.fail("name");
  const slug = input.pattern("slug", SLUG_RE);
  if (slug === null) input.fail("slug");
  const priceUnit = input.oneOf("priceUnit", PRICE_UNITS);
  if (priceUnit === null) input.fail("priceUnit");
  const capMin = input.int("capMin", { min: 1, max: 5000 });
  const capMax = input.int("capMax", { min: 1, max: 5000 });
  if (typeof capMin === "number" && typeof capMax === "number" && capMax < capMin) input.fail("capMax");
  const packages = input.list("packages", MAX_PACKAGES, parsePackage);
  const dayKinds = (packages ?? []).map((p) => p.kind).filter((kind) => kind !== "custom");
  if (new Set(dayKinds).size !== dayKinds.length) input.fail("packages");

  const fields = definedOnly<ListingFields>({
    name: name ?? undefined,
    slug: slug ?? undefined,
    district_code: input.pattern("districtCode", /^[a-z_]{2,30}$/),
    address_ru: input.text("addressRu", { max: 300 }),
    address_uz: input.text("addressUz", { max: 300 }),
    description_ru: input.text("descriptionRu", { max: 4000, multiline: true }),
    description_uz: input.text("descriptionUz", { max: 4000, multiline: true }),
    price_from_uzs: input.int("priceFromUzs", { min: 1, max: MAX_PRICE }),
    price_unit: priceUnit ?? undefined,
    cap_min: capMin,
    cap_max: capMax,
  });
  return { fields, packages, phone: input.phone("phone") };
}

// Район — из справочника: внешний ключ дал бы непонятный 404
async function assertDistrict(trx: Tx, code: string | null | undefined): Promise<void> {
  if (code === undefined || code === null) return;
  const found = await trx
    .selectFrom("app.districts")
    .select("code")
    .where("code", "=", code)
    .executeTakeFirst();
  if (!found) throw invalidInput(["districtCode"]);
}

// Набор пакетов заменяется целиком. Будни и выходные обновляются на месте (у
// опубликованного зала их нельзя удалить даже на миг — триггер), произвольные
// пересоздаются; убранные удаляются последними
export async function replacePackages(
  trx: Tx,
  listingId: string,
  packages: readonly StaffListingPackage[],
): Promise<void> {
  const existing = await trx
    .selectFrom("app.listing_packages")
    .select(["id", "kind"])
    .where("listing_id", "=", listingId)
    .execute();
  const dayIds = new Map(existing.filter((p) => p.kind !== "custom").map((p) => [p.kind, p.id]));
  const stale = new Set(existing.map((p) => p.id));

  for (const [index, pkg] of packages.entries()) {
    const values = {
      name_ru: pkg.nameRu,
      name_uz: pkg.nameUz,
      price_uzs: pkg.priceUzs,
      price_unit: pkg.priceUnit,
      sort: index,
    };
    const id = pkg.kind === "custom" ? undefined : dayIds.get(pkg.kind);
    if (id !== undefined) {
      stale.delete(id);
      await trx.updateTable("app.listing_packages").set(values).where("id", "=", id).execute();
    } else {
      await trx
        .insertInto("app.listing_packages")
        .values({ listing_id: listingId, kind: pkg.kind, ...values })
        .execute();
    }
  }
  if (stale.size > 0) {
    await trx
      .deleteFrom("app.listing_packages")
      .where("id", "in", [...stale])
      .execute();
  }
}

async function saveExtras(trx: Tx, listingId: string, parsed: ParsedListing): Promise<void> {
  if (parsed.packages !== undefined) await replacePackages(trx, listingId, parsed.packages);
  if (parsed.phone !== undefined) await saveListingPhone(trx, listingId, parsed.phone);
}

// ── создать ─────────────────────────────────────────────────────────────────

listings.post("/", requirePermission("listings.write"), limitJson, async (c) => {
  const input = new Input(await readBody(c.req.raw));
  const vendorId = input.uuid("vendorId", true);
  const status = input.oneOf("status", ["lead", "draft"] as const) ?? "draft";
  const categoryCode = input.pattern("categoryCode", /^[a-z_]{2,20}$/) ?? "hall";
  const parsed = parseListing(input, true);
  input.done();
  const name = parsed.fields.name;
  if (!vendorId || !name) throw invalidInput(["vendorId", "name"]);

  const listing = await withActor(c.var.db, staffOf(c), async (trx) => {
    const vendor = await trx
      .selectFrom("app.vendor_accounts")
      .select("id")
      .where("id", "=", vendorId)
      .executeTakeFirst();
    if (!vendor) throw notFound();
    const category = await trx
      .selectFrom("app.categories")
      .select("code")
      .where("code", "=", categoryCode)
      .where("enabled", "=", true)
      .executeTakeFirst();
    if (!category) throw invalidInput(["categoryCode"]);
    await assertDistrict(trx, parsed.fields.district_code);

    let slug = parsed.fields.slug;
    if (slug === undefined) {
      const base = slugify(name);
      const taken = await trx
        .selectFrom("app.listings")
        .select("slug")
        .where("slug", "like", `${base}%`)
        .execute();
      slug = freeSlug(base, new Set(taken.map((row) => row.slug)));
    }

    const created = await trx
      .insertInto("app.listings")
      .values({ ...parsed.fields, name, slug, vendor_id: vendorId, category_code: categoryCode, status })
      .returning("id")
      .executeTakeFirstOrThrow();
    await saveExtras(trx, created.id, parsed);
    return loadListing(trx, created.id);
  });
  return c.json(listing, 201);
});

// ── прочитать, изменить ─────────────────────────────────────────────────────

listings.get("/:id", requirePermission("catalog.read"), async (c) => {
  const id = pathId(c.req.param("id"));
  return c.json(await withActor(c.var.db, staffOf(c), (trx) => loadListing(trx, id)));
});

/**
 * UPDATE карточки при условии, что её версия — та, что видел сотрудник. Без полей —
 * «пустая» правка (name = name): версия всё равно растёт, так правки пакетов и
 * телефона тоже проходят через блокировку
 */
async function updateListing(
  trx: Tx,
  id: string,
  version: number,
  set: ListingFields & { status?: ListingStatus; status_reason?: string | null },
): Promise<number> {
  const query = trx.updateTable("app.listings");
  const row = await (Object.keys(set).length > 0
    ? query.set(set)
    : query.set((eb) => ({ name: eb.ref("name") }))
  )
    .where("id", "=", id)
    .where("version", "=", version)
    .returning("version")
    .executeTakeFirst();
  if (row) return row.version;
  const exists = await trx.selectFrom("app.listings").select("id").where("id", "=", id).executeTakeFirst();
  throw exists ? versionConflict() : notFound();
}

listings.patch("/:id", requirePermission("listings.write"), limitJson, async (c) => {
  const id = pathId(c.req.param("id"));
  const input = new Input(await readBody(c.req.raw));
  const version = input.int("version", { min: 1, max: 2_147_483_647, required: true });
  const parsed = parseListing(input, false);
  input.done();
  if (typeof version !== "number") throw invalidInput(["version"]);

  const listing = await withActor(c.var.db, staffOf(c), async (trx) => {
    await assertDistrict(trx, parsed.fields.district_code);
    await updateListing(trx, id, version, parsed.fields);
    await saveExtras(trx, id, parsed);
    return loadListing(trx, id);
  });
  return c.json(listing);
});

// ── действия со статусом ────────────────────────────────────────────────────
// Шаги по разрешённым переходам базы (lead → draft → review → active ⇄ suspended;
// lead|draft|review → rejected → draft). «Отправить на проверку» из лида или отказа
// проходит через черновик — одной транзакцией

interface ActionPlan {
  permission: StaffPermission;
  steps: Partial<Record<ListingStatus, ListingStatus[]>>;
  reasonRequired: boolean;
}

const ACTIONS: Record<ListingAction, ActionPlan> = {
  submit: {
    permission: "listings.submit",
    steps: { lead: ["draft", "review"], draft: ["review"], rejected: ["draft", "review"] },
    reasonRequired: false,
  },
  publish: {
    permission: "listings.publish",
    steps: { review: ["active"], suspended: ["active"] },
    reasonRequired: false,
  },
  suspend: { permission: "listings.moderate", steps: { active: ["suspended"] }, reasonRequired: true },
  reject: {
    permission: "listings.moderate",
    steps: { lead: ["rejected"], draft: ["rejected"], review: ["rejected"] },
    reasonRequired: true,
  },
  draft: {
    permission: "listings.draft",
    steps: { lead: ["draft"], review: ["draft"], rejected: ["draft"] },
    reasonRequired: false,
  },
};

const illegalTransition = () => new ApiError(409, "illegal_transition", "Status transition is not allowed");

for (const [action, plan] of Object.entries(ACTIONS) as [ListingAction, ActionPlan][]) {
  listings.post(`/:id/${action}`, requirePermission(plan.permission), limitJson, async (c) => {
    const id = pathId(c.req.param("id"));
    const input = new Input(await readBody(c.req.raw));
    const version = input.int("version", { min: 1, max: 2_147_483_647, required: true });
    const reason = input.text("reason", { max: 1000, required: plan.reasonRequired, multiline: true });
    input.done();
    if (typeof version !== "number") throw invalidInput(["version"]);

    const listing = await withActor(c.var.db, staffOf(c), async (trx) => {
      const current = await trx
        .selectFrom("app.listings")
        .select(["status", "version"])
        .where("id", "=", id)
        .executeTakeFirst();
      if (!current) throw notFound();
      if (current.version !== version) throw versionConflict();
      const steps = plan.steps[current.status];
      if (!steps) throw illegalTransition();

      // Комментарий к шагу без обязательной причины — в историю статусов (app.reason)
      if (reason && !plan.reasonRequired) {
        await sql`select set_config('app.reason', ${reason}, true)`.execute(trx);
      }
      // Модератор публикует карточку целиком: готовые фото, ждущие решения, одобряются
      if (action === "publish") {
        await trx
          .updateTable("app.photos")
          .set({ moderation: "approved" })
          .where("listing_id", "=", id)
          .where("deleted_at", "is", null)
          .where("status", "=", "ready")
          .where("moderation", "=", "pending")
          .execute();
      }

      let next = version;
      for (const status of steps) {
        const statusReason = status === "suspended" || status === "rejected" ? (reason ?? null) : undefined;
        next = await updateListing(trx, id, next, {
          status,
          ...(statusReason !== undefined ? { status_reason: statusReason } : {}),
        });
      }
      return loadListing(trx, id);
    });
    return c.json(listing);
  });
}

// ── телефон для заявок ──────────────────────────────────────────────────────
// У опубликованной карточки он публичный (читается без журнала), у остальных —
// с записью в журнал доступа к ПДн

listings.post("/:id/phone", requirePermission("vendor_phones.read"), limitJson, async (c) => {
  const id = pathId(c.req.param("id"));
  const reason = await readReason(c.req.raw);
  const phone = await withActor(c.var.db, staffOf(c), async (trx) => {
    const exists = await trx.selectFrom("app.listings").select("id").where("id", "=", id).executeTakeFirst();
    if (!exists) throw notFound();
    return readListingPhone(trx, id, reason);
  });
  return c.json({ phone });
});
