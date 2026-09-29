import type { CatalogSort } from "@bayramm/shared/api";
import { useEffect, useId, useRef, useState } from "react";
import { Calendar } from "../components/Calendar";
import { ListingCard } from "../components/ListingCard";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { pick, useDictionaries, useLang, useServices } from "../context";
import { addDays, formatDayMonth, tashkentToday } from "../format";
import { useDocumentTitle } from "../hooks";
import { Icon } from "../icons";
import { hrefFor, useNav } from "../router";
import {
  busyLast,
  type CatalogFilters,
  DATE_HORIZON_DAYS,
  DEFAULT_SORT,
  filtersQuery,
  hasFilters,
  MAX_GUESTS,
  NO_FILTERS,
  parseGuests,
  readFilters,
  SORTS,
  useCatalogFeed,
} from "./catalog-feed";

const SORT_LABEL = {
  price_asc: "s_cheap",
  price_desc: "s_rich",
  capacity_desc: "s_capacity",
} as const satisfies Record<CatalogSort, string>;

// Пока человек печатает число гостей, выдачу не дёргаем на каждую цифру
const GUESTS_DEBOUNCE_MS = 600;

function GuestsField({
  value,
  onCommit,
}: {
  value: number | null;
  onCommit: (guests: number | null) => void;
}) {
  const { t } = useLang();
  const id = useId();
  const [text, setText] = useState(value === null ? "" : String(value));
  const commit = useRef(onCommit);
  commit.current = onCommit;

  // Значение сменили снаружи (сброс фильтров, «назад»)
  useEffect(() => {
    setText(value === null ? "" : String(value));
  }, [value]);

  useEffect(() => {
    const parsed = parseGuests(text);
    if (parsed === value || (text.trim() !== "" && parsed === null)) return;
    const timer = setTimeout(() => commit.current(parsed), GUESTS_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, value]);

  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {t.fGuests}
      </label>
      <input
        id={id}
        className="field-input"
        type="number"
        inputMode="numeric"
        min={1}
        max={MAX_GUESTS}
        placeholder={t.anyGuestV}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          const parsed = parseGuests(text);
          if (parsed !== value) onCommit(parsed);
        }}
      />
    </div>
  );
}

export function Catalog() {
  const { api, now } = useServices();
  const { t, lang } = useLang();
  const { state: dicts } = useDictionaries();
  const { query, navigate } = useNav();
  const today = tashkentToday(now());
  const filters = readFilters(query, today);
  const feed = useCatalogFeed(api, filters);
  const [dateOpen, setDateOpen] = useState(false);
  const dateId = useId();
  const districtId = useId();
  const sortId = useId();
  const sentinel = useRef<HTMLDivElement>(null);
  useDocumentTitle(t.hallsTitle);

  const setFilters = (patch: Partial<CatalogFilters>) =>
    navigate(hrefFor({ name: "catalog" }, filtersQuery({ ...filters, ...patch })), { replace: true });

  // Подгрузка при прокрутке к концу. IntersectionObserver есть не везде — тогда кнопка
  const { loadMore } = feed;
  useEffect(() => {
    const node = sentinel.current;
    if (!node || typeof IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMore();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [loadMore]);

  const districts = dicts.status === "ready" ? dicts.data.districts : [];
  const items = busyLast(feed.items);

  return (
    <div className="screen catalog">
      <section className="filters" aria-label={t.cats}>
        <div className="field">
          <span className="field-label" id={`${dateId}-label`}>
            {t.fDate}
          </span>
          <button
            type="button"
            className="field-input field-button"
            aria-labelledby={`${dateId}-label ${dateId}-value`}
            aria-expanded={dateOpen}
            aria-controls={`${dateId}-panel`}
            onClick={() => setDateOpen((open) => !open)}
          >
            <Icon name="calB" size={17} />
            <span id={`${dateId}-value`}>{filters.date ? formatDayMonth(filters.date, t) : t.anyDateV}</span>
          </button>
        </div>
        <GuestsField value={filters.guests} onCommit={(guests) => setFilters({ guests })} />
        <div className="field">
          <label className="field-label" htmlFor={districtId}>
            {t.fDistrict}
          </label>
          <span className="select">
            <select
              id={districtId}
              className="field-input"
              value={filters.district ?? ""}
              onChange={(event) => setFilters({ district: event.target.value || null })}
            >
              <option value="">{t.anyDistrict}</option>
              {districts.map((district) => (
                <option key={district.code} value={district.code}>
                  {pick(district.name, lang)}
                </option>
              ))}
            </select>
            <Icon name="caretDown" size={14} className="select-caret" />
          </span>
        </div>
      </section>

      {dateOpen ? (
        <div className="date-panel" id={`${dateId}-panel`}>
          <Calendar
            label={t.fDate}
            min={today}
            max={addDays(today, DATE_HORIZON_DAYS)}
            selected={filters.date}
            onSelect={(date) => {
              setFilters({ date });
              setDateOpen(false);
            }}
          />
          <div className="panel-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setFilters({ date: null });
                setDateOpen(false);
              }}
            >
              {t.anyDate}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setDateOpen(false)}>
              {t.done}
            </button>
          </div>
        </div>
      ) : null}

      <div className="list-head">
        <div>
          <h1 className="screen-title" tabIndex={-1}>
            {t.hallsTitle}
          </h1>
          <p className="muted small">{t.note}</p>
        </div>
        <div className="sort">
          <label className="sr-only" htmlFor={sortId}>
            {t.sortBy}
          </label>
          <Icon name="sliders" size={14} />
          <span className="select">
            <select
              id={sortId}
              value={filters.sort ?? DEFAULT_SORT}
              onChange={(event) => {
                const sort = SORTS.find((s) => s === event.target.value) ?? DEFAULT_SORT;
                setFilters({ sort: sort === DEFAULT_SORT ? null : sort });
              }}
            >
              {SORTS.map((sort) => (
                <option key={sort} value={sort}>
                  {t[SORT_LABEL[sort]]}
                </option>
              ))}
            </select>
            <Icon name="caretDown" size={14} className="select-caret" />
          </span>
        </div>
      </div>

      {feed.status === "loading" ? <Loading /> : null}
      {feed.status === "error" ? <ErrorState onRetry={feed.retry} /> : null}
      {/* Пусто без фильтров — площадок ещё нет: «под эти условия никого» тут было бы неправдой */}
      {feed.status !== "loading" && feed.status !== "error" && items.length === 0 ? (
        <EmptyState
          title={hasFilters(filters) ? t.empty_h : t.noVenues_h}
          text={hasFilters(filters) ? t.emptyHint : t.noVenues}
          action={
            hasFilters(filters) ? (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() =>
                  navigate(hrefFor({ name: "catalog" }, filtersQuery(NO_FILTERS)), { replace: true })
                }
              >
                {t.resetFilters}
              </button>
            ) : null
          }
        />
      ) : null}

      {items.length > 0 ? (
        <ul className="cards">
          {items.map((card, i) => (
            <li key={card.id}>
              <ListingCard card={card} date={filters.date} guests={filters.guests} eager={i < 2} />
            </li>
          ))}
        </ul>
      ) : null}

      <div ref={sentinel} className="sentinel" aria-hidden="true" />
      {feed.status === "more" ? <Loading /> : null}
      {feed.status === "more-error" ? <ErrorState onRetry={feed.loadMore} /> : null}
      {feed.status === "ready" && feed.hasMore ? (
        <button type="button" className="btn btn-secondary more" onClick={feed.loadMore}>
          {t.loadMore}
        </button>
      ) : null}
    </div>
  );
}
