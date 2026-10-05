// Публичные данные клиента: справочники, категории, каталог, карточка витрины, тексты
// согласий. Всё читается под гостем (без актора): RLS отдаёт только активные
// листинги, их готовые одобренные фото и одобренные услуги — выдача одинакова для
// всех и не зависит от того, кто спрашивает.
//
// Правила выдачи (правила продукта):
//   · в каталоге — только активные витрины включённой категории с ценой «от» (из
//     одобренных услуг), вместимостью — если категория её требует (залы) — и не
//     меньше чем минимум фото категории (не меньше 3) готовых одобренных фото;
//   · без category — залы, как в v0.1; category=all — все включённые категории; фильтры по
//     полям витрины (a.*) — из конфигурации категории, значения — параметрами запроса (@>,
//     jsonb_path_exists);
//   · guests отсекает витрины, где cap_max меньше (у категорий без вместимости — нет);
//     date не отсекает — занятые в этот день целиком идут в конце при любой сортировке,
//     частично занятые (режим parts) — среди свободных, с пометкой;
//   · порядок — только по цене или вместимости, затем по id. Оплата, премиум и
//     продвижение на порядок не влияют (их и нет);
//   · цены сравниваются на одной шкале, хотя у одних залов цена за гостя, у других —
//     за мероприятие (comparablePriceUzs в @bayramm/shared/api): с числом гостей —
//     примерная сумма на это число, без него — цена за гостя (цена за мероприятие,
//     делённая на cap_max с округлением вверх); без вместимости — цена как есть;
//   · контакты витрины (телефон, Telegram) — по кнопке «Связаться», до заявки и без входа:
//     POST …/contact (revealListingContacts в db/pii — с событием «открыли»); в карточке —
//     только какие каналы есть (listingContactKinds).

import type {
  BusyParts,
  CatalogCategories,
  CatalogPage,
  CatalogSort,
  ClientConsentPurpose,
  ConsentText,
  ConsentTexts,
  DateLoad,
  DayPart,
  Dictionaries,
  ListingCard,
  ListingDetail,
  Locale,
  Photo,
  PublicService,
} from "@bayramm/shared/api";
import { type AttributeFilter, categoryConfig, readAttributes } from "@bayramm/shared/categories";
import { type RawBuilder, sql } from "kysely";
import { GUEST, type Tx, withActor } from "../db/actor";
import type { Db } from "../db/client";
import { type ListingContactValues, listingContactKinds, revealListingContacts } from "../db/pii";
import { type ServiceRow, selectServices, serviceView } from "../listing-services/store";
import { addDays } from "../time";
import { ALL_CATEGORIES, type CatalogCursor, type CatalogParams, encodeCursor } from "./query";

/** Правило продукта «Фото обязательны»: меньше трёх — не публикуется (у категории бывает больше) */
export const MIN_PUBLIC_PHOTOS = 3;
/**
 * Сколько дней вперёд карточка отдаёт занятые даты: весь срок, на который клиент выбирает дату в
 * каталоге и календаре витрины (DATE_HORIZON_DAYS = 365 в apps/web, включительно). Короче —
 * и каталог сказал бы «занято», а витрина на тот же день — «свободно». Дальше (форма заявки
 * пускает до двух лет) занятость сверяет сервер при подаче (date_busy). app.listing_busy
 * принимает не больше 400 дней
 */
export const BUSY_DAYS_AHEAD = 366;

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
 * с гостями — цена за гостя × гости, остальное как есть; без гостей — цена за гостя,
 * цена за мероприятие / cap_max вверх (целочисленно: (p + c − 1) / c), если вместимость
 * есть, иначе как есть. Целое bigint: 1e11 сумов × 5000 гостей помещается и в bigint, и в курсор
 */
function comparablePrice(guests: number | null): RawBuilder<string> {
  if (guests !== null) {
    return sql<string>`(case when l.price_unit = 'per_guest' then l.price_from_uzs * ${guests}::bigint else l.price_from_uzs end)`;
  }
  return sql<string>`(case when l.price_unit = 'per_event' and l.cap_max is not null then (l.price_from_uzs + l.cap_max - 1) / l.cap_max else l.price_from_uzs end)`;
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
      return sql<string>`(-coalesce(l.cap_max, 0))::bigint`;
  }
}

/**
 * Откуда загрузка на дату (free | partial | busy): у выдачи категории — одним запросом на
 * всю категорию (app.catalog_day_load, соединение dl), у одной карточки —
 * app.listing_day_load. Без даты — не считается. Занятые целиком идут в конце выдачи
 */
type DayLoadSource = { readonly date: null } | { readonly date: string; readonly category: string | null };

const NO_DATE: DayLoadSource = { date: null };

interface DayLoadRow {
  listing_id: string;
  load: DateLoad;
}

/**
 * Загрузка витрин категории на дату; «all» — по каждой включённой категории тем же запросом
 * (app.catalog_day_load на категорию); без категории — пустое соединение
 */
function dayLoadRelation(source: DayLoadSource): RawBuilder<DayLoadRow> {
  if (source.date === null || source.category === null)
    return sql<DayLoadRow>`(select null::uuid as listing_id, null::text as load where false)`;
  if (source.category === ALL_CATEGORIES)
    return sql<DayLoadRow>`(select d.listing_id, d.load from app.categories c
      cross join lateral app.catalog_day_load(c.code, ${source.date}::date) d where c.enabled)`;
  return sql<DayLoadRow>`app.catalog_day_load(${source.category}, ${source.date}::date)`;
}

function loadOn(source: DayLoadSource): RawBuilder<DateLoad> {
  if (source.date === null) return sql<DateLoad>`'free'::text`;
  if (source.category === null) return sql<DateLoad>`app.listing_day_load(l.id, ${source.date}::date)`;
  return sql<DateLoad>`coalesce(dl.load, 'free')`;
}

/** Занята ли витрина целиком на дату; без даты — нет */
function busyOn(source: DayLoadSource): RawBuilder<boolean> {
  if (source.date === null) return sql<boolean>`false::boolean`;
  if (source.category === null)
    return sql<boolean>`(app.listing_day_load(l.id, ${source.date}::date) = 'busy')`;
  return sql<boolean>`coalesce(dl.load = 'busy', false)`;
}

/**
 * Опубликованные витрины с полями карточки и обложкой. Обложка — фото с is_cover,
 * иначе первое по sort (частичный индекс photos_public); photo_count — число готовых
 * одобренных фото
 */
function publicListings(trx: Tx, source: DayLoadSource) {
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
    .leftJoin(dayLoadRelation(source).as("dl"), (j) => j.onRef("dl.listing_id", "=", "l.id"))
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
      busyOn(source).as("busy"),
      loadOn(source).as("load"),
    ])
    .where("l.status", "=", "active")
    .where("l.price_from_uzs", "is not", null)
    .where(sql<boolean>`(l.cap_max is not null or not 'guest_capacity' = any (cat.required_fields))`)
    .where(sql<boolean>`cv.photo_count >= greatest(${MIN_PUBLIC_PHOTOS}, cat.min_photos)`)
    .$narrowType<{ price_from_uzs: string }>();
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
  cap_max: number | null;
  cover_key: string;
  cover_width: number | null;
  cover_height: number | null;
  photo_count: number;
  busy: boolean;
  load: DateLoad;
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
    dateLoad: date === null ? null : row.load,
  } satisfies ListingCard;
}

// JSONPath поля витрины: ключи — из конфигурации категории ([a-z0-9_]), в кавычках
const jsonPath = (path: readonly string[]) =>
  path.length === 1 ? `$."${path[0]}"` : `$."${path[0]}"[*]."${path[1]}"`;

/**
 * Фильтр по полю витрины. Значения — параметрами запроса: bool и enum/multi верхнего уровня —
 * вхождение (@>, индекс listings_attributes), числа и записи списков — jsonb_path_exists
 */
export function attributeFilter(filter: AttributeFilter): RawBuilder<boolean> {
  const [key = "", sub] = filter.path;
  const contains = (value: unknown) =>
    sql<boolean>`l.attributes @> ${JSON.stringify({ [key]: value })}::jsonb`;
  const path = (predicate: string, vars: Record<string, unknown>) =>
    sql<boolean>`jsonb_path_exists(l.attributes, ${`${jsonPath(filter.path)} ? (${predicate})`}::jsonpath, ${JSON.stringify(vars)}::jsonb)`;

  if (sub === undefined) {
    switch (filter.kind) {
      case "eq":
        return contains(true);
      case "all":
        return contains(filter.values);
      case "any":
        return sql<boolean>`(${sql.join(
          filter.values.map((v) => contains(filter.multi ? [v] : v)),
          sql` or `,
        )})`;
      case "min":
        return path("@ >= $n", { n: filter.value });
      case "max":
        return path("@ <= $n", { n: filter.value });
    }
  }
  switch (filter.kind) {
    case "eq":
      return path("@ == true", {});
    case "any":
      return path("@ == $v[*]", { v: filter.values });
    case "all":
      return sql<boolean>`(${sql.join(
        filter.values.map((v) => path("@ == $v", { v })),
        sql` and `,
      )})`;
    case "min":
      return path("@ >= $n", { n: filter.value });
    case "max":
      return path("@ <= $n", { n: filter.value });
  }
}

/** GET /catalog/listings: страница выдачи и курсор следующей (null — последняя) */
export async function listCatalog(db: Db, params: CatalogParams): Promise<CatalogPage> {
  const { category, filters, district, date, guests, sort, limit, after } = params;
  const key = sortKey(sort, guests);
  const source: DayLoadSource = date === null ? NO_DATE : { date, category };
  const busy = busyOn(source);
  const rows = await withActor(db, GUEST, (trx) =>
    publicListings(trx, source)
      .select(key.as("sort_key"))
      .$if(category !== ALL_CATEGORIES, (qb) => qb.where("l.category_code", "=", category))
      .$if(district !== null, (qb) => qb.where("l.district_code", "=", district as string))
      .$if(guests !== null, (qb) =>
        qb.where(sql<boolean>`(l.cap_max is null or l.cap_max >= ${guests as number})`),
      )
      .$if(filters.length > 0, (qb) =>
        qb.where(sql<boolean>`(${sql.join(filters.map(attributeFilter), sql` and `)})`),
      )
      .$if(after !== null, (qb) => qb.where(afterCursor(busy, key, after as CatalogCursor)))
      .orderBy(busy)
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

/**
 * Карточки опубликованных листингов по id — в порядке ids, без занятости на дату.
 * Неопубликованных и несуществующих нет: для избранного это «площадка пропала без
 * ошибки». Читает под актором транзакции: гость (GET /catalog/cards) или клиент
 * (избранное) — RLS отдаёт обоим одно и то же
 */
export async function listingCards(trx: Tx, ids: readonly string[]): Promise<ListingCard[]> {
  if (ids.length === 0) return [];
  const rows = await publicListings(trx, NO_DATE)
    .where("l.id", "in", [...ids])
    .execute();
  const byId = new Map(rows.map((row) => [row.id, toCard(row, null)]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/** GET /catalog/cards: карточки по id — под гостем, как вся выдача */
export function getListingCards(db: Db, ids: readonly string[]): Promise<ListingCard[]> {
  return withActor(db, GUEST, (trx) => listingCards(trx, ids));
}

// Строго после курсора в порядке (занята, ключ, id): false < true, как в ORDER BY
function afterCursor(busy: RawBuilder<boolean>, key: RawBuilder<string>, c: CatalogCursor) {
  return sql<boolean>`(${busy}, ${key}, l.id) > (${c.busy}::boolean, ${c.key}::bigint, ${c.id}::uuid)`;
}

// ── категории ──────────────────────────────────────────────────────────────

/**
 * GET /catalog/categories: включённые категории по порядку показа и сколько в каждой
 * опубликованных витрин — по тем же правилам, что выдача
 */
export async function listCatalogCategories(db: Db): Promise<CatalogCategories> {
  return withActor(db, GUEST, async (trx) => {
    const categories = await trx
      .selectFrom("app.categories")
      .select(["code", "name_ru", "name_uz"])
      .where("enabled", "=", true)
      .orderBy("sort")
      .orderBy("code")
      .execute();
    const counts = await trx
      .selectFrom(publicListings(trx, NO_DATE).as("pl"))
      .select(["pl.category_code", sql<number>`count(*)::int`.as("n")])
      .groupBy("pl.category_code")
      .execute();
    const byCode = new Map(counts.map((row) => [row.category_code, row.n]));
    return {
      items: categories.map((c) => ({
        code: c.code,
        name: { ru: c.name_ru, uz: c.name_uz },
        listings: byCode.get(c.code) ?? 0,
      })),
    } satisfies CatalogCategories;
  });
}

// ── карточка площадки ──────────────────────────────────────────────────────

/** Одобренные услуги витрины для клиента */
export async function publicServices(trx: Tx, listingId: string): Promise<PublicService[]> {
  const rows = await selectServices(trx)
    .where("s.listing_id", "=", listingId)
    .where("s.status", "=", "active")
    .orderBy("s.sort")
    .orderBy("s.created_at")
    .orderBy("s.id")
    .execute();
  return rows.map((raw) => {
    const s = serviceView(raw as ServiceRow);
    return {
      id: s.id,
      type: s.type,
      name: s.name,
      priceUzs: s.priceUzs,
      priceUnit: s.priceUnit,
      minQty: s.minQty,
      leadDays: s.leadDays,
      includes:
        s.includes === null
          ? null
          : { ru: s.includes.ru ?? s.includes.uz ?? "", uz: s.includes.uz ?? s.includes.ru ?? "" },
      options: s.options,
    } satisfies PublicService;
  });
}

/** Занятость витрины [from, to): целиком занятые даты и частично занятые (части дня) */
export async function busyCalendar(
  trx: Tx,
  listingId: string,
  from: string,
  to: string,
): Promise<{ busyDates: string[]; busyParts: BusyParts[] }> {
  const { rows } = await sql<{ day: string; parts: string[] }>`
    select b.day::text as day, b.parts from app.listing_busy(${listingId}::uuid, ${from}::date, ${to}::date) b
  `.execute(trx);
  const busyDates: string[] = [];
  const busyParts: BusyParts[] = [];
  for (const row of rows) {
    const parts = Array.isArray(row.parts) ? row.parts : [];
    if (parts.includes("all")) busyDates.push(row.day);
    else busyParts.push({ date: row.day, parts: parts as DayPart[] });
  }
  return { busyDates, busyParts };
}

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
    const row = await publicListings(trx, date === null ? NO_DATE : { date, category: null })
      .select([
        "l.description_ru",
        "l.description_uz",
        "l.address_ru",
        "l.address_uz",
        "l.attributes",
        "l.video_links",
        "l.parallel_capacity",
        // Какие контакты есть — без самих значений: они по «Связаться» (POST …/contact)
        listingContactKinds("l.id").as("contact_channels"),
      ])
      .where("l.slug", "=", slug)
      .executeTakeFirst();
    if (row === undefined) return null;
    if (!row.contact_channels.includes("phone")) {
      // Опубликовать листинг без телефона база не даёт (listing_publish_blockers)
      console.error("catalog: active listing without public phone", { listingId: row.id });
      return null;
    }

    const category = categoryConfig(row.category_code);
    const services = await publicServices(trx, row.id);
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
    const busy = await busyCalendar(trx, row.id, today, addDays(today, BUSY_DAYS_AHEAD));

    return {
      ...toCard(row, date),
      description: { ru: row.description_ru ?? "", uz: row.description_uz ?? "" },
      address: { ru: row.address_ru ?? "", uz: row.address_uz ?? "" },
      attributes: category === undefined ? {} : readAttributes(category, row.attributes),
      videoLinks: row.video_links,
      services,
      parallelCapacity: row.parallel_capacity,
      photos: photos.flatMap((p) => photo(p.storage_key, p.width, p.height) ?? []),
      contactChannels: row.contact_channels,
      busyDates: busy.busyDates,
      busyParts: busy.busyParts,
    } satisfies ListingDetail;
  });
}

// ── контакты витрины ───────────────────────────────────────────────────────

/**
 * POST /catalog/listings/:slug/contact { action: "open" }: контакты опубликованной витрины и
 * событие «открыли» (без клиента); null — нет такой опубликованной
 */
export function openListingContacts(
  db: Db,
  slug: string,
  source: "tma" | "web",
  signedIn: boolean,
): Promise<ListingContactValues | null> {
  return withActor(db, GUEST, async (trx) => {
    const listing = await trx
      .selectFrom("app.listings")
      .select("id")
      .where("slug", "=", slug)
      .where("status", "=", "active")
      .executeTakeFirst();
    return listing === undefined ? null : revealListingContacts(trx, listing.id, source, signedIn);
  });
}

/**
 * { action: "phone" | "telegram" }: клиент выбрал канал — событие без клиента. false — нет такой
 * опубликованной витрины
 */
export function recordContactChoice(
  db: Db,
  slug: string,
  channel: "phone" | "telegram",
  source: "tma" | "web",
  signedIn: boolean,
): Promise<boolean> {
  return withActor(db, GUEST, async (trx) => {
    const { rows } = await sql<{ recorded: boolean }>`
      select app.record_contact_event(l.id, ${channel}::text, ${source}::text, ${signedIn}::boolean) as recorded
      from app.listings l where l.slug = ${slug} and l.status = 'active'
    `.execute(trx);
    return rows[0]?.recorded === true;
  });
}
