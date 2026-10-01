// Правки карточек (app.listing_revisions): партнёр меняет название, описания, поля
// витрины и ссылки на видео только так — клиент видит одобренную версию, пока правка
// ждёт решения. Цен в правке нет: они в услугах, цену «от» считает база.
// Подаёт правку кабинет (vendor/revisions.ts) или менеджер, правя опубликованную
// карточку (staff/listings.ts); здесь — сторона того, кто решает: очередь, сравнение
// «сейчас / предлагают», решение.
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
  RevisionChange,
  RevisionDetail,
  RevisionField,
  RevisionList,
  RevisionListItem,
  RevisionStatus,
  RevisionValue,
} from "@bayramm/shared/api/staff";
import {
  type AttributeValue,
  type CategoryConfig,
  categoryConfig,
  mergeAttributes,
  readAttributes,
  validateAttributePatch,
  validateVideoLinks,
} from "@bayramm/shared/categories";
import { Hono } from "hono";
import { sql } from "kysely";
import { staffOf } from "../auth/session";
import { type Tx, withActor } from "../db/actor";
import type { Json } from "../db/schema.generated";
import type { AppEnv } from "../env";
import { ApiError, notFound } from "../errors";
import { requirePermission } from "./access";
import { type Body, Input, invalidInput, limitJson, paging, readBody } from "./input";
import { REVISION_FIELDS } from "./revision-diff";
import { iso, pathId, staffName } from "./shared";

export const revisions = new Hono<AppEnv>();

const STATUSES = [
  "pending",
  "approved",
  "declined",
  "withdrawn",
] as const satisfies readonly RevisionStatus[];

/** Ключ payload (столбец базы) → поле контракта, в порядке показа */
const FIELDS = REVISION_FIELDS;

/** Ключи payload — как столбцы базы (app.revision_payload_ok) */
const KEYS: readonly string[] = FIELDS.map(([key]) => key);

export interface RevisionValues {
  /** Столбцы карточки, которые правка меняет */
  fields: {
    name?: string;
    description_ru?: string;
    description_uz?: string;
  };
  /** Поля витрины: { ключ: значение | null } (проверены по категории — checkCategoryFields) */
  attributes?: Readonly<Record<string, AttributeValue | null>>;
  /** Ссылки на видео целиком (проверены по категории) */
  videoLinks?: readonly string[];
}

interface ParsedRevision extends RevisionValues {
  valid: boolean;
}

/** Значения правки; ошибки полей копятся в input (ключи — как в payload) */
function readRevision(input: Input, body: Body): RevisionValues {
  const required = (key: string) => Object.hasOwn(body, key);
  const name = input.text("name", { min: 2, max: 80, required: required("name") });
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

  const fields: RevisionValues["fields"] = {};
  if (typeof name === "string") fields.name = name;
  if (typeof descriptionRu === "string") fields.description_ru = descriptionRu;
  if (typeof descriptionUz === "string") fields.description_uz = descriptionUz;
  return { fields };
}

/**
 * Поля витрины и ссылки на видео правки — по конфигурации категории карточки. Ошибки —
 * в input (ключи — attributes.<поле>…, video_links.<номер>)
 */
function readCategoryFields(input: Input, body: Body, category: CategoryConfig | undefined): RevisionValues {
  const out: { attributes?: RevisionValues["attributes"]; videoLinks?: readonly string[] } = {};
  if (Object.hasOwn(body, "attributes")) {
    const result = category === undefined ? null : validateAttributePatch(category, body.attributes);
    if (result === null || !result.ok)
      for (const field of result?.errors ?? ["attributes"]) input.fail(field);
    else out.attributes = result.value;
  }
  if (Object.hasOwn(body, "video_links")) {
    const result = category === undefined ? null : validateVideoLinks(category, body.video_links);
    if (result === null || !result.ok) {
      for (const field of result?.errors ?? ["videoLinks"])
        input.fail(field.replace(/^videoLinks/, "video_links"));
    } else out.videoLinks = result.value;
  }
  return { fields: {}, ...out };
}

/** payload → значения карточки. Нет ключа — поле не меняется; null не бывает */
export function parseRevision(payload: Json, categoryCode: string): ParsedRevision {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { fields: {}, valid: false };
  }
  const input = new Input(payload as Body);
  const values = {
    ...readRevision(input, payload as Body),
    ...omitBase(readCategoryFields(input, payload as Body, categoryConfig(categoryCode))),
  };
  let valid = true;
  try {
    input.done();
  } catch {
    valid = false;
  }
  return { ...values, valid };
}

/** Только поля витрины и ссылки — без пустых fields */
function omitBase(values: RevisionValues): Pick<RevisionValues, "attributes" | "videoLinks"> {
  return {
    ...(values.attributes === undefined ? {} : { attributes: values.attributes }),
    ...(values.videoLinks === undefined ? {} : { videoLinks: values.videoLinks }),
  };
}

/**
 * Тело правки из кабинета → значения. Неизвестный ключ или неверное поле — 422
 * invalid_input: в details — ключи (у полей витрины — attributes.<поле>…). Поля
 * витрины — по категории карточки
 */
export function revisionFromBody(body: Body, categoryCode: string): RevisionValues {
  const input = new Input(body);
  for (const key of Object.keys(body)) if (!KEYS.includes(key)) input.fail(key);
  const values = {
    ...readRevision(input, body),
    ...omitBase(readCategoryFields(input, body, categoryConfig(categoryCode))),
  };
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
      "l.category_code",
      "l.description_ru",
      "l.description_uz",
      "l.attributes",
      "l.video_links",
      "v.id as vendor_id",
      "v.public_code",
      "v.name as vendor_name",
      sql<boolean>`exists (select 1 from app.staff s where s.id = rv.submitted_by)`.as("by_staff"),
      staffName("rv.submitted_by").as("submitted_by_name"),
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
    listing: {
      id: row.listing_id,
      name: row.listing_name,
      status: row.listing_status,
      categoryCode: row.category_code,
    },
    vendor: { id: row.vendor_id, code: row.public_code, name: row.vendor_name },
    proposedBy: row.by_staff
      ? { kind: "staff", name: row.submitted_by_name }
      : { kind: "partner", name: null },
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

  const parsed = parseRevision(row.payload, row.category_code);
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const category = categoryConfig(row.category_code);
  const attributes = category === undefined ? {} : readAttributes(category, row.attributes);
  // Поля витрины «сейчас» — только те, что меняет правка
  const changedKeys = parsed.attributes === undefined ? [] : Object.keys(parsed.attributes);
  const current: Record<RevisionField, RevisionValue> = {
    name: row.listing_name,
    descriptionRu: row.description_ru,
    descriptionUz: row.description_uz,
    attributes: Object.fromEntries(changedKeys.map((key) => [key, attributes[key] ?? null])),
    videoLinks: row.video_links,
  };
  const proposed = (key: (typeof FIELDS)[number][0]): RevisionValue => {
    if (key === "attributes") return parsed.attributes ?? rawValue(payload.attributes);
    if (key === "video_links") return parsed.videoLinks ?? rawValue(payload.video_links);
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
    .selectFrom("app.listing_revisions as rv")
    .innerJoin("app.listings as l", "l.id", "rv.listing_id")
    .select([
      "rv.id",
      "rv.listing_id",
      "rv.status",
      "rv.payload",
      "l.category_code",
    ])
    .where("rv.id", "=", id)
    .forUpdate("rv")
    .executeTakeFirst();
  if (!row) throw notFound();
  if (row.status !== "pending") throw new ApiError(409, "illegal_transition", "Revision is already decided");
  return row;
}

// Одобрить = применить к карточке (название, описания, поля витрины, ссылки) и отметить
// решение — одной транзакцией. Правила публикации проверяет база: правка, после которой
// опубликованная карточка перестала бы быть готовой, не проходит (422)
revisions.post("/:id/approve", requirePermission("revisions.moderate"), async (c) => {
  const id = pathId(c.req.param("id"));
  const body = await withActor(c.var.db, staffOf(c), async (trx) => {
    const revision = await pendingRevision(trx, id);
    const parsed = parseRevision(revision.payload, revision.category_code);
    if (!parsed.valid) throw new ApiError(422, "revision_invalid", "Revision does not pass field checks");
    const { fields } = parsed;
    let attributes: string | undefined;
    if (parsed.attributes !== undefined) {
      const current = await trx
        .selectFrom("app.listings")
        .select("attributes")
        .where("id", "=", revision.listing_id)
        .executeTakeFirstOrThrow();
      const base =
        typeof current.attributes === "object" &&
        current.attributes !== null &&
        !Array.isArray(current.attributes)
          ? (current.attributes as Record<string, AttributeValue>)
          : {};
      attributes = JSON.stringify(mergeAttributes(base, parsed.attributes));
    }
    const set = {
      ...fields,
      ...(attributes === undefined ? {} : { attributes }),
      ...(parsed.videoLinks === undefined ? {} : { video_links: [...parsed.videoLinks] }),
    };
    if (Object.keys(set).length > 0) {
      await trx.updateTable("app.listings").set(set).where("id", "=", revision.listing_id).execute();
    }
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
