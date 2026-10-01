import type { CatalogQuery, CatalogSort, ListingCard } from "@bayramm/shared/api";
import { useOnReconnect } from "@bayramm/ui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { isAbort } from "../api/errors";
import type { ClientApi } from "../api/types";
import { clientCategory, hasCapacity, hasDistrict } from "../categories";
import { addDays, isIsoDate } from "../format";
import { DEFAULT_CATEGORY } from "../routes";
import { type AttrFilters, NO_ATTRS, readAttrFilters } from "./catalog-filters";

/* Фильтры каталога живут в адресе (?category=&date=&guests=&district=&sort=&a.<поле>=):
   ссылка «похожие» из «Моих заявок», кнопки бота и «назад» из карточки возвращают ту же
   выдачу. Гости и район — только у категорий, где они есть (вместимость у залов, район у
   залов и студий); порядок «вместительнее» — только у залов. */

export const SORTS = ["price_asc", "price_desc", "capacity_desc"] as const satisfies readonly CatalogSort[];

/** Порядок, если sort не передан: так же решает сервер. В адресе его не пишем */
export const DEFAULT_SORT = "price_asc" satisfies CatalogSort;

export const MAX_GUESTS = 5000;
/** Насколько вперёд можно выбрать дату */
export const DATE_HORIZON_DAYS = 365;
export const PAGE_SIZE = 20;

export interface CatalogFilters {
  /** Код категории каталога; залы — по умолчанию */
  readonly category: string;
  readonly date: string | null;
  readonly guests: number | null;
  readonly district: string | null;
  readonly sort: CatalogSort | null;
  /** Фильтры по полям витрины: a.<поле> → значение как в адресе */
  readonly attrs: AttrFilters;
}

export const NO_FILTERS: CatalogFilters = {
  category: DEFAULT_CATEGORY,
  date: null,
  guests: null,
  district: null,
  sort: null,
  attrs: NO_ATTRS,
};

/** Без фильтров, но в той же категории (сброс фильтров) */
export const noFiltersIn = (category: string): CatalogFilters => ({ ...NO_FILTERS, category });

/** Порядки выдачи категории: «вместительнее» — только где есть вместимость */
export const sortsOf = (category: string): readonly CatalogSort[] =>
  hasCapacity(clientCategory(category)) ? SORTS : SORTS.filter((s) => s !== "capacity_desc");

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
  const category = clientCategory(query.get("category"));
  const date = query.get("date");
  const district = query.get("district");
  const sort = query.get("sort");
  return {
    category: category.code,
    date: isIsoDate(date) && date >= today && date <= addDays(today, DATE_HORIZON_DAYS) ? date : null,
    guests: hasCapacity(category) ? parseGuests(query.get("guests")) : null,
    // Код района — как проверяет API: иначе 400 вместо выдачи
    district: hasDistrict(category) && district && /^[a-z_]{2,30}$/.test(district) ? district : null,
    sort: sortsOf(category.code).find((s) => s === sort && s !== DEFAULT_SORT) ?? null,
    attrs: readAttrFilters(category, query),
  };
}

/** Параметры адреса каталога; залы — без category, пустые не пишутся (hrefFor) */
export function filtersQuery(filters: CatalogFilters): Record<string, string | number | null> {
  return {
    category: filters.category === DEFAULT_CATEGORY ? null : filters.category,
    date: filters.date,
    guests: filters.guests,
    district: filters.district,
    sort: filters.sort,
    ...filters.attrs,
  };
}

export function hasFilters(filters: CatalogFilters): boolean {
  return (
    filters.date !== null ||
    filters.guests !== null ||
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
}

const snapshots = new WeakMap<ClientApi, Map<string, Snapshot>>();

function restoredFeed(api: ClientApi, key: string, query: CatalogQuery): Snapshot | null {
  if (!api.peek) return null;
  const snapshot = snapshots.get(api)?.get(key);
  if (snapshot && Date.now() - snapshot.at <= SNAPSHOT_TTL_MS) return snapshot;
  const page = api.peek.catalog(query);
  return page ? { at: Date.now(), items: page.items, cursor: page.nextCursor } : null;
}

function keepSnapshot(api: ClientApi, key: string, items: readonly ListingCard[], cursor: string | null) {
  if (!api.peek) return;
  const byKey = snapshots.get(api) ?? new Map<string, Snapshot>();
  snapshots.set(api, byKey);
  byKey.delete(key);
  byKey.set(key, { at: Date.now(), items, cursor });
  // Последние десять выдач хватит на «назад»
  if (byKey.size > 10) byKey.delete(byKey.keys().next().value as string);
}

/** Запрос выдачи по фильтрам каталога */
export function catalogQuery(filters: CatalogFilters): CatalogQuery {
  return {
    category: filters.category === DEFAULT_CATEGORY ? undefined : filters.category,
    filters: Object.keys(filters.attrs).length > 0 ? filters.attrs : undefined,
    date: filters.date ?? undefined,
    guests: filters.guests ?? undefined,
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
    if (status === "ready" && shownKey.current === key) keepSnapshot(api, key, items, cursor);
  }, [api, key, items, cursor, status]);

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
    api.catalog(queryRef.current, controller.signal).then(
      (page) => {
        if (current !== generation.current) return;
        shownKey.current = key;
        setItems(page.items);
        setCursor(page.nextCursor);
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

  return { items, status, hasMore: cursor !== null, retry, loadMore };
}
