// Демо-витрины staging (venues.ts): три зала и по две витрины в каждой другой включённой
// категории — заполнить и убрать. Всё — под актором system.
//
// seed — идемпотентно: чего нет, то заводится, что есть — не трогается; повторный
// прогон ничего не меняет. Все залы за раз или один (venue — номер зала с 1): workflow
// заводит их по одному, чтобы запрос к воркеру оставался коротким. Путь тот же, что у
// панели оператора, и те же правила базы:
//   1. вендор (название, форма, договор), реквизиты и контакт, чек-лист проверки —
//      setChecklistItem, как кнопки панели (согласие ПДн — по действующему тексту);
//   2. витрина черновиком в своей категории, поля витрины, услуги (сразу одобренные:
//      их заводит система), телефон для заявок, занятые дни и части дня (source vendor —
//      партнёр может снять их в кабинете). Календарь заполняется, только если у витрины
//      нет ни одной занятой даты с сегодняшнего: правки, сделанные на показе, повтор не
//      перетирает;
//   3. фото — addListingPhoto, как загрузка из панели: проверка байтов, Storage, строка;
//   4. публикация — applyListingAction: «На проверку», затем «Опубликовать». Готовность
//      (услуга с ценой, поля витрины, фото, телефон, чек-лист вендора) проверяет триггер базы;
//   5. в журнал действий — что изменилось по залу (без изменений — ничего).
//
// reset — сначала объекты фото в Storage (сбой — 503, база не тронута: повтор reset
// доделает), затем строки одной функцией базы app.demo_purge(): демо-вендоры целиком,
// с заявками на их карточки. Запись в журнал делает сама функция.

import { categoryTexts } from "@bayramm/shared/categories";
import { sql } from "kysely";
import { SYSTEM, type Tx, withActor } from "../db/actor";
import type { Db } from "../db/client";
import { saveListingPhone, saveVendorContacts } from "../db/pii";
import { ApiError, toApiError } from "../errors";
import { addListingPhoto } from "../photos/service";
import { applyListingAction } from "../staff/listings";
import { CHECKLIST_ITEMS, setChecklistItem } from "../staff/vendors";
import { type ObjectStorage, StorageError } from "../storage/supabase";
import { addDays, tashkentToday } from "../time";
import { DEMO_ID_PREFIX, DEMO_PHOTOS_PER_VENUE, DEMO_VENUES, type DemoVenue, demoContacts } from "./venues";

export interface DemoDeps {
  readonly db: Db;
  readonly storage: ObjectStorage;
  /** «Сегодня» по Ташкенту; по умолчанию — сейчас */
  readonly today?: string;
}

export interface DemoSeedSummary {
  readonly mode: "seed";
  /** Демо-залов в наборе */
  readonly venues: number;
  /** Залов в этом вызове: все или один (venue) */
  readonly seeded: number;
  /** Из них опубликованы после вызова */
  readonly active: number;
  /** Заведено в этом вызове */
  readonly created: { vendors: number; listings: number; photos: number; busyDays: number };
  /** Опубликованы в этом вызове */
  readonly published: number;
}

/** Ответ app.demo_purge() */
export interface DemoPurged {
  readonly vendors: number;
  readonly listings: number;
  readonly photos: number;
  readonly requests: number;
  readonly vendorUsers: number;
}

export interface DemoResetSummary {
  readonly mode: "reset";
  readonly removed: DemoPurged;
  /** Удалено объектов фото из Storage */
  readonly storageObjects: number;
}

// Карточку отправляют на проверку из этих статусов (план «submit» панели)
const SUBMITTABLE = new Set(["lead", "draft", "rejected"]);
// …и публикуют из этих («publish»)
const PUBLISHABLE = new Set(["review", "suspended"]);

// ── seed ────────────────────────────────────────────────────────────────────

interface ListingState {
  readonly status: string;
  readonly version: number;
  /** Готовые фото, которые не удалены и не отклонены модератором */
  readonly photos: number;
}

async function listingState(trx: Tx, id: string): Promise<ListingState> {
  return trx
    .selectFrom("app.listings as l")
    .select([
      "l.status",
      "l.version",
      sql<number>`(select count(*)::int from app.photos p
                   where p.listing_id = l.id and p.deleted_at is null and p.status = 'ready'
                     and p.moderation <> 'declined')`.as("photos"),
    ])
    .where("l.id", "=", id)
    .executeTakeFirstOrThrow();
}

/** Вендор и его чек-лист. Возвращает: заведён ли вендор и сколько пунктов отмечено */
async function ensureVendor(trx: Tx, venue: DemoVenue): Promise<{ created: boolean; checked: number }> {
  const row = await trx
    .selectFrom("app.vendor_accounts")
    .select(["id", "contract_signed_at", "stir_verified_at", "contacts_confirmed_at", "pd_consent_signed_at"])
    .where("id", "=", venue.vendorId)
    .executeTakeFirst();
  if (row === undefined) {
    await trx
      .insertInto("app.vendor_accounts")
      .values({
        id: venue.vendorId,
        name: venue.vendorName,
        legal_form: "ooo",
        contract_no: venue.contractNo,
      })
      .execute();
    await saveVendorContacts(trx, venue.vendorId, demoContacts(venue));
  }
  const done = {
    contract: row?.contract_signed_at != null,
    stir: row?.stir_verified_at != null,
    contacts: row?.contacts_confirmed_at != null,
    pdConsent: row?.pd_consent_signed_at != null,
  };
  let checked = 0;
  for (const item of CHECKLIST_ITEMS) {
    if (done[item]) continue;
    await setChecklistItem(trx, venue.vendorId, item, true, null);
    checked++;
  }
  return { created: row === undefined, checked };
}

/** Витрина черновиком: поля витрины, услуги и телефон. true — заведена сейчас */
async function ensureListing(trx: Tx, venue: DemoVenue): Promise<boolean> {
  const row = await trx
    .selectFrom("app.listings")
    .select("id")
    .where("id", "=", venue.listingId)
    .executeTakeFirst();
  if (row !== undefined) return false;
  await trx
    .insertInto("app.listings")
    .values({
      id: venue.listingId,
      vendor_id: venue.vendorId,
      slug: venue.slug,
      category_code: venue.category,
      status: "draft",
      name: venue.name,
      district_code: venue.districtCode,
      address_ru: venue.addressRu,
      address_uz: venue.addressUz,
      description_ru: venue.descriptionRu,
      description_uz: venue.descriptionUz,
      cap_min: venue.capMin,
      cap_max: venue.capMax,
      parallel_capacity: venue.parallelCapacity,
      attributes: JSON.stringify(venue.attributes),
    })
    .execute();
  for (const [index, service] of venue.services.entries()) {
    await trx
      .insertInto("app.listing_services")
      .values({
        listing_id: venue.listingId,
        category_code: venue.category,
        service_type: service.type,
        // Систему никто не проверяет: демо-услуги сразу одобрены
        status: "active",
        name_ru: service.name?.ru ?? null,
        name_uz: service.name?.uz ?? null,
        price_uzs: service.priceUzs,
        price_unit: service.priceUnit,
        min_qty: service.minQty ?? null,
        lead_days: service.leadDays ?? null,
        includes_ru: service.includes?.ru ?? null,
        includes_uz: service.includes?.uz ?? null,
        options: JSON.stringify(
          (service.options ?? []).map((o, n) => {
            const name = categoryTexts(`opt_${o.code}` as Parameters<typeof categoryTexts>[0]);
            return {
              // Опции демо — с постоянными id: повтор seed даёт те же
              id: `${venue.listingId.slice(0, 24)}${String(index * 10 + n + 1).padStart(12, "0")}`,
              code: o.code,
              name_ru: name.ru,
              name_uz: name.uz,
              price_uzs: o.priceUzs,
              price_unit: o.priceUnit,
            };
          }),
        ),
        sort: index,
      })
      .execute();
  }
  await saveListingPhone(trx, venue.listingId, venue.phone);
  return true;
}

/**
 * Занятые дни и части дня — если с сегодняшнего нет ни одной отметки. Возвращает, сколько
 * поставлено
 */
async function ensureBusyDays(trx: Tx, venue: DemoVenue, today: string): Promise<number> {
  const future = await trx
    .selectFrom("app.availability")
    .select("day")
    .where("listing_id", "=", venue.listingId)
    .where("day", ">=", today)
    .union(
      trx
        .selectFrom("app.availability_parts")
        .select("day")
        .where("listing_id", "=", venue.listingId)
        .where("day", ">=", today),
    )
    .limit(1)
    .executeTakeFirst();
  if (future !== undefined) return 0;
  const rows = venue.busyDays.map((offset) => ({
    listing_id: venue.listingId,
    day: addDays(today, offset),
    source: "vendor",
  }));
  if (rows.length > 0) {
    await trx
      .insertInto("app.availability")
      .values(rows)
      .onConflict((oc) => oc.columns(["listing_id", "day"]).doNothing())
      .execute();
  }
  const parts = venue.busyParts.map((p) => ({
    listing_id: venue.listingId,
    day: addDays(today, p.offset),
    part: p.part,
    source: "vendor",
  }));
  if (parts.length > 0) {
    await trx
      .insertInto("app.availability_parts")
      .values(parts)
      .onConflict((oc) => oc.columns(["listing_id", "day", "part"]).doNothing())
      .execute();
  }
  return rows.length + parts.length;
}

/** Загружает недостающие фото зала из переданных. Возвращает, сколько загружено */
async function ensurePhotos(
  deps: DemoDeps,
  venue: DemoVenue,
  have: number,
  photos: readonly Uint8Array[],
): Promise<number> {
  const missing = DEMO_PHOTOS_PER_VENUE - have;
  let uploaded = 0;
  for (const bytes of photos) {
    if (uploaded >= missing) break;
    try {
      await addListingPhoto(deps, SYSTEM, venue.listingId, bytes, { ack: "no_faces" });
      uploaded++;
    } catch (err) {
      // Этот файл у зала уже есть (прошлый прогон оборвался после загрузки) — следующий
      if (toApiError(err).code !== "duplicate_photo") throw err;
    }
  }
  if (uploaded < missing) {
    throw new ApiError(422, "demo_photos_required", "Not enough photos to publish demo listings", [
      venue.slug,
    ]);
  }
  return uploaded;
}

interface VenueResult {
  readonly vendorCreated: boolean;
  readonly listingCreated: boolean;
  readonly photos: number;
  readonly busyDays: number;
  readonly published: boolean;
  readonly active: boolean;
}

async function seedVenue(
  deps: DemoDeps,
  venue: DemoVenue,
  photos: readonly Uint8Array[],
  today: string,
): Promise<VenueResult> {
  const base = await withActor(deps.db, SYSTEM, async (trx) => {
    const vendor = await ensureVendor(trx, venue);
    const listingCreated = await ensureListing(trx, venue);
    const busyDays = await ensureBusyDays(trx, venue, today);
    return { vendor, listingCreated, busyDays, state: await listingState(trx, venue.listingId) };
  });

  const uploaded =
    base.state.photos < DEMO_PHOTOS_PER_VENUE
      ? await ensurePhotos(deps, venue, base.state.photos, photos)
      : 0;

  const changed =
    base.vendor.created ||
    base.vendor.checked > 0 ||
    base.listingCreated ||
    base.busyDays > 0 ||
    uploaded > 0;
  if (base.state.status === "active" && !changed) {
    return {
      vendorCreated: false,
      listingCreated: false,
      photos: 0,
      busyDays: 0,
      published: false,
      active: true,
    };
  }

  const published = await withActor(deps.db, SYSTEM, async (trx) => {
    let { status, version } = await listingState(trx, venue.listingId);
    let publishedNow = false;
    if (SUBMITTABLE.has(status)) {
      version = await applyListingAction(trx, venue.listingId, "submit", version);
      status = "review";
    }
    if (PUBLISHABLE.has(status)) {
      await applyListingAction(trx, venue.listingId, "publish", version);
      publishedNow = true;
    }
    // Журнал: только коды и числа
    await trx
      .insertInto("app.audit_log")
      .values({
        action: "demo.seed",
        object_type: "listing",
        object_id: venue.listingId,
        source: "system",
        detail: {
          vendor_created: base.vendor.created,
          checklist_marked: base.vendor.checked,
          listing_created: base.listingCreated,
          photos: uploaded,
          busy_days: base.busyDays,
          published: publishedNow,
        },
      })
      .execute();
    return publishedNow;
  });

  return {
    vendorCreated: base.vendor.created,
    listingCreated: base.listingCreated,
    photos: uploaded,
    busyDays: base.busyDays,
    published,
    active: true,
  };
}

/**
 * Заводит демо-залы. Без venue — все: photos по DEMO_PHOTOS_PER_VENUE на зал, по порядку
 * залов. С venue (номер с 1) — только этот зал, photos — его. Фото нужны только залам,
 * у которых их ещё не хватает
 */
export async function seedDemo(
  deps: DemoDeps,
  photos: readonly Uint8Array[],
  venue?: number,
): Promise<DemoSeedSummary> {
  const today = deps.today ?? tashkentToday();
  const per = DEMO_PHOTOS_PER_VENUE;
  const targets =
    venue === undefined
      ? DEMO_VENUES.map((v, i) => ({ venue: v, photos: photos.slice(i * per, (i + 1) * per) }))
      : [{ venue: DEMO_VENUES[venue - 1], photos: photos.slice(0, per) }];

  const created = { vendors: 0, listings: 0, photos: 0, busyDays: 0 };
  let published = 0;
  let active = 0;
  for (const target of targets) {
    if (target.venue === undefined) throw new ApiError(422, "invalid_input", "Invalid input", ["venue"]);
    const result = await seedVenue(deps, target.venue, target.photos, today);
    created.vendors += Number(result.vendorCreated);
    created.listings += Number(result.listingCreated);
    created.photos += result.photos;
    created.busyDays += result.busyDays;
    published += Number(result.published);
    active += Number(result.active);
  }
  return { mode: "seed", venues: DEMO_VENUES.length, seeded: targets.length, active, created, published };
}

// ── reset ───────────────────────────────────────────────────────────────────

/** Убирает все демо-строки и их фото. Нечего убирать — нули */
export async function resetDemo(deps: DemoDeps): Promise<DemoResetSummary> {
  // Все фото демо-карточек — и удалённые из карточки, и незаконченные загрузки
  const keys = await withActor(deps.db, SYSTEM, (trx) =>
    trx
      .selectFrom("app.photos as p")
      .innerJoin("app.listings as l", "l.id", "p.listing_id")
      .select("p.storage_key")
      .where(sql<boolean>`${sql.ref("l.vendor_id")}::text like ${`${DEMO_ID_PREFIX}%`}`)
      .execute(),
  );

  for (const { storage_key } of keys) {
    try {
      await deps.storage.remove(storage_key);
    } catch (err) {
      console.error("demo.reset: storage failed", err instanceof StorageError ? err.reason : "unknown");
      throw new ApiError(503, "storage_unavailable", "Photo storage is temporarily unavailable");
    }
  }

  const removed = await withActor(deps.db, SYSTEM, async (trx) => {
    const { rows } = await sql<{ purged: DemoPurged }>`select app.demo_purge() as purged`.execute(trx);
    const purged = rows[0]?.purged;
    if (purged === undefined) throw new Error("app.demo_purge() не вернула результат");
    return purged;
  });
  return { mode: "reset", removed, storageObjects: keys.length };
}
