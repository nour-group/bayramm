// Правки карточек (app.listing_revisions): партнёр меняет название, цену, описания и
// пакеты только так — клиент видит одобренную версию, пока правка ждёт решения.
// Подаёт правку кабинет (vendor/revisions.ts), здесь — сторона сотрудника: очередь,
// сравнение «сейчас / предлагает вендор», решение.
//
//   GET  /staff/revisions?status=pending|approved|declined|withdrawn&limit=&offset=
//   GET  /staff/revisions/:id
//   POST /staff/revisions/:id/approve              применить к карточке и одобрить
//   POST /staff/revisions/:id/decline { reason }   отклонить; причину увидит вендор
//
// Форма payload — ListingRevisionPayload (@bayramm/shared/api/vendor): ключи как
// столбцы базы, их список проверяет app.revision_payload_ok. Значения база не
// проверяет — их проверяем здесь теми же правилами, что правку карточки
// сотрудником (и те же правила — при подаче из кабинета, revisionFromBody); не
// прошли — правку можно только отклонить. Кто и когда решил, ставит триггер
// listing_revisions_guard, журнал пишет триггер audit_staff.

import type {
  PriceUnit,
  RevisionChange,
  RevisionDetail,
  RevisionField,
  RevisionList,
  RevisionListItem,
  RevisionStatus,
  RevisionValue,
  StaffListingPackage,
} from "@bayramm/shared/api/staff";
import { Hono } from "hono";
import { sql } from "kysely";
import { staffOf } from "../auth/session";
import { type Tx, withActor } from "../db/actor";
import type { Json } from "../db/schema.generated";
import type { AppEnv } from "../env";
import { ApiError, notFound } from "../errors";
import { requirePermission } from "./access";
import { type Body, Input, invalidInput, limitJson, paging, readBody } from "./input";
import { MAX_PACKAGES, MAX_PRICE, PACKAGE_KINDS, PRICE_UNITS, replacePackages } from "./listings";
import { iso, num, pathId, staffName } from "./shared";

export const revisions = new Hono<AppEnv>();

const STATUSES = [
  "pending",
  "approved",
  "declined",
  "withdrawn",
] as const satisfies readonly RevisionStatus[];

/** Ключ payload (столбец базы) → поле контракта, в порядке показа */
const FIELDS = [
  ["name", "name"],
  ["price_from_uzs", "priceFromUzs"],
  ["price_unit", "priceUnit"],
  ["description_ru", "descriptionRu"],
  ["description_uz", "descriptionUz"],
  ["packages", "packages"],
] as const satisfies readonly (readonly [string, RevisionField])[];

/** Ключи payload — как столбцы базы (app.revision_payload_ok) */
const KEYS: readonly string[] = FIELDS.map(([key]) => key);

export interface RevisionValues {
  /** Столбцы карточки, которые правка меняет */
  fields: {
    name?: string;
    price_from_uzs?: number;
    price_unit?: PriceUnit;
    description_ru?: string;
    description_uz?: string;
  };
  packages: StaffListingPackage[] | undefined;
}

interface ParsedRevision extends RevisionValues {
  valid: boolean;
}

function parsePackage(item: Input): StaffListingPackage | undefined {
  const kind = item.oneOf("kind", PACKAGE_KINDS, true);
  const nameRu = item.text("name_ru", { max: 80, required: true });
  const nameUz = item.text("name_uz", { max: 80, required: true });
  const priceUzs = item.int("price_uzs", { min: 1, max: MAX_PRICE, required: true });
  const priceUnit = item.oneOf("price_unit", PRICE_UNITS) ?? "per_guest";
  if (!kind || !nameRu || !nameUz || typeof priceUzs !== "number") return undefined;
  return { kind, nameRu, nameUz, priceUzs, priceUnit };
}

/** Значения правки; ошибки полей копятся в input (ключи — как в payload) */
function readRevision(input: Input, body: Body): RevisionValues {
  const required = (key: string) => Object.hasOwn(body, key);
  const name = input.text("name", { min: 2, max: 80, required: required("name") });
  const price = input.int("price_from_uzs", { min: 1, max: MAX_PRICE, required: required("price_from_uzs") });
  const unit = input.oneOf("price_unit", PRICE_UNITS, required("price_unit"));
  const descriptionRu = input.text("description_ru", {
    max: 4000,
    multiline: true,
    required: required("description_ru"),
  });
  const descriptionUz = input.text("description_uz", {
    max: 4000,
    multiline: true,
    required: required("description_uz"),
  });
  const packages = input.list("packages", MAX_PACKAGES, parsePackage);
  if (required("packages") && packages === undefined) input.fail("packages");
  const dayKinds = (packages ?? []).map((p) => p.kind).filter((kind) => kind !== "custom");
  if (new Set(dayKinds).size !== dayKinds.length) input.fail("packages");

  const fields: RevisionValues["fields"] = {};
  if (typeof name === "string") fields.name = name;
  if (typeof price === "number") fields.price_from_uzs = price;
  if (unit) fields.price_unit = unit;
  if (typeof descriptionRu === "string") fields.description_ru = descriptionRu;
  if (typeof descriptionUz === "string") fields.description_uz = descriptionUz;
  return { fields, packages };
}

/** payload → значения карточки. Нет ключа — поле не меняется; null не бывает */
export function parseRevision(payload: Json): ParsedRevision {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { fields: {}, packages: undefined, valid: false };
  }
  const input = new Input(payload as Body);
  const values = readRevision(input, payload as Body);
  let valid = true;
  try {
    input.done();
  } catch {
    valid = false;
  }
  return { ...values, valid };
}

/**
 * Тело правки из кабинета → значения. Неизвестный ключ или неверное поле — 422
 * invalid_input: в details — ключи (у пакетов — packages.<номер>.<поле>)
 */
export function revisionFromBody(body: Body): RevisionValues {
  const input = new Input(body);
  for (const key of Object.keys(body)) if (!KEYS.includes(key)) input.fail(key);
  const values = readRevision(input, body);
  input.done();
  return values;
}

/** Значение как есть — для показа правки, которая не прошла проверку */
function rawValue(value: unknown): RevisionValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  return JSON.stringify(value).slice(0, 500);
}

const selectRevisions = (trx: Tx) =>
  trx
    .selectFrom("app.listing_revisions as rv")
    .innerJoin("app.listings as l", "l.id", "rv.listing_id")
    .innerJoin("app.vendor_accounts as v", "v.id", "l.vendor_id")
    .select([
      "rv.id",
      "rv.status",
      "rv.payload",
      "rv.base_version",
      "rv.submitted_at",
      "rv.decided_at",
      "rv.decision_reason",
      staffName("rv.decided_by").as("decided_by_name"),
      "l.id as listing_id",
      "l.name as listing_name",
      "l.status as listing_status",
      "l.version as listing_version",
      "l.price_from_uzs",
      "l.price_unit",
      "l.description_ru",
      "l.description_uz",
      "v.id as vendor_id",
      "v.public_code",
      "v.name as vendor_name",
    ]);

type RevisionRow = Awaited<ReturnType<ReturnType<typeof selectRevisions>["executeTakeFirstOrThrow"]>>;

function payloadKeys(payload: Json): string[] {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? Object.keys(payload)
    : [];
}

function itemView(row: RevisionRow): RevisionListItem {
  const keys = payloadKeys(row.payload);
  return {
    id: row.id,
    status: row.status,
    submittedAt: iso(row.submitted_at),
    decidedAt: iso(row.decided_at),
    listing: { id: row.listing_id, name: row.listing_name, status: row.listing_status },
    vendor: { id: row.vendor_id, code: row.public_code, name: row.vendor_name },
    fields: FIELDS.filter(([key]) => keys.includes(key)).map(([, field]) => field),
    // Карточку меняли после версии, от которой вендор считал правку
    stale: row.base_version !== row.listing_version,
  };
}

revisions.get("/", requirePermission("catalog.read"), async (c) => {
  const status = STATUSES.find((s) => s === c.req.query("status")) ?? "pending";
  const { limit, offset } = paging((key) => c.req.query(key));
  const body: RevisionList = await withActor(c.var.db, staffOf(c), async (trx) => {
    let query = selectRevisions(trx)
      .select(sql<number>`(count(*) over ())::int`.as("total"))
      .where("rv.status", "=", status);
    // Очередь — по порядку подачи; решённые — последние сверху
    query =
      status === "pending"
        ? query.orderBy("rv.submitted_at", "asc").orderBy("rv.id")
        : query.orderBy(sql`coalesce(rv.decided_at, rv.submitted_at)`, "desc").orderBy("rv.id");
    const rows = await query.limit(limit).offset(offset).execute();
    return { total: rows[0]?.total ?? 0, items: rows.map(itemView) };
  });
  return c.json(body);
});

async function loadRevision(trx: Tx, id: string): Promise<RevisionDetail> {
  const row = await selectRevisions(trx).where("rv.id", "=", id).executeTakeFirst();
  if (row === undefined) throw notFound();
  const packages = await trx
    .selectFrom("app.listing_packages")
    .select(["kind", "name_ru", "name_uz", "price_uzs", "price_unit"])
    .where("listing_id", "=", row.listing_id)
    .orderBy("sort")
    .orderBy("created_at")
    .execute();

  const parsed = parseRevision(row.payload);
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const current: Record<RevisionField, RevisionValue> = {
    name: row.listing_name,
    priceFromUzs: num(row.price_from_uzs),
    priceUnit: row.price_unit,
    descriptionRu: row.description_ru,
    descriptionUz: row.description_uz,
    packages: packages.map((p) => ({
      kind: p.kind,
      nameRu: p.name_ru,
      nameUz: p.name_uz,
      priceUzs: num(p.price_uzs),
      priceUnit: p.price_unit,
    })),
  };
  const proposed = (key: (typeof FIELDS)[number][0]): RevisionValue => {
    if (key === "packages") return parsed.packages ?? rawValue(payload.packages);
    return parsed.fields[key] ?? rawValue(payload[key]);
  };
  const keys = payloadKeys(row.payload);
  const changes: RevisionChange[] = FIELDS.filter(([key]) => keys.includes(key)).map(([key, field]) => ({
    field,
    before: current[field],
    after: proposed(key),
  }));

  return {
    ...itemView(row),
    changes,
    valid: parsed.valid,
    decisionReason: row.decision_reason,
    decidedBy: row.decided_by_name,
  };
}

revisions.get("/:id", requirePermission("catalog.read"), async (c) => {
  const id = pathId(c.req.param("id"));
  return c.json(await withActor(c.var.db, staffOf(c), (trx) => loadRevision(trx, id)));
});

/** Правка, по которой ещё не решили, — под блокировкой строки до конца транзакции */
async function pendingRevision(trx: Tx, id: string) {
  const row = await trx
    .selectFrom("app.listing_revisions")
    .select(["id", "listing_id", "status", "payload"])
    .where("id", "=", id)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw notFound();
  if (row.status !== "pending") throw new ApiError(409, "illegal_transition", "Revision is already decided");
  return row;
}

// Одобрить = применить к карточке (название, цена, описания, пакеты) и отметить
// решение — одной транзакцией. Правила публикации проверяет база: правка, после
// которой опубликованная карточка перестала бы быть готовой, не проходит (422)
revisions.post("/:id/approve", requirePermission("revisions.moderate"), async (c) => {
  const id = pathId(c.req.param("id"));
  const body = await withActor(c.var.db, staffOf(c), async (trx) => {
    const revision = await pendingRevision(trx, id);
    const parsed = parseRevision(revision.payload);
    if (!parsed.valid) throw new ApiError(422, "revision_invalid", "Revision does not pass field checks");
    if (Object.keys(parsed.fields).length > 0) {
      await trx
        .updateTable("app.listings")
        .set(parsed.fields)
        .where("id", "=", revision.listing_id)
        .execute();
    }
    if (parsed.packages !== undefined) await replacePackages(trx, revision.listing_id, parsed.packages);
    await trx.updateTable("app.listing_revisions").set({ status: "approved" }).where("id", "=", id).execute();
    return loadRevision(trx, id);
  });
  return c.json(body);
});

revisions.post("/:id/decline", requirePermission("revisions.moderate"), limitJson, async (c) => {
  const id = pathId(c.req.param("id"));
  const input = new Input(await readBody(c.req.raw));
  const reason = input.text("reason", { max: 1000, required: true, multiline: true });
  input.done();
  if (typeof reason !== "string") throw invalidInput(["reason"]);
  const body = await withActor(c.var.db, staffOf(c), async (trx) => {
    await pendingRevision(trx, id);
    await trx
      .updateTable("app.listing_revisions")
      .set({ status: "declined", decision_reason: reason })
      .where("id", "=", id)
      .execute();
    return loadRevision(trx, id);
  });
  return c.json(body);
});
