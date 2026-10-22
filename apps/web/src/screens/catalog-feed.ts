import {
  type CatalogPart,
  type CatalogQuery,
  type CatalogSort,
  defaultCatalogSort,
  type ListingCard,
} from "@bayramm/shared/api";
import { SEARCH_MAX_LENGTH, searchNorm, searchQuery } from "@bayramm/shared/search";
import { useOnReconnect } from "@bayramm/ui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { isAbort } from "../api/errors";
import type { ClientApi } from "../api/types";
import { CLIENT_CATEGORIES, hasCapacity, hasDistrict } from "../categories";
import { addDays, isIsoDate } from "../format";
import { ALL_CATEGORIES, hrefFor } from "../routes";
import { type AttrFilters, NO_ATTRS, readAttrFilters } from "./catalog-filters";

/* Фильтры каталога живут в адресе
   (?category=&q=&city=&district=&date=&part=&guests=&sort=&a.<поле>=): ссылка «похожие» из «Моих
   заявок», кнопки бота и «назад» из карточки возвращают ту же выдачу. Без category — все разделы
   одной выдачей («Все»). Место — везде, и в «Все»: город (его районы и выездные витрины без
   района) или район (он и выездные; город — его; район — только где он есть у витрин раздела). Гости — только где вместимость (залы, рестораны),
   порядок «вместительнее» — там же. Время (part) — только вместе с датой: свободные в эту часть
   дня или весь день. Поиск (q) — вместе с разделом и фильтрами; с ним порядок по умолчанию —
   «сначала подходящие» (relevance), а со словом о цене («недорогой зал») — сначала дешевле. В «Все»
   цены разных разделов не сравнить: там порядок — по разделам (section), по цене — только в разделе. */

export const SORTS = ["price_asc", "price_desc", "capacity_desc"] as const satisfies readonly CatalogSort[];

/** Порядок с поиском: сначала подходящие */
export const SEARCH_SORT = "relevance" satisfies CatalogSort;
/** Порядок «Все»: по разделам */
export const SECTION_SORT = "section" satisfies CatalogSort;

/** Порядок по умолчанию этих фильтров — как решает сервер (defaultCatalogSort). В адресе его не пишем */
export const defaultSortOf = (filters: Pick<CatalogFilters, "q" | "category">): CatalogSort =>
  defaultCatalogSort(filters.category, filters.q === null ? null : searchQuery(filters.q));

export const MAX_GUESTS = 5000;
/** Насколько вперёд можно выбрать дату */
export const DATE_HORIZON_DAYS = 365;
export const PAGE_SIZE = 20;
/** Фильтр «Время» на дату */
export const CATALOG_PARTS = ["morning", "day", "evening", "whole"] as const satisfies readonly CatalogPart[];

export interface CatalogFilters {
  /** Код категории каталога; ALL_CATEGORIES — все разделы (по умолчанию) */
  readonly category: string;
  /** Поиск — текст как ввели (не короче двух символов после нормализации); null — без поиска */
  readonly q: string | null;
  readonly date: string | null;
  /** Время на дату: свободные в эту часть дня (или весь день); без даты — null */
  readonly part: CatalogPart | null;
  readonly guests: number | null;
  /** Город целиком; с районом не пишется — район уже говорит, какой город */
  readonly city: string | null;
  readonly district: string | null;
  readonly sort: CatalogSort | null;
  /** Фильтры по полям витрины: a.<поле> → значение как в адресе */
  readonly attrs: AttrFilters;
}

export const NO_FILTERS: CatalogFilters = {
  category: ALL_CATEGORIES,
  q: null,
  date: null,
  part: null,
  guests: null,
  city: null,
  district: null,
  sort: null,
  attrs: NO_ATTRS,
};

/** Без фильтров, но в той же категории и с тем же поиском (сброс фильтров) */
export const noFiltersIn = (category: string, q: string | null = null): CatalogFilters => ({
  ...NO_FILTERS,
  category,
  q,
});

/** Раздел каталога по коду; «все» и неизвестный — null */
export const catalogCategory = (code: string | null | undefined) =>
  CLIENT_CATEGORIES.find((c) => c.code === code) ?? null;

/**
 * Порядки выдачи: в разделе — по цене, «вместительнее» (только где есть вместимость); в «Все» — по
 * разделам (цены разделов не сравнить); с поиском — и «подходящие»
 */
export const sortsOf = (category: string, searching = false): readonly CatalogSort[] => {
  const config = catalogCategory(category);
  const sorts: readonly CatalogSort[] =
    config === null
      ? [SECTION_SORT]
      : hasCapacity(config)
        ? SORTS
        : SORTS.filter((s) => s !== "capacity_desc");
  return searching ? [SEARCH_SORT, ...sorts] : sorts;
};

/**
 * Запрос поиска из адреса или поля: без пробелов по краям; не поиск (короче двух символов после
 * нормализации) — null; длиннее, чем принимает API, — обрезан (кириллица после нормализации
 * длиннее: «щ» — «sh»)
 */
export function searchText(raw: string | null | undefined): string | null {
  let text = (raw ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  while (text !== "" && searchNorm(text).length > SEARCH_MAX_LENGTH) text = text.slice(0, -1).trimEnd();
  return searchQuery(text) === null ? null : text;
}

/** Код города и района — как в справочнике (app.cities, app.districts) */
const PLACE_CODE = /^[a-z_]{2,30}$/;

export function parseGuests(value: string | null): number | null {
  if (!value || !/^\d{1,5}$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return n >= 1 && n <= MAX_GUESTS ? n : null;
}

/**
 * Фильтры из строки запроса; всё непонятное, прошедшее или чужое для категории отбрасывается
 * (иначе API ответил бы 400 вместо выдачи)
 */
export function readFilters(query: URLSearchParams, today: string): CatalogFilters {
  // Неизвестный раздел — весь каталог, а не ошибка
  const category = catalogCategory(query.get("category"));
  const code = category?.code ?? ALL_CATEGORIES;
  const date = query.get("date");
  const part = query.get("part");
  const city = query.get("city");
  const district = query.get("district");
  const sort = query.get("sort");
  const day = isIsoDate(date) && date >= today && date <= addDays(today, DATE_HORIZON_DAYS) ? date : null;
  const q = searchText(query.get("q"));
  return {
    category: code,
    q,
    date: day,
    part: day === null ? null : (CATALOG_PARTS.find((p) => p === part) ?? null),
    guests: category && hasCapacity(category) ? parseGuests(query.get("guests")) : null,
    // Коды города и района — как проверяет API: иначе 400 вместо выдачи. Район — где он есть у
    // витрин раздела (и в «Все»): кортеж и фото приезжают сами, у них только город
    city: city && PLACE_CODE.test(city) ? city : null,
    district: district && PLACE_CODE.test(district) && (!category || hasDistrict(category)) ? district : null,
    sort:
      sortsOf(code, q !== null).find((s) => s === sort && s !== defaultSortOf({ q, category: code })) ?? null,
    attrs: category ? readAttrFilters(category, query) : NO_ATTRS,
  };
}

/** Параметры адреса каталога; весь каталог — без category, пустые не пишутся (hrefFor) */
export function filtersQuery(filters: CatalogFilters): Record<string, string | number | null> {
  return {
    category: filters.category === ALL_CATEGORIES ? null : filters.category,
    q: filters.q,
    date: filters.date,
    part: filters.date === null ? null : filters.part,
    guests: filters.guests,
    city: filters.city,
    district: filters.district,
    sort: filters.sort,
    ...filters.attrs,
  };
}

/**
 * Кто ещё свободен в тот же день: раздел, дата, гости (где вместимость) и район витрины (где он
 * есть) — «Показать похожие» в «Моих заявках» и «Кто ещё свободен» после отправки заявки
 */
export function sameDayHref(
  categoryCode: string,
  date: string | null,
  guests: number | null,
  district: string | null,
): string {
  const category = catalogCategory(categoryCode);
  return hrefFor(
    { name: "catalog" },
    {
      category: categoryCode,
      date,
      guests: category && hasCapacity(category) ? guests : null,
      district: category && hasDistrict(category) ? district : null,
    },
  );
}

export function hasFilters(filters: CatalogFilters): boolean {
  return (
    filters.date !== null ||
    filters.guests !== null ||
    filters.city !== null ||
    filters.district !== null ||
    Object.keys(filters.attrs).length > 0
  );
}

/**
 * Занятые на дату — в конце, свободные — в прежнем порядке. Сервер уже так отдаёт;
 * здесь — страховка для склейки страниц: занятые не прячутся, а уходят вниз
 */
export function busyLast<T extends Pick<ListingCard, "busyOnDate">>(items: readonly T[]): T[] {
  return [...items.filter((i) => i.busyOnDate !== true), ...items.filter((i) => i.busyOnDate === true)];
}

type FeedStatus = "loading" | "error" | "ready" | "more" | "more-error";

export interface Feed {
  readonly items: readonly ListingCard[];
  /** Сколько нашлось всего — с поиском (первая страница ответа); иначе null */
  readonly total: number | null;
  /** Слова запроса (после нормализации), которые ничего не нашли: выдача — без них */
  readonly dropped: readonly string[];
  readonly status: FeedStatus;
  readonly hasMore: boolean;
  readonly retry: () => void;
  readonly loadMore: () => void;
}

/* Выдача, уже показанная в этой вкладке, — снимком (вместе с догруженными страницами):
   «назад» из витрины возвращает тот же список сразу, без заглушки и запроса, и прокрутка
   встаёт на место (App.tsx). Снимок живёт минуту; только у API с кэшем (api/cache.ts) */
const SNAPSHOT_TTL_MS = 60_000;

interface Snapshot {
  readonly at: number;
  readonly items: readonly ListingCard[];
  readonly cursor: string | null;
  readonly total: number | null;
  readonly dropped: readonly string[];
}

const snapshots = new WeakMap<ClientApi, Map<string, Snapshot>>();

function restoredFeed(api: ClientApi, key: string, query: CatalogQuery): Snapshot | null {
  if (!api.peek) return null;
  const snapshot = snapshots.get(api)?.get(key);
  if (snapshot && Date.now() - snapshot.at <= SNAPSHOT_TTL_MS) return snapshot;
  const page = api.peek.catalog(query);
  return page
    ? {
        at: Date.now(),
        items: page.items,
        cursor: page.nextCursor,
        total: page.total ?? null,
        dropped: page.dropped ?? [],
      }
    : null;
}

function keepSnapshot(
  api: ClientApi,
  key: string,
  items: readonly ListingCard[],
  cursor: string | null,
  total: number | null,
  dropped: readonly string[],
) {
  if (!api.peek) return;
  const byKey = snapshots.get(api) ?? new Map<string, Snapshot>();
  snapshots.set(api, byKey);
  byKey.delete(key);
  byKey.set(key, { at: Date.now(), items, cursor, total, dropped });
  // Последние десять выдач хватит на «назад»
  if (byKey.size > 10) byKey.delete(byKey.keys().next().value as string);
}

/** Запрос выдачи по фильтрам каталога */
export function catalogQuery(filters: CatalogFilters): CatalogQuery {
  return {
    // Раздел — всегда явно (у API без него — залы, для старых сборок); весь каталог — all
    category: filters.category,
    q: filters.q ?? undefined,
    filters: Object.keys(filters.attrs).length > 0 ? filters.attrs : undefined,
    date: filters.date ?? undefined,
    part: filters.date !== null && filters.part !== null ? filters.part : undefined,
    guests: filters.guests ?? undefined,
    city: filters.city ?? undefined,
    district: filters.district ?? undefined,
    sort: filters.sort ?? undefined,
    limit: PAGE_SIZE,
  };
}

/** Лента каталога: первая страница при смене фильтров, дальше — по курсору */
export function useCatalogFeed(api: ClientApi, filters: CatalogFilters): Feed {
  const query = catalogQuery(filters);
  const key = JSON.stringify(query);
  const [initial] = useState(() => restoredFeed(api, key, query));
  const [items, setItems] = useState<readonly ListingCard[]>(initial?.items ?? []);
  const [cursor, setCursor] = useState<string | null>(initial?.cursor ?? null);
  const [total, setTotal] = useState<number | null>(initial?.total ?? null);
  const [dropped, setDropped] = useState<readonly string[]>(initial?.dropped ?? []);
  const [status, setStatus] = useState<FeedStatus>(initial ? "ready" : "loading");
  const [attempt, setAttempt] = useState(0);
  // Поколение запроса: ответ по старым фильтрам не допишется в новую выдачу
  const generation = useRef(0);
  const more = useRef<AbortController | null>(null);
  // Выдача этого ключа уже на экране из снимка — первая страница не нужна
  const restored = useRef<string | null>(initial ? key : null);
  // Каким фильтрам принадлежит выдача на экране (пока новая не пришла — старым)
  const shownKey = useRef<string | null>(initial ? key : null);
  const queryRef = useRef(query);
  queryRef.current = query;

  // Снимок для «назад»: каждый раз, когда выдача этих фильтров готова
  useEffect(() => {
    if (status === "ready" && shownKey.current === key) keepSnapshot(api, key, items, cursor, total, dropped);
  }, [api, key, items, cursor, total, dropped, status]);

  useEffect(() => {
    if (restored.current === key && attempt === 0) return;
    restored.current = null;
    shownKey.current = null;
    const current = ++generation.current;
    const controller = new AbortController();
    more.current?.abort();
    setStatus("loading");
    setItems([]);
    setCursor(null);
    setTotal(null);
    setDropped([]);
    api.catalog(queryRef.current, controller.signal).then(
      (page) => {
        if (current !== generation.current) return;
        shownKey.current = key;
        setItems(page.items);
        setCursor(page.nextCursor);
        setTotal(page.total ?? null);
        setDropped(page.dropped ?? []);
        setStatus("ready");
      },
      (error: unknown) => {
        if (current === generation.current && !isAbort(error)) setStatus("error");
      },
    );
    return () => controller.abort();
  }, [api, key, attempt]);

  const loadMore = useCallback(() => {
    if (!cursor || (status !== "ready" && status !== "more-error")) return;
    const current = generation.current;
    const controller = new AbortController();
    more.current = controller;
    setStatus("more");
    api.catalog({ ...queryRef.current, cursor }, controller.signal).then(
      (page) => {
        if (current !== generation.current) return;
        setItems((prev) => {
          const seen = new Set(prev.map((item) => item.id));
          return [...prev, ...page.items.filter((item) => !seen.has(item.id))];
        });
        setCursor(page.nextCursor);
        setStatus("ready");
      },
      (error: unknown) => {
        if (current === generation.current && !isAbort(error)) setStatus("more-error");
      },
    );
  }, [api, cursor, status]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  // Связь вернулась, а выдача не загрузилась — ещё раз сами
  useOnReconnect(() => {
    if (status === "error") retry();
    else if (status === "more-error") loadMore();
  });

  return { items, total, dropped, status, hasMore: cursor !== null, retry, loadMore };
}
