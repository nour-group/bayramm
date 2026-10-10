// Услуги витрины (app.listing_services): чтение, правка, модерация — общее для кабинета
// (vendor/services.ts) и панели (staff/services.ts). Контракт — @bayramm/shared/api/services.
//
// Кто что может, окончательно решает база (listing_services_guard, RLS): здесь —
// выбор шага и понятные ошибки до неё.
//   · decides — тот, кто решает по модерации (администратор, модератор): его услуги и
//     правки сразу одобрены;
//   · restricted — правка активной услуги только предложением: партнёр, когда карточка
//     на проверке или опубликована (review, active, suspended), менеджер — у опубликованной.
// Поля проверяет validateServiceInput из @bayramm/shared/categories — те же правила, что в
// формах кабинета и панели. Опции хранятся с id (UUID): на них ссылается заявка.

import type { Localized, PriceUnit, ServiceOption } from "@bayramm/shared/api";
import type { ListingService, ServiceChanges, ServiceStatus } from "@bayramm/shared/api/services";
import {
  type CategoryConfig,
  categoryConfig,
  categoryTexts,
  type LocalizedText,
  SERVICE_LIMITS,
  type ServiceValues,
  serviceType,
  validateServiceInput,
} from "@bayramm/shared/categories";
import { sql } from "kysely";
import type { Tx } from "../db/actor";
import type { AppListingStatus, Json } from "../db/schema.generated";
import { ApiError, notFound } from "../errors";

export const SERVICE_COLUMNS = [
  "s.id",
  "s.listing_id",
  "s.category_code",
  "s.service_type",
  "s.status",
  "s.name_ru",
  "s.name_uz",
  "s.price_uzs",
  "s.price_unit",
  "s.min_qty",
  "s.lead_days",
  "s.includes_ru",
  "s.includes_uz",
  "s.options",
  "s.proposal",
  "s.proposal_at",
  "s.decision",
  "s.decision_reason",
  "s.decided_at",
  "s.submitted_at",
  "s.sort",
  "s.updated_at",
] as const;

export interface ServiceRow {
  readonly id: string;
  readonly listing_id: string;
  readonly category_code: string;
  readonly service_type: string;
  readonly status: ServiceStatus;
  readonly name_ru: string | null;
  readonly name_uz: string | null;
  readonly price_uzs: string;
  readonly price_unit: PriceUnit;
  readonly min_qty: number | null;
  readonly lead_days: number | null;
  readonly includes_ru: string | null;
  readonly includes_uz: string | null;
  readonly options: Json;
  readonly proposal: Json | null;
  readonly proposal_at: Date | null;
  readonly decision: string | null;
  readonly decision_reason: string | null;
  readonly decided_at: Date | null;
  readonly submitted_at: Date | null;
  readonly sort: number;
  readonly updated_at: Date;
}

/** Витрина, к которой относится услуга: категория и статус решают, что можно */
export interface ServiceListing {
  readonly id: string;
  readonly category_code: string;
  readonly status: AppListingStatus;
}

/** Кто правит: решает ли по модерации и правит ли активные услуги только предложением */
export interface ServiceActor {
  readonly decides: boolean;
  readonly restricted: boolean;
}

export const invalidInput = (fields: string[]) =>
  new ApiError(422, "invalid_input", "Invalid input", [...new Set(fields)]);
const illegalTransition = (message: string) => new ApiError(409, "illegal_transition", message);
const noChanges = () => new ApiError(422, "no_changes", "Proposal does not change the service");

// ── чтение ──────────────────────────────────────────────────────────────────

type DbOption = {
  readonly id: string;
  readonly code?: string;
  readonly name_ru: string;
  readonly name_uz: string;
  readonly price_uzs: number;
  readonly price_unit: PriceUnit;
};

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Опции из базы (форму проверяет app.service_options_ok) */
function dbOptions(value: unknown): DbOption[] {
  return Array.isArray(value) ? (value.filter(isObject) as unknown as DbOption[]) : [];
}

function optionView(o: DbOption): ServiceOption {
  return {
    id: o.id,
    code: o.code ?? null,
    name: { ru: o.name_ru, uz: o.name_uz },
    priceUzs: Number(o.price_uzs),
    priceUnit: o.price_unit,
  };
}

function includesOf(ru: string | null, uz: string | null): LocalizedText | null {
  if (ru === null && uz === null) return null;
  return { ...(ru === null ? {} : { ru }), ...(uz === null ? {} : { uz }) };
}

/** Название услуги: у типа из каталога — его (конфигурация), у «другой услуги» — вендора */
export function serviceName(
  row: Pick<ServiceRow, "category_code" | "service_type" | "name_ru" | "name_uz">,
): Localized {
  if (row.name_ru !== null && row.name_uz !== null) return { ru: row.name_ru, uz: row.name_uz };
  const category = categoryConfig(row.category_code);
  const type = category === undefined ? undefined : serviceType(category, row.service_type);
  return type === undefined ? { ru: row.service_type, uz: row.service_type } : categoryTexts(type.label);
}

/** Предложение правки в полях контракта */
function changesView(proposal: Json | null): ServiceChanges {
  if (!isObject(proposal)) return {};
  const p = proposal;
  const out: { -readonly [K in keyof ServiceChanges]: ServiceChanges[K] } = {};
  if (typeof p.name_ru === "string" && typeof p.name_uz === "string")
    out.name = { ru: p.name_ru, uz: p.name_uz };
  if (p.price_uzs !== undefined) out.priceUzs = Number(p.price_uzs);
  if (typeof p.price_unit === "string") out.priceUnit = p.price_unit as PriceUnit;
  if ("min_qty" in p) out.minQty = (p.min_qty as number | null) ?? null;
  if ("lead_days" in p) out.leadDays = (p.lead_days as number | null) ?? null;
  if ("includes_ru" in p || "includes_uz" in p) {
    out.includes = includesOf(
      (p.includes_ru as string | null) ?? null,
      (p.includes_uz as string | null) ?? null,
    );
  }
  if ("options" in p) out.options = dbOptions(p.options).map(optionView);
  return out;
}

export function serviceView(row: ServiceRow): ListingService {
  return {
    id: row.id,
    type: row.service_type,
    status: row.status,
    name: serviceName(row),
    customName: row.name_ru !== null,
    priceUzs: Number(row.price_uzs),
    priceUnit: row.price_unit,
    minQty: row.min_qty,
    leadDays: row.lead_days,
    includes: includesOf(row.includes_ru, row.includes_uz),
    options: dbOptions(row.options).map(optionView),
    sort: row.sort,
    proposal:
      row.proposal === null || row.proposal_at === null
        ? null
        : { changes: changesView(row.proposal), submittedAt: row.proposal_at.toISOString() },
    decision:
      row.decision === null || row.decided_at === null
        ? null
        : {
            outcome: row.decision === "declined" ? "declined" : "approved",
            reason: row.decision_reason,
            at: row.decided_at.toISOString(),
          },
    submittedAt: row.submitted_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
  };
}

export function selectServices(trx: Tx) {
  return trx.selectFrom("app.listing_services as s").select(SERVICE_COLUMNS);
}

/** Услуги витрины по порядку (все, что видит актор транзакции) */
export async function listServices(trx: Tx, listingId: string): Promise<ListingService[]> {
  const rows = await selectServices(trx)
    .where("s.listing_id", "=", listingId)
    .orderBy("s.sort")
    .orderBy("s.created_at")
    .orderBy("s.id")
    .execute();
  return rows.map((row) => serviceView(row as ServiceRow));
}

/** Услуга этой витрины под блокировкой строки; нет — 404 */
async function lockService(trx: Tx, listingId: string, serviceId: string): Promise<ServiceRow> {
  const row = await selectServices(trx)
    .where("s.id", "=", serviceId)
    .where("s.listing_id", "=", listingId)
    .forUpdate()
    .executeTakeFirst();
  if (row === undefined) throw notFound();
  return row as ServiceRow;
}

async function reload(trx: Tx, serviceId: string): Promise<ListingService> {
  const row = await selectServices(trx).where("s.id", "=", serviceId).executeTakeFirstOrThrow();
  return serviceView(row as ServiceRow);
}

function configOf(listing: ServiceListing): CategoryConfig {
  const category = categoryConfig(listing.category_code);
  // Категория карточки — из базы, её коды — из той же конфигурации (сид миграции)
  if (category === undefined)
    throw new ApiError(500, "internal_error", `Unknown category ${listing.category_code}`);
  return category;
}

// ── значения → столбцы ──────────────────────────────────────────────────────

interface ServiceColumns {
  name_ru?: string | null;
  name_uz?: string | null;
  price_uzs?: number;
  price_unit?: PriceUnit;
  min_qty?: number | null;
  lead_days?: number | null;
  includes_ru?: string | null;
  includes_uz?: string | null;
  options?: DbOption[];
  sort?: number;
}

/** Проверенные поля → столбцы; новым опциям — новые id */
function columnsOf(values: ServiceValues): ServiceColumns {
  const out: ServiceColumns = {};
  if (values.name !== undefined) {
    out.name_ru = values.name?.ru ?? null;
    out.name_uz = values.name?.uz ?? null;
  }
  if (values.priceUzs !== undefined) out.price_uzs = values.priceUzs;
  if (values.priceUnit !== undefined) out.price_unit = values.priceUnit;
  if (values.minQty !== undefined) out.min_qty = values.minQty;
  if (values.leadDays !== undefined) out.lead_days = values.leadDays;
  if (values.includes !== undefined) {
    out.includes_ru = values.includes?.ru ?? null;
    out.includes_uz = values.includes?.uz ?? null;
  }
  if (values.options !== undefined) {
    out.options = values.options.map((o) => ({
      id: o.id ?? crypto.randomUUID(),
      ...(o.code === undefined ? {} : { code: o.code }),
      name_ru: o.name.ru,
      name_uz: o.name.uz,
      price_uzs: o.priceUzs,
      price_unit: o.priceUnit,
    }));
  }
  if (values.sort !== undefined) out.sort = values.sort;
  return out;
}

/** Столбцы для записи в базу: опции — строкой JSON (массив pg иначе отдал бы как массив Postgres) */
function dbValues(columns: ServiceColumns) {
  const { options, ...rest } = columns;
  return options === undefined ? rest : { ...rest, options: JSON.stringify(options) };
}

/** Только то, что отличается от услуги: так предложение показывает именно изменения */
function changedColumns(row: ServiceRow, columns: ServiceColumns): Record<string, unknown> {
  const current: Record<string, unknown> = {
    name_ru: row.name_ru,
    name_uz: row.name_uz,
    price_uzs: Number(row.price_uzs),
    price_unit: row.price_unit,
    min_qty: row.min_qty,
    lead_days: row.lead_days,
    includes_ru: row.includes_ru,
    includes_uz: row.includes_uz,
    options: dbOptions(row.options),
  };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(columns)) {
    if (key === "sort" || !(key in current)) continue;
    if (JSON.stringify(value) !== JSON.stringify(current[key])) out[key] = value;
  }
  // Название и «что входит» — парами: в предложении оба языка
  for (const [a, b] of [
    ["name_ru", "name_uz"],
    ["includes_ru", "includes_uz"],
  ] as const) {
    if (a in out || b in out) {
      out[a] = columns[a] === undefined ? current[a] : columns[a];
      out[b] = columns[b] === undefined ? current[b] : columns[b];
    }
  }
  return out;
}

function parse(category: CategoryConfig, input: unknown, typeCode?: string): ServiceValues {
  const result =
    typeCode === undefined
      ? validateServiceInput(category, input, { create: true })
      : validateServiceInput(category, input, { create: false, typeCode });
  if (!result.ok) throw invalidInput(result.errors);
  return result.value;
}

/** submit из тела: по умолчанию — отправить на проверку */
function submitFlag(input: unknown): { body: unknown; submit: boolean } {
  if (!isObject(input) || !("submit" in input)) return { body: input, submit: true };
  const { submit, ...body } = input;
  if (typeof submit !== "boolean") throw invalidInput(["submit"]);
  return { body, submit };
}

// ── правка ──────────────────────────────────────────────────────────────────

/** Новая услуга витрины: решающий — сразу одобрена, остальные — на проверку (или черновиком) */
export async function createService(
  trx: Tx,
  listing: ServiceListing,
  input: unknown,
  actor: ServiceActor,
): Promise<ListingService> {
  const category = configOf(listing);
  const { body, submit } = submitFlag(input);
  const values = parse(category, body);
  const { count } = await trx
    .selectFrom("app.listing_services")
    .select(sql<number>`count(*)::int`.as("count"))
    .where("listing_id", "=", listing.id)
    .executeTakeFirstOrThrow();
  if (count >= SERVICE_LIMITS.maxServices) {
    throw new ApiError(409, "too_many_services", "Service limit reached");
  }
  const status: ServiceStatus = !submit ? "draft" : actor.decides ? "active" : "review";
  const columns = columnsOf(values);
  const row = await trx
    .insertInto("app.listing_services")
    .values({
      listing_id: listing.id,
      category_code: listing.category_code,
      service_type: values.type as string,
      status,
      price_uzs: columns.price_uzs as number,
      price_unit: columns.price_unit as PriceUnit,
      ...dbValues({ ...columns, sort: columns.sort ?? count }),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return reload(trx, row.id);
}

/**
 * Правка услуги. Активная или снятая, если правят только предложением, — изменённые поля
 * уходят предложением (заменяют прежнее); иначе — сразу. Черновик и отклонённая уходят на
 * проверку, если submit не false; отклонённая с submit: false становится черновиком
 */
export async function updateService(
  trx: Tx,
  listing: ServiceListing,
  serviceId: string,
  input: unknown,
  actor: ServiceActor,
): Promise<ListingService> {
  const category = configOf(listing);
  const row = await lockService(trx, listing.id, serviceId);
  const { body, submit } = submitFlag(input);
  const values = parse(category, body, row.service_type);
  const columns = columnsOf(values);

  if (actor.restricted && (row.status === "active" || row.status === "paused")) {
    const changes = changedColumns(row, columns);
    if (Object.keys(changes).length === 0) throw noChanges();
    await trx
      .updateTable("app.listing_services")
      .set({
        proposal: JSON.stringify(changes),
        ...(columns.sort === undefined ? {} : { sort: columns.sort }),
      })
      .where("id", "=", row.id)
      .execute();
    return reload(trx, row.id);
  }

  let status: ServiceStatus = row.status;
  if (submit && (row.status === "draft" || row.status === "rejected"))
    status = actor.decides ? "active" : "review";
  // «Сохранить черновик» у отклонённой — и правда черновик: отказ остаётся в прошлом круге
  // (база стирает прежнее решение), а услуга не висит «отклонённой» после исправления
  else if (!submit && row.status === "rejected") status = "draft";
  await trx
    .updateTable("app.listing_services")
    .set({ ...dbValues(columns), ...(status === row.status ? {} : { status }) })
    .where("id", "=", row.id)
    .execute();
  return reload(trx, row.id);
}

/** Отправить на проверку: черновик, отклонённую или снятую (решающий — сразу на витрину) */
export async function submitService(
  trx: Tx,
  listing: ServiceListing,
  serviceId: string,
  actor: ServiceActor,
): Promise<ListingService> {
  const row = await lockService(trx, listing.id, serviceId);
  if (row.status !== "draft" && row.status !== "rejected" && row.status !== "paused") {
    throw illegalTransition("Service is not a draft, rejected or paused");
  }
  await trx
    .updateTable("app.listing_services")
    .set({ status: actor.decides ? "active" : "review" })
    .where("id", "=", row.id)
    .execute();
  return reload(trx, row.id);
}

/**
 * Отозвать: на проверке — обратно в черновик; с предложением — предложение отозвано;
 * активная — снята с витрины
 */
export async function withdrawService(
  trx: Tx,
  listing: ServiceListing,
  serviceId: string,
): Promise<ListingService> {
  const row = await lockService(trx, listing.id, serviceId);
  if (row.status === "review") {
    await trx.updateTable("app.listing_services").set({ status: "draft" }).where("id", "=", row.id).execute();
  } else if (row.proposal !== null) {
    await trx.updateTable("app.listing_services").set({ proposal: null }).where("id", "=", row.id).execute();
  } else if (row.status === "active") {
    await trx
      .updateTable("app.listing_services")
      .set({ status: "paused" })
      .where("id", "=", row.id)
      .execute();
  } else {
    throw illegalTransition("Nothing to withdraw");
  }
  return reload(trx, row.id);
}

/** Снять с витрины */
export async function pauseService(
  trx: Tx,
  listing: ServiceListing,
  serviceId: string,
): Promise<ListingService> {
  const row = await lockService(trx, listing.id, serviceId);
  if (row.status !== "active") throw illegalTransition("Service is not active");
  await trx.updateTable("app.listing_services").set({ status: "paused" }).where("id", "=", row.id).execute();
  return reload(trx, row.id);
}

export async function deleteService(trx: Tx, listing: ServiceListing, serviceId: string): Promise<void> {
  const row = await lockService(trx, listing.id, serviceId);
  await trx.deleteFrom("app.listing_services").where("id", "=", row.id).execute();
}

// ── модерация ───────────────────────────────────────────────────────────────

/** Предложение (столбцы базы) → поля формы — чтобы проверить их теми же правилами */
function proposalInput(proposal: Json | null): Record<string, unknown> {
  if (!isObject(proposal)) return {};
  const p = proposal;
  const out: Record<string, unknown> = {};
  if ("name_ru" in p || "name_uz" in p) out.name = { ru: p.name_ru, uz: p.name_uz };
  if ("price_uzs" in p) out.priceUzs = p.price_uzs;
  if ("price_unit" in p) out.priceUnit = p.price_unit;
  if ("min_qty" in p) out.minQty = p.min_qty;
  if ("lead_days" in p) out.leadDays = p.lead_days;
  if ("includes_ru" in p || "includes_uz" in p) {
    const ru = p.includes_ru ?? null;
    const uz = p.includes_uz ?? null;
    out.includes =
      ru === null && uz === null ? null : { ...(ru === null ? {} : { ru }), ...(uz === null ? {} : { uz }) };
  }
  if ("options" in p) {
    out.options = dbOptions(p.options).map((o) => ({
      id: o.id,
      ...(o.code === undefined ? {} : { code: o.code }),
      name: { ru: o.name_ru, uz: o.name_uz },
      priceUzs: o.price_uzs,
      priceUnit: o.price_unit,
    }));
  }
  return out;
}

/** Решение по услуге: новая — на витрину, предложение — применить к услуге */
export async function approveService(
  trx: Tx,
  listing: ServiceListing,
  serviceId: string,
): Promise<ListingService> {
  const category = configOf(listing);
  const row = await lockService(trx, listing.id, serviceId);
  const decided = { decision: "approved", decision_reason: null, decided_at: new Date() } as const;
  if (row.proposal !== null) {
    const result = validateServiceInput(category, proposalInput(row.proposal), {
      create: false,
      typeCode: row.service_type,
    });
    if (!result.ok)
      throw new ApiError(422, "service_invalid", "Proposal does not pass field checks", result.errors);
    await trx
      .updateTable("app.listing_services")
      .set({ ...dbValues(columnsOf(result.value)), proposal: null, ...decided })
      .where("id", "=", row.id)
      .execute();
  } else if (row.status === "review") {
    await trx
      .updateTable("app.listing_services")
      .set({ status: "active", ...decided })
      .where("id", "=", row.id)
      .execute();
  } else {
    throw illegalTransition("Service is not waiting for a decision");
  }
  return reload(trx, row.id);
}

/** Отказ: новая услуга — отклонена, предложение — отклонено (услуга остаётся как была) */
export async function declineService(
  trx: Tx,
  listing: ServiceListing,
  serviceId: string,
  reason: string,
): Promise<ListingService> {
  const row = await lockService(trx, listing.id, serviceId);
  const decided = { decision: "declined", decision_reason: reason, decided_at: new Date() } as const;
  if (row.proposal !== null) {
    await trx
      .updateTable("app.listing_services")
      .set({ proposal: null, ...decided })
      .where("id", "=", row.id)
      .execute();
  } else if (row.status === "review") {
    await trx
      .updateTable("app.listing_services")
      .set({ status: "rejected", ...decided })
      .where("id", "=", row.id)
      .execute();
  } else {
    throw illegalTransition("Service is not waiting for a decision");
  }
  return reload(trx, row.id);
}

/** Публикация карточки одобряет её услуги на проверке (как фото) */
export async function approveReviewServices(trx: Tx, listingId: string): Promise<void> {
  await trx
    .updateTable("app.listing_services")
    .set({ status: "active" })
    .where("listing_id", "=", listingId)
    .where("status", "=", "review")
    .execute();
}
