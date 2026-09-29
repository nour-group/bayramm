import type { CatalogQuery, CatalogSort, ListingCard } from "@bayramm/shared/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { isAbort } from "../api/errors";
import type { ClientApi } from "../api/types";
import { addDays, isIsoDate } from "../format";

/* Фильтры каталога живут в адресе (?date=&guests=&district=&sort=): ссылка «похожие»
   из «Моих заявок» и «назад» из карточки возвращают ту же выдачу. */

export const SORTS = ["price_asc", "price_desc", "capacity_desc"] as const satisfies readonly CatalogSort[];

export const MAX_GUESTS = 5000;
/** Насколько вперёд можно выбрать дату */
export const DATE_HORIZON_DAYS = 365;
export const PAGE_SIZE = 20;

export interface CatalogFilters {
  readonly date: string | null;
  readonly guests: number | null;
  readonly district: string | null;
  readonly sort: CatalogSort | null;
}

export const NO_FILTERS: CatalogFilters = { date: null, guests: null, district: null, sort: null };

export function parseGuests(value: string | null): number | null {
  if (!value || !/^\d{1,5}$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return n >= 1 && n <= MAX_GUESTS ? n : null;
}

/** Фильтры из строки запроса; всё непонятное или прошедшее отбрасывается */
export function readFilters(query: URLSearchParams, today: string): CatalogFilters {
  const date = query.get("date");
  const district = query.get("district");
  const sort = query.get("sort");
  return {
    date: isIsoDate(date) && date >= today && date <= addDays(today, DATE_HORIZON_DAYS) ? date : null,
    guests: parseGuests(query.get("guests")),
    district: district && /^[a-z0-9_]{1,40}$/.test(district) ? district : null,
    sort: SORTS.find((s) => s === sort) ?? null,
  };
}

export function filtersQuery(filters: CatalogFilters) {
  return { date: filters.date, guests: filters.guests, district: filters.district, sort: filters.sort };
}

export function hasFilters(filters: CatalogFilters): boolean {
  return filters.date !== null || filters.guests !== null || filters.district !== null;
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

/** Лента каталога: первая страница при смене фильтров, дальше — по курсору */
export function useCatalogFeed(api: ClientApi, filters: CatalogFilters): Feed {
  const [items, setItems] = useState<readonly ListingCard[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<FeedStatus>("loading");
  const [attempt, setAttempt] = useState(0);
  // Поколение запроса: ответ по старым фильтрам не допишется в новую выдачу
  const generation = useRef(0);
  const more = useRef<AbortController | null>(null);

  const query: CatalogQuery = {
    date: filters.date ?? undefined,
    guests: filters.guests ?? undefined,
    district: filters.district ?? undefined,
    sort: filters.sort ?? undefined,
    limit: PAGE_SIZE,
  };
  const key = JSON.stringify(query);
  const queryRef = useRef(query);
  queryRef.current = query;

  // biome-ignore lint/correctness/useExhaustiveDependencies: key и attempt — и есть зависимости запроса
  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    more.current?.abort();
    setStatus("loading");
    setItems([]);
    setCursor(null);
    api.catalog(queryRef.current, controller.signal).then(
      (page) => {
        if (current !== generation.current) return;
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

  return { items, status, hasMore: cursor !== null, retry, loadMore };
}
