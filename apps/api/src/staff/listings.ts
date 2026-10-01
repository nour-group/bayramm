// Карточки (листинги) в панели оператора. Контракт — @bayramm/shared/api/staff.
//
//   GET   /staff/listings?status=&q=&vendorId=&category=&photos=pending&limit=&offset=
//                                                               список, очереди проверки и новых фото
//   POST  /staff/listings                                       создать (vendorId, name, categoryCode)
//   GET   /staff/listings/:id                                   карточка целиком
//   PATCH /staff/listings/:id                                   правка (version обязателен)
//   POST  /staff/listings/:id/submit | publish | suspend | reject | draft   { version, reason? }
//   POST  /staff/listings/:id/category { categoryCode, version } сменить категорию (пока нет заявок)
//   POST  /staff/listings/:id/phone  { reason? }                телефон для заявок (в журнал)
//
// Жизненный цикл и правила публикации — в базе (listings_before_update,
// app.listing_publish_blockers): API только выбирает шаги и переводит ошибки.
// Оптимистичная блокировка — по version: правка и действие проходят, только если
// карточку с тех пор не меняли (триггер увеличивает version на каждом UPDATE).
//
// Кто заполняет карточку, тот её не публикует: у опубликованной карточки название и
// описания сотрудник без права модерации (менеджер) меняет только правкой на
// модерацию (app.listing_revisions) — как партнёр. Остальные поля
// (адрес, район, вместимость, поля витрины, ссылки на видео, телефон, адрес страницы,
// сколько заказов одновременно) сохраняются сразу. Так же решает база
// (listings_before_update, listing_services_guard → BR005).
//
// Цены — только в услугах (staff/services.ts), цену «от» карточки считает база. Поля
// витрины проверяются по конфигурации категории (@bayramm/shared/categories).

import type {
  ListingAction,
  ListingDetail,
  ListingList,
  ListingSaveResult,
  ListingStatus,
  PendingRevision,
  RevisionField,
  StaffPermission,
  StaffPhoto,
} from "@bayramm/shared/api/staff";
import {
  type AttributeValue,
  type CategoryConfig,
  categoryConfig,
  mergeAttributes,
  missingAttributes,
  readAttributes,
  validateAttributePatch,
  validateVideoLinks,
} from "@bayramm/shared/categories";
import { Hono } from "hono";
import { sql } from "kysely";
import { staffOf } from "../auth/session";
import { roleActorKind, type Tx, withActor } from "../db/actor";
import { hasListingPhone, readListingPhone, saveListingPhone, staffName } from "../db/pii";
import type { Json } from "../db/schema.generated";
import type { AppEnv } from "../env";
import { ApiError, notFound, versionConflict } from "../errors";
import { approveReviewServices, listServices, type ServiceActor } from "../listing-services/store";
import { can, requirePermission } from "./access";
import { Input, invalidInput, likePattern, limitJson, paging, readBody } from "./input";
import { changedOnly, revisionFields } from "./revision-diff";
import { blockers, iso, LISTING_STATUSES, num, pathId } from "./shared";
import { pickSlug, SLUG_RE } from "./slug";
import { definedOnly, readReason } from "./vendors";

export const listings = new Hono<AppEnv>();

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
      "l.attributes",
      "l.video_links",
      "l.parallel_capacity",
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

  const category = categoryConfig(row.category_code);
  const attributes = category === undefined ? {} : readAttributes(category, row.attributes);

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

  const pending = await trx
    .selectFrom("app.listing_revisions as rv")
    .select([
      "rv.id",
      "rv.payload",
      "rv.submitted_at",
      sql<boolean>`exists (select 1 from app.staff s where s.id = rv.submitted_by)`.as("by_staff"),
      staffName("rv.submitted_by").as("staff_name"),
    ])
    .where("rv.listing_id", "=", id)
    .where("rv.status", "=", "pending")
    .executeTakeFirst();

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
    attributes,
    missingAttributes: category === undefined ? [] : missingAttributes(category, attributes),
    videoLinks: row.video_links,
    parallelCapacity: row.parallel_capacity,
    services: await listServices(trx, id),
    submittedAt: iso(row.submitted_at),
    publishedAt: iso(row.published_at),
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    hasPhone: row.has_phone,
    photos: await loadPhotos(trx, id),
    blockers: { review: row.blockers_review, active: row.blockers_active },
    vendor: { id: row.vendor_id, code: row.public_code, name: row.vendor_name },
    history: history.map((h) => ({
      from: h.from_status,
      to: h.to_status,
      reason: h.reason,
      actorKind: roleActorKind(h.actor_kind),
      actorName: h.actor_name,
      at: iso(h.at),
    })),
    pendingRevision: pending === undefined ? null : pendingView(pending),
  };
}

function payloadKeys(payload: Json): string[] {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? Object.keys(payload)
    : [];
}

function pendingView(row: {
  id: string;
  payload: Json;
  submitted_at: Date;
  by_staff: boolean;
  staff_name: string | null;
}): PendingRevision {
  return {
    id: row.id,
    fields: revisionFields(payloadKeys(row.payload)),
    submittedAt: iso(row.submitted_at),
    proposedBy: row.by_staff ? { kind: "staff", name: row.staff_name } : { kind: "partner", name: null },
  };
}

// ── список ──────────────────────────────────────────────────────────────────

listings.get("/", requirePermission("catalog.read"), async (c) => {
  const q = (c.req.query("q") ?? "").trim().slice(0, 100);
  const statusParam = c.req.query("status");
  const status = LISTING_STATUSES.find((s) => s === statusParam);
  const vendorParam = c.req.query("vendorId");
  const vendorId = vendorParam ? pathId(vendorParam) : undefined;
  const categoryParam = c.req.query("category");
  const category = categoryParam && /^[a-z_]{2,20}$/.test(categoryParam) ? categoryParam : undefined;
  // Очередь «Новые фото»: опубликованные карточки, у которых есть фото на решении
  const pendingPhotos = c.req.query("photos") === "pending";
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
        "l.category_code",
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
        sql<number>`(select count(*)::int from app.photos p
                     where p.listing_id = l.id and p.deleted_at is null and p.status = 'ready'
                       and p.moderation = 'pending')`.as("photos_pending"),
        sql<Date | null>`(select min(p.created_at) from app.photos p
                          where p.listing_id = l.id and p.deleted_at is null and p.status = 'ready'
                            and p.moderation = 'pending')`.as("photos_pending_since"),
        sql<number>`(count(*) over ())::int`.as("total"),
      ]);
    if (status) query = query.where("l.status", "=", status);
    if (pendingPhotos) {
      query = query.where("l.status", "=", "active").where(
        sql<boolean>`exists (select 1 from app.photos p
                     where p.listing_id = l.id and p.deleted_at is null and p.status = 'ready'
                       and p.moderation = 'pending')`,
      );
    }
    if (vendorId) query = query.where("l.vendor_id", "=", vendorId);
    if (category) query = query.where("l.category_code", "=", category);
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
    // Очередь проверки — по порядку отправки, новых фото — по первой загрузке,
    // остальное — свежие сверху
    query = pendingPhotos
      ? query.orderBy(sql`photos_pending_since`, "asc").orderBy("l.id")
      : status === "review"
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
      categoryCode: row.category_code,
      districtCode: row.district_code,
      priceFromUzs: num(row.price_from_uzs),
      priceUnit: row.price_unit,
      capMin: row.cap_min,
      capMax: row.cap_max,
      submittedAt: iso(row.submitted_at),
      updatedAt: iso(row.updated_at),
      blockers: row.blockers,
      vendor: { id: row.vendor_id, code: row.public_code, name: row.vendor_name },
      photos: { ready: row.photos_ready, approved: row.photos_approved, pending: row.photos_pending },
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
  cap_min?: number | null;
  cap_max?: number | null;
  /** Поля витрины после слияния с правкой — строкой JSON */
  attributes?: string;
  video_links?: string[];
  parallel_capacity?: number;
}

interface ParsedListing {
  fields: ListingFields;
  phone: string | null | undefined;
  /** Правка полей витрины как пришла — проверяется по категории (categoryFields) */
  attributes: unknown;
  /** Ссылки на видео как пришли — проверяются по категории */
  videoLinks: unknown;
}

function parseListing(input: Input, creating: boolean): ParsedListing {
  const name = input.text("name", { min: 2, max: 80, required: creating });
  if (name === null) input.fail("name");
  const slug = input.pattern("slug", SLUG_RE);
  if (slug === null) input.fail("slug");
  const capMin = input.int("capMin", { min: 1, max: 5000 });
  const capMax = input.int("capMax", { min: 1, max: 5000 });
  if (typeof capMin === "number" && typeof capMax === "number" && capMax < capMin) input.fail("capMax");
  const parallel = input.int("parallelCapacity", { min: 1, max: 50 });
  if (parallel === null) input.fail("parallelCapacity");
  const fields = definedOnly<ListingFields>({
    name: name ?? undefined,
    slug: slug ?? undefined,
    district_code: input.pattern("districtCode", /^[a-z_]{2,30}$/),
    address_ru: input.text("addressRu", { max: 300 }),
    address_uz: input.text("addressUz", { max: 300 }),
    description_ru: input.text("descriptionRu", { max: 4000, multiline: true }),
    description_uz: input.text("descriptionUz", { max: 4000, multiline: true }),
    cap_min: capMin,
    cap_max: capMax,
    parallel_capacity: parallel ?? undefined,
  });
  return {
    fields,
    phone: input.phone("phone"),
    attributes: input.peek("attributes"),
    videoLinks: input.peek("videoLinks"),
  };
}

/**
 * Поля витрины и ссылки на видео из тела — по категории карточки; поля витрины
 * сливаются с текущими (null — убрать). Неверные — 422 invalid_input (attributes.<поле>…)
 */
function categoryFields(
  category: CategoryConfig | undefined,
  parsed: ParsedListing,
  current: Json,
): Pick<ListingFields, "attributes" | "video_links"> {
  const out: Pick<ListingFields, "attributes" | "video_links"> = {};
  const errors: string[] = [];
  if (parsed.attributes !== undefined) {
    const result = category === undefined ? null : validateAttributePatch(category, parsed.attributes);
    if (result === null || !result.ok) errors.push(...(result?.errors ?? ["attributes"]));
    else {
      const base =
        typeof current === "object" && current !== null && !Array.isArray(current)
          ? (current as Record<string, AttributeValue>)
          : {};
      out.attributes = JSON.stringify(mergeAttributes(base, result.value));
    }
  }
  if (parsed.videoLinks !== undefined) {
    const result =
      parsed.videoLinks === null
        ? ({ ok: true, value: [] as string[] } as const)
        : category === undefined
          ? null
          : validateVideoLinks(category, parsed.videoLinks);
    if (result === null || !result.ok) errors.push(...(result?.errors ?? ["videoLinks"]));
    else out.video_links = result.value;
  }
  if (errors.length > 0) throw invalidInput(errors);
  return out;
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

/** Кто правит услуги из панели: решает ли по модерации и правит ли активные только предложением */
export function staffServiceActor(role: StaffActorRole, listingStatus: ListingStatus): ServiceActor {
  const decides = can(role, "revisions.moderate");
  return { decides, restricted: !decides && listingStatus === "active" };
}

type StaffActorRole = ReturnType<typeof staffOf>["role"];

/** Телефон для заявок — не столбец карточки: пишет saveListingPhone */
async function savePhone(trx: Tx, listingId: string, parsed: ParsedListing): Promise<void> {
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
  const actor = staffOf(c);
  const extra = categoryFields(categoryConfig(categoryCode), parsed, {});

  const listing = await withActor(c.var.db, actor, async (trx) => {
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

    const slug = parsed.fields.slug ?? (await pickSlug(trx, name));

    const created = await trx
      .insertInto("app.listings")
      .values({
        ...parsed.fields,
        ...extra,
        name,
        slug,
        vendor_id: vendorId,
        category_code: categoryCode,
        status,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await savePhone(trx, created.id, parsed);
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
 * «пустая» правка (name = name): версия всё равно растёт, так правка телефона тоже
 * проходит через блокировку
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

/**
 * Модерируемые поля карточки: у опубликованной их меняет только решение модератора. Цена
 * «от» — из услуг (их правка модерируется отдельно), поэтому здесь её нет
 */
const MODERATED = ["name", "description_ru", "description_uz"] as const;
/** Столбец → поле контракта, для ответа 422 */
const MODERATED_INPUT: Readonly<Record<(typeof MODERATED)[number], string>> = {
  name: "name",
  description_ru: "descriptionRu",
  description_uz: "descriptionUz",
};

/**
 * Правка опубликованной карточки сотрудником без права модерации: изменённые
 * модерируемые поля — в правку на модерацию (как у партнёра), остальное — сразу. Не опубликована — всё сразу. Возвращает то, что сохраняется сразу, и поля,
 * ушедшие правкой. Открытая правка уже есть — 409 revision_pending (индекс базы)
 */
async function proposeModerated(
  trx: Tx,
  id: string,
  version: number,
  parsed: ParsedListing,
): Promise<{ direct: ParsedListing; sent: RevisionField[] }> {
  const current = await trx
    .selectFrom("app.listings")
    .select(["status", "version", "name", "description_ru", "description_uz"])
    .where("id", "=", id)
    .forUpdate()
    .executeTakeFirst();
  if (current === undefined) throw notFound();
  if (current.status !== "active") return { direct: parsed, sent: [] };
  if (current.version !== version) throw versionConflict();

  const { fields } = parsed;
  // Очистить модерируемое поле опубликованной карточки нельзя: без него она не готова
  const cleared = MODERATED.filter((key) => fields[key] === null).map((key) => MODERATED_INPUT[key]);
  if (cleared.length > 0) throw invalidInput(cleared);

  const proposed = {
    fields: {
      ...(typeof fields.name === "string" ? { name: fields.name } : {}),
      ...(typeof fields.description_ru === "string" ? { description_ru: fields.description_ru } : {}),
      ...(typeof fields.description_uz === "string" ? { description_uz: fields.description_uz } : {}),
    },
  };
  const payload = changedOnly(proposed, current);
  const sent = revisionFields(Object.keys(payload));
  if (sent.length > 0) {
    await trx
      .insertInto("app.listing_revisions")
      .values({ listing_id: id, payload: payload as Json, base_version: current.version })
      .execute();
  }

  // Сразу — немодерируемое: адрес, район, вместимость, поля витрины, ссылки на видео,
  // одновременные заказы, телефон, адрес страницы
  const direct: ListingFields = {
    slug: fields.slug,
    district_code: fields.district_code,
    address_ru: fields.address_ru,
    address_uz: fields.address_uz,
    cap_min: fields.cap_min,
    cap_max: fields.cap_max,
    parallel_capacity: fields.parallel_capacity,
  };
  return {
    direct: {
      fields: definedOnly(direct),
      phone: parsed.phone,
      attributes: parsed.attributes,
      videoLinks: parsed.videoLinks,
    },
    sent,
  };
}

listings.patch("/:id", requirePermission("listings.write"), limitJson, async (c) => {
  const id = pathId(c.req.param("id"));
  const input = new Input(await readBody(c.req.raw));
  const version = input.int("version", { min: 1, max: 2_147_483_647, required: true });
  const parsed = parseListing(input, false);
  input.done();
  if (typeof version !== "number") throw invalidInput(["version"]);
  const actor = staffOf(c);

  const listing: ListingSaveResult = await withActor(c.var.db, actor, async (trx) => {
    await assertDistrict(trx, parsed.fields.district_code);
    const current = await trx
      .selectFrom("app.listings")
      .select(["category_code", "status", "attributes"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (current === undefined) throw notFound();
    // Модератор и администратор правят опубликованную карточку сразу: решают они же
    const { direct, sent } = can(actor.role, "revisions.moderate")
      ? { direct: parsed, sent: [] }
      : await proposeModerated(trx, id, version, parsed);
    const extra = categoryFields(categoryConfig(current.category_code), direct, current.attributes);
    await updateListing(trx, id, version, { ...direct.fields, ...extra });
    await savePhone(trx, id, direct);
    return { ...(await loadListing(trx, id)), sentForModeration: sent };
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

/**
 * Действие со статусом карточки — шаги по плану ACTIONS, если её версия — version.
 * Проверку прав делает вызывающий: панель — requirePermission, демо-данные staging
 * (demo/) — актор system. Возвращает новую версию
 */
export async function applyListingAction(
  trx: Tx,
  id: string,
  action: ListingAction,
  version: number,
  reason: string | null = null,
): Promise<number> {
  const plan = ACTIONS[action];
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
  // Модератор публикует карточку целиком: готовые фото и услуги, ждущие решения, одобряются
  if (action === "publish") {
    await trx
      .updateTable("app.photos")
      .set({ moderation: "approved" })
      .where("listing_id", "=", id)
      .where("deleted_at", "is", null)
      .where("status", "=", "ready")
      .where("moderation", "=", "pending")
      .execute();
    await approveReviewServices(trx, id);
  }

  let next = version;
  for (const status of steps) {
    const statusReason = status === "suspended" || status === "rejected" ? reason : undefined;
    next = await updateListing(trx, id, next, {
      status,
      ...(statusReason !== undefined ? { status_reason: statusReason } : {}),
    });
  }
  return next;
}

for (const [action, plan] of Object.entries(ACTIONS) as [ListingAction, ActionPlan][]) {
  listings.post(`/:id/${action}`, requirePermission(plan.permission), limitJson, async (c) => {
    const id = pathId(c.req.param("id"));
    const input = new Input(await readBody(c.req.raw));
    const version = input.int("version", { min: 1, max: 2_147_483_647, required: true });
    const reason = input.text("reason", { max: 1000, required: plan.reasonRequired, multiline: true });
    input.done();
    if (typeof version !== "number") throw invalidInput(["version"]);

    const listing = await withActor(c.var.db, staffOf(c), async (trx) => {
      await applyListingAction(trx, id, action, version, reason ?? null);
      return loadListing(trx, id);
    });
    return c.json(listing);
  });
}

// ── категория витрины ───────────────────────────────────────────────────────
// Только пока по витрине нет заявок (иначе 409 category_locked — новая витрина). Услуги
// прежней категории удаляются, поля витрины очищаются — app.staff_set_listing_category

listings.post("/:id/category", requirePermission("listings.write"), limitJson, async (c) => {
  const id = pathId(c.req.param("id"));
  const input = new Input(await readBody(c.req.raw));
  const version = input.int("version", { min: 1, max: 2_147_483_647, required: true });
  const categoryCode = input.pattern("categoryCode", /^[a-z_]{2,20}$/, true);
  input.done();
  if (typeof version !== "number" || typeof categoryCode !== "string") throw invalidInput(["version"]);
  const listing = await withActor(c.var.db, staffOf(c), async (trx) => {
    const current = await trx
      .selectFrom("app.listings")
      .select("version")
      .where("id", "=", id)
      .forUpdate()
      .executeTakeFirst();
    if (current === undefined) throw notFound();
    if (current.version !== version) throw versionConflict();
    await sql`select app.staff_set_listing_category(${id}::uuid, ${categoryCode})`.execute(trx);
    return loadListing(trx, id);
  });
  return c.json(listing);
});

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
