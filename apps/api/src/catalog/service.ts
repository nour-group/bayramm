// Публичные данные клиента: справочники, каталог, карточка площадки, тексты
// согласий. Всё читается под гостем (без актора): RLS отдаёт только активные
// листинги и их готовые одобренные фото — выдача одинакова для всех и не
// зависит от того, кто спрашивает.
//
// Правила выдачи (правила продукта):
//   · в каталоге — только активные листинги включённой категории с ценой,
//     вместимостью и не меньше чем 3 готовыми одобренными фото;
//   · guests отсекает площадки, где cap_max меньше; date не отсекает — занятые
//     в этот день (строка в app.availability) идут в конце при любой сортировке;
//   · порядок — только по цене или вместимости, затем по id. Оплата, премиум и
//     продвижение на порядок не влияют (их в v0.1 и нет);
//   · цены сравниваются на одной шкале, хотя у одних залов цена за гостя, у других —
//     за мероприятие (comparablePriceUzs в @bayramm/shared/api): с числом гостей —
//     примерная сумма на это число, без него — цена за гостя (цена за мероприятие,
//     делённая на cap_max с округлением вверх);
//   · телефон площадки отдаётся в карточке до заявки — pii.read_listing_phone:
//     у активного листинга он публичен.

import type {
  CatalogPage,
  CatalogSort,
  ClientConsentPurpose,
  ConsentText,
  ConsentTexts,
  Dictionaries,
  ListingCard,
  ListingDetail,
  ListingPackage,
  Locale,
  Photo,
} from "@bayramm/shared/api";
import { type NotNull, type RawBuilder, sql } from "kysely";
import { GUEST, type Tx, withActor } from "../db/actor";
import type { Db } from "../db/client";
import { addDays } from "../time";
import { type CatalogCursor, type CatalogParams, encodeCursor } from "./query";

/** Правило продукта «Фото обязательны»: меньше трёх — не публикуется */
export const MIN_PUBLIC_PHOTOS = 3;
/** Сколько дней вперёд карточка отдаёт занятые даты */
export const BUSY_DAYS_AHEAD = 180;

export const CLIENT_CONSENT_PURPOSES: readonly ClientConsentPurpose[] = [
  "client_service",
  "request_transfer",
  "bot_notifications",
];

// ── справочники ────────────────────────────────────────────────────────────

export async function getDictionaries(db: Db): Promise<Dictionaries> {
  return withActor(db, GUEST, async (trx) => {
    const categories = await trx
      .selectFrom("app.categories")
      .select(["code", "name_ru", "name_uz"])
      .where("enabled", "=", true)
      .orderBy("sort")
      .orderBy("code")
      .execute();
    const districts = await trx
      .selectFrom("app.districts")
      .select(["code", "name_ru", "name_uz"])
      .orderBy("sort")
      .orderBy("code")
      .execute();
    const occasions = await trx
      .selectFrom("app.occasions")
      .select(["code", "name_ru", "name_uz"])
      .orderBy("sort")
      .orderBy("code")
      .execute();
    const item = (r: { code: string; name_ru: string; name_uz: string }) => ({
      code: r.code,
      name: { ru: r.name_ru, uz: r.name_uz },
    });
    return {
      categories: categories.map(item),
      districts: districts.map(item),
      occasions: occasions.map(item),
    } satisfies Dictionaries;
  });
}

// ── тексты согласий ────────────────────────────────────────────────────────

/** Действующие тексты целей клиента: опубликован, не выведен; из нескольких — старшая версия */
export async function getConsentTexts(db: Db, locale: Locale | null): Promise<ConsentTexts> {
  const rows = await withActor(db, GUEST, (trx) =>
    trx
      .selectFrom("app.consent_texts as t")
      .distinctOn(["t.purpose", "t.locale"])
      .select(["t.id", "t.purpose", "t.version", "t.locale", "t.body"])
      .where("t.purpose", "in", CLIENT_CONSENT_PURPOSES)
      .where("t.published_at", "<=", sql<Date>`now()`)
      .where((eb) => eb.or([eb("t.retired_at", "is", null), eb("t.retired_at", ">", sql<Date>`now()`)]))
      .$if(locale !== null, (qb) => qb.where("t.locale", "=", locale as Locale))
      .orderBy("t.purpose")
      .orderBy("t.locale")
      .orderBy("t.version", "desc")
      .execute(),
  );
  const items = rows.map(
    (r) =>
      ({
        id: r.id,
        purpose: r.purpose as ClientConsentPurpose,
        version: r.version,
        locale: r.locale,
        body: r.body,
      }) satisfies ConsentText,
  );
  return { items } satisfies ConsentTexts;
}

// ── каталог ────────────────────────────────────────────────────────────────

/**
 * Сравнимая цена в SQL — то же, что comparablePriceUzs из @bayramm/shared/api:
 * с гостями — цена за гостя × гости или цена за мероприятие как есть; без гостей —
 * цена за гостя или цена за мероприятие / cap_max вверх (целочисленно: (p + c − 1) / c).
 * Целое bigint: 1e11 сумов × 5000 гостей помещается и в bigint, и в курсор
 */
function comparablePrice(guests: number | null): RawBuilder<string> {
  if (guests !== null) {
    return sql<string>`(case when l.price_unit = 'per_guest' then l.price_from_uzs * ${guests}::bigint else l.price_from_uzs end)`;
  }
  return sql<string>`(case when l.price_unit = 'per_guest' then l.price_from_uzs else (l.price_from_uzs + l.cap_max - 1) / l.cap_max end)`;
}

// Ключ сортировки — всегда по возрастанию: «дороже» и «больше мест» — минус
// сравнимая цена и минус вместимость. Так курсор — одно сравнение строк (занята, ключ, id)
export function sortKey(sort: CatalogSort, guests: number | null): RawBuilder<string> {
  switch (sort) {
    case "price_asc":
      return comparablePrice(guests);
    case "price_desc":
      return sql<string>`(-${comparablePrice(guests)})`;
    case "capacity_desc":
      return sql<string>`(-l.cap_max)::bigint`;
  }
}

// Занята ли площадка в день date: строка app.availability присоединяется
// левым соединением по (листинг, день); без даты не присоединяется ничего
const BUSY = sql<boolean>`(av.listing_id is not null)`;

/**
 * Опубликованные листинги с полями карточки и обложкой. Обложка — фото с
 * is_cover, иначе первое по sort; photo_count — число готовых одобренных фото.
 */
function publicListings(trx: Tx, date: string | null) {
  return trx
    .selectFrom("app.listings as l")
    .innerJoin("app.categories as cat", (j) =>
      j.onRef("cat.code", "=", "l.category_code").on("cat.enabled", "=", true),
    )
    .innerJoinLateral(
      (eb) =>
        eb
          .selectFrom("app.photos as p")
          .select([
            "p.storage_key",
            "p.width",
            "p.height",
            sql<number>`(count(*) over ())::int`.as("photo_count"),
          ])
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
    .leftJoin("app.availability as av", (j) =>
      j.onRef("av.listing_id", "=", "l.id").on(sql<boolean>`av.day = ${date}::date`),
    )
    .select([
      "l.id",
      "l.slug",
      "l.name",
      "l.category_code",
      "l.district_code",
      "l.price_from_uzs",
      "l.price_unit",
      "l.cap_min",
      "l.cap_max",
      "cv.storage_key as cover_key",
      "cv.width as cover_width",
      "cv.height as cover_height",
      "cv.photo_count",
      BUSY.as("busy"),
    ])
    .where("l.status", "=", "active")
    .where("l.price_from_uzs", "is not", null)
    .where("l.cap_max", "is not", null)
    .where("cv.photo_count", ">=", MIN_PUBLIC_PHOTOS)
    .$narrowType<{ price_from_uzs: NotNull; cap_max: NotNull }>();
}

interface CardRow {
  id: string;
  slug: string;
  name: string;
  category_code: string;
  district_code: string | null;
  price_from_uzs: string;
  price_unit: ListingCard["priceUnit"];
  cap_min: number | null;
  cap_max: number;
  cover_key: string;
  cover_width: number | null;
  cover_height: number | null;
  photo_count: number;
  busy: boolean;
}

function photo(key: string, width: number | null, height: number | null): Photo | null {
  // У готового фото размеры известны (photos_ready_file); без них карточке нечего показать
  if (width === null || height === null) return null;
  return { key, width, height };
}

function toCard(row: CardRow, date: string | null): ListingCard {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    categoryCode: row.category_code,
    districtCode: row.district_code,
    priceFromUzs: Number(row.price_from_uzs),
    priceUnit: row.price_unit,
    capMin: row.cap_min,
    capMax: row.cap_max,
    cover: photo(row.cover_key, row.cover_width, row.cover_height),
    photoCount: row.photo_count,
    busyOnDate: date === null ? null : row.busy,
  } satisfies ListingCard;
}

/** GET /catalog/listings: страница выдачи и курсор следующей (null — последняя) */
export async function listCatalog(db: Db, params: CatalogParams): Promise<CatalogPage> {
  const { category, district, date, guests, sort, limit, after } = params;
  const key = sortKey(sort, guests);
  const rows = await withActor(db, GUEST, (trx) =>
    publicListings(trx, date)
      .select(key.as("sort_key"))
      .$if(category !== null, (qb) => qb.where("l.category_code", "=", category as string))
      .$if(district !== null, (qb) => qb.where("l.district_code", "=", district as string))
      .$if(guests !== null, (qb) => qb.where("l.cap_max", ">=", guests as number))
      .$if(after !== null, (qb) => qb.where(afterCursor(key, after as CatalogCursor)))
      .orderBy(BUSY)
      .orderBy(key)
      .orderBy("l.id")
      .limit(limit + 1)
      .execute(),
  );

  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor =
    rows.length > limit && last !== undefined
      ? encodeCursor({ sort, date, guests, busy: last.busy, key: Number(last.sort_key), id: last.id })
      : null;
  return { items: page.map((row) => toCard(row, date)), nextCursor } satisfies CatalogPage;
}

// Строго после курсора в порядке (занята, ключ, id): false < true, как в ORDER BY
function afterCursor(key: RawBuilder<string>, c: CatalogCursor) {
  return sql<boolean>`(${BUSY}, ${key}, l.id) > (${c.busy}::boolean, ${c.key}::bigint, ${c.id}::uuid)`;
}

// ── карточка площадки ──────────────────────────────────────────────────────

/**
 * GET /catalog/listings/:slug — карточка опубликованного листинга; null — нет
 * такого или он не опубликован. today — «сегодня» по Ташкенту (от него
 * занятые даты на BUSY_DAYS_AHEAD дней вперёд).
 */
export async function getListingDetail(
  db: Db,
  slug: string,
  date: string | null,
  today: string,
): Promise<ListingDetail | null> {
  return withActor(db, GUEST, async (trx) => {
    const row = await publicListings(trx, date)
      .select([
        "l.description_ru",
        "l.description_uz",
        "l.address_ru",
        "l.address_uz",
        // Телефон активного листинга публичен (правило «телефон виден сразу»)
        sql<string | null>`pii.read_listing_phone(l.id)`.as("phone"),
      ])
      .where("l.slug", "=", slug)
      .executeTakeFirst();
    if (row === undefined) return null;
    if (row.phone === null) {
      // Опубликовать листинг без телефона база не даёт (listing_publish_blockers)
      console.error("catalog: active listing without public phone", { listingId: row.id });
      return null;
    }

    const packages = await trx
      .selectFrom("app.listing_packages")
      .select(["kind", "name_ru", "name_uz", "price_uzs", "price_unit"])
      .where("listing_id", "=", row.id)
      .orderBy("sort")
      .orderBy("kind")
      .orderBy("created_at")
      .execute();
    const photos = await trx
      .selectFrom("app.photos")
      .select(["storage_key", "width", "height"])
      .where("listing_id", "=", row.id)
      .where("deleted_at", "is", null)
      .where("status", "=", "ready")
      .where("moderation", "=", "approved")
      .orderBy("is_cover", "desc")
      .orderBy("sort")
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    const busy = await trx
      .selectFrom("app.availability")
      .select("day")
      .where("listing_id", "=", row.id)
      .where("day", ">=", today)
      .where("day", "<", addDays(today, BUSY_DAYS_AHEAD))
      .orderBy("day")
      .execute();

    return {
      ...toCard(row, date),
      description: { ru: row.description_ru ?? "", uz: row.description_uz ?? "" },
      address: { ru: row.address_ru ?? "", uz: row.address_uz ?? "" },
      packages: packages.map(
        (p) =>
          ({
            kind: p.kind,
            name: { ru: p.name_ru, uz: p.name_uz },
            priceUzs: Number(p.price_uzs),
            priceUnit: p.price_unit,
          }) satisfies ListingPackage,
      ),
      photos: photos.flatMap((p) => photo(p.storage_key, p.width, p.height) ?? []),
      phone: row.phone,
      busyDates: busy.map((b) => b.day),
    } satisfies ListingDetail;
  });
}
