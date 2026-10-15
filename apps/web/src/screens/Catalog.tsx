import type { CatalogSort } from "@bayramm/shared/api";
import { DateField, Dialog, NumberStepper, RadioGroup, Select } from "@bayramm/ui/react";
import { useEffect, useId, useRef, useState } from "react";
import { CLIENT_CATEGORIES, categoryDesc, categoryName, hasCalendar, hasCapacity } from "../categories";
import { AttrFiltersForm } from "../components/AttrFilters";
import { useCalendarTexts } from "../components/Calendar";
import { CatalogSearch } from "../components/CatalogSearch";
import { CategorySwitch, categoryHref, listingsIn, useCatalogCategories } from "../components/Categories";
import { Link } from "../components/Link";
import { CARD_PHOTO_SIZES, CARD_PHOTO_SIZES_SIDE, ListingCard } from "../components/ListingCard";
import { CardsLoading, EmptyState, ErrorState, Loading } from "../components/States";
import { useDictionaries, useLang, useServices } from "../context";
import { addDays, formatDayMonth, tashkentToday } from "../format";
import { useDocumentTitle } from "../hooks";
import { Icon } from "../icons";
import { ALL_CATEGORIES, hrefFor, useNav } from "../router";
import {
  busyLast,
  type CatalogFilters,
  catalogCategory,
  DATE_HORIZON_DAYS,
  defaultSortOf,
  filtersQuery,
  hasFilters,
  MAX_GUESTS,
  noFiltersIn,
  parseGuests,
  readFilters,
  searchText,
  sortsOf,
  useCatalogFeed,
} from "./catalog-feed";
import { attrFilterCount, filterSpecs } from "./catalog-filters";
import { placeChoice, placeFilters } from "./catalog-place";

/* Каталог: весь (/catalog — раздел «Все») или раздел (/catalog?category=…): заголовок, поиск,
   переключатель разделов, фильтры, порядок и сетка карточек. Всё — в адресе. Поиск (?q=) — над
   разделами во всю ширину, вместе с разделом и фильтрами; заголовок тогда — «По запросу «…» — N»,
   пусто в разделе — ссылка на другие разделы, пусто везде — популярные разделы. Главные фильтры —
   пилюлями над выдачей: место (город → район), дата, гости (где вместимость); строка переносится,
   а не листается вбок — каждая пилюля на виду и на телефоне. Поля витрины раздела и порядок — на
   телефоне и планшете одной кнопкой «Фильтры · n» (шторка), на компьютере поля — колонкой слева,
   порядок — в конце строки. У раздела без полей витрины порядок — пилюлей в строке везде. */

const SORT_LABEL = {
  price_asc: "s_cheap",
  price_desc: "s_rich",
  capacity_desc: "s_capacity",
  relevance: "s_relevance",
} as const satisfies Record<CatalogSort, string>;

/** Популярных разделов в пустой выдаче поиска */
const POPULAR_SECTIONS = 4;

/**
 * Пусто в разделе по запросу — сколько нашлось бы во всех разделах (те же место и дата: гостей и
 * полей витрины у «Все» нет); null — не спрашивали или ещё не ответили
 */
function useElsewhere(filters: CatalogFilters, empty: boolean): number | null {
  const { api } = useServices();
  const [count, setCount] = useState<number | null>(null);
  const { q, category, city, district, date } = filters;
  const ask = empty && q !== null && category !== ALL_CATEGORIES;
  useEffect(() => {
    setCount(null);
    if (!ask || q === null) return;
    const controller = new AbortController();
    api
      .catalog(
        {
          category: ALL_CATEGORIES,
          q,
          city: city ?? undefined,
          district: district ?? undefined,
          date: date ?? undefined,
          limit: 1,
        },
        controller.signal,
      )
      .then(
        (page) => setCount(page.total ?? page.items.length),
        () => {},
      );
    return () => controller.abort();
  }, [api, ask, q, city, district, date]);
  return ask ? count : null;
}

/** Популярные разделы — где больше всего исполнителей (чисел не показываем) */
function PopularSections() {
  const { t, lang } = useLang();
  const state = useCatalogCategories();
  const counts = state.status === "ready" ? state.data.items : [];
  const popular = CLIENT_CATEGORIES.filter((c) => listingsIn(state, c.code) === true)
    .map((c) => ({ code: c.code, listings: counts.find((i) => i.code === c.code)?.listings ?? 0 }))
    .sort((a, b) => b.listings - a.listings)
    .slice(0, POPULAR_SECTIONS);
  if (popular.length === 0) return null;
  return (
    <div className="search-popular">
      <p className="muted small">{t.srPopular}</p>
      <ul className="empty-cuts">
        {popular.map((c) => (
          <li key={c.code}>
            <Link className="btn btn-secondary cut-chip" href={categoryHref(c.code)}>
              {categoryName(c.code, t, lang)}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Пока человек печатает число гостей, выдачу не дёргаем на каждую цифру
const GUESTS_DEBOUNCE_MS = 600;

/** Сколько карточек грузить сразу (первый ряд на любом экране — до четырёх колонок) */
const EAGER_CARDS = 4;

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

  // Пилюля в строке фильтров: значок, число; подпись поля — только диктору
  return (
    <div className={text ? "filter-guests has-value" : "filter-guests"}>
      <label className="sr-only" htmlFor={id}>
        {t.fGuests}
      </label>
      <Icon name="user" size={14} />
      <NumberStepper
        id={id}
        min={1}
        max={MAX_GUESTS}
        maxLength={4}
        placeholder={t.guestsPill}
        value={text}
        onChange={setText}
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
  // null — «Все»: разделы вперемешку, фильтров раздела (гости, район, поля витрины) нет
  const category = catalogCategory(filters.category);
  const specs = category ? filterSpecs(category) : [];
  const feed = useCatalogFeed(api, filters);
  const calendarTexts = useCalendarTexts();
  const ids = useId();
  const sentinel = useRef<HTMLDivElement>(null);
  const filtersButton = useRef<HTMLButtonElement>(null);
  const [sheet, setSheet] = useState(false);
  const name = category ? (categoryName(category.code, t, lang) ?? category.code) : t.catAll;
  const sectionTitle = category ? t.catTitle(name) : t.catAllTitle;
  const searching = filters.q !== null;
  const title =
    filters.q === null
      ? sectionTitle
      : feed.total !== null && feed.status !== "loading"
        ? t.srResultsN(filters.q, feed.total)
        : t.srResultsH(filters.q);
  // Заголовок вкладки — без числа: оно меняется, а вкладку называют по запросу
  useDocumentTitle(filters.q === null ? sectionTitle : t.srResultsH(filters.q));

  const setFilters = (patch: Partial<CatalogFilters>) =>
    navigate(hrefFor({ name: "catalog" }, filtersQuery({ ...filters, ...patch })), { replace: true });
  const reset = () =>
    navigate(hrefFor({ name: "catalog" }, filtersQuery(noFiltersIn(filters.category, filters.q))), {
      replace: true,
    });
  // Новый запрос — новая запись истории («назад» вернёт прежнюю выдачу); порядок — по умолчанию
  // для поиска, раздел и фильтры остаются. Пусто — поиск снят
  const search = (text: string) => {
    const q = searchText(text);
    if (q === filters.q) return;
    navigate(hrefFor({ name: "catalog" }, filtersQuery({ ...filters, q, sort: null })));
  };
  const clearSearch = () => {
    if (filters.q !== null) setFilters({ q: null, sort: null });
  };

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

  const items = busyLast(feed.items);
  const sorts = sortsOf(filters.category, searching);
  const defaultSort = defaultSortOf(filters);
  const capacity = category !== null && hasCapacity(category);
  const extra = attrFilterCount(filters.attrs);
  const place = placeChoice(filters, dicts.status === "ready" ? dicts.data : null, t, lang);
  const side = specs.length > 0;
  // Шторка «Фильтры» на телефоне и планшете: поля витрины и порядок; число — что из них задано
  const sheetCount = extra + (filters.sort === null ? 0 : 1);
  const filtered = hasFilters(filters);
  // Цены за гостя и за мероприятие вперемешку — объясняем, как их сравнили (у карточки с ценой за
  // мероприятие — «≈ N за гостя»); у остальных категорий единицы разные (за час и за
  // мероприятие) — просим смотреть на подпись
  const sortNow = filters.sort ?? defaultSort;
  const priceSort = sortNow === "price_asc" || sortNow === "price_desc";
  const units = new Set(items.map((i) => i.priceUnit));
  // В «Все» единицы разных разделов — только подпись у суммы
  const hallUnits = category !== null && units.has("per_guest") && units.has("per_event");
  const sortHint = !priceSort
    ? null
    : hallUnits
      ? filters.guests === null
        ? t.sortHintPerGuest
        : t.sortHintTotal(filters.guests)
      : units.size > 1
        ? t.sortHintUnits
        : null;
  // Что отсекает выдачу — каждое можно убрать по одному (пустая выдача называет его). Дата не
  // отсекает: занятые в этот день лишь уходят в конец
  const cutting: readonly { key: string; label: string; drop: Partial<CatalogFilters> }[] = [
    ...(filters.guests !== null
      ? [{ key: "guests", label: `${t.fGuests}: ${filters.guests}`, drop: { guests: null } }]
      : []),
    ...(place.chosen !== null
      ? [{ key: "place", label: `${t.fPlace}: ${place.chosen}`, drop: { city: null, district: null } }]
      : []),
    ...(extra > 0 ? [{ key: "attrs", label: t.moreFiltersN(extra), drop: { attrs: {} } }] : []),
  ];
  // Пусто из-за фильтров — что именно мешает и как убрать; иначе в разделе ещё никого: «скоро»
  const empty =
    cutting.length > 0
      ? {
          title: filters.guests !== null ? t.emptyGuestsH(filters.guests) : t.emptyH,
          text: capacity ? t.emptyHint : t.emptyHintCat,
        }
      : { title: category ? t.catSoonH(name) : t.catAllSoonH, text: t.catSoonP };
  const loaded = feed.status !== "loading" && feed.status !== "error";
  const elsewhere = useElsewhere(filters, loaded && items.length === 0);
  // Кнопка шторки показывает, сколько нашлось (пока выдача грузится — просто «Показать»)
  const apply = loaded ? t.filtersShowN(items.length, feed.hasMore) : t.filtersApply;

  return (
    <div className="screen catalog">
      <div className="catalog-head">
        <h1 className="screen-title" tabIndex={-1}>
          {title}
        </h1>
        {/* Что в разделе — та же строка, что на плитке лендинга */}
        {category ? <p className="cat-lead">{categoryDesc(category.code, t)}</p> : null}
        <p className="muted small">{t.catalogNote}</p>
      </div>

      {/* Поиск — над разделами, во всю ширину; в Telegram — вверху вкладки каталога */}
      <CatalogSearch
        className="catalog-search"
        takeFocus
        value={filters.q ?? ""}
        date={filters.date}
        onSubmit={search}
        onClear={clearSearch}
      />

      <CategorySwitch current={filters.category} date={filters.date} q={filters.q} />

      <section className="filters-panel" aria-label={t.moreFilters}>
        <div className="filter-row">
          {/* Подписи пилюль — диктору (видимое имя — значение в пилюле) */}
          <label className="sr-only" htmlFor={`${ids}-place`}>
            {t.fPlace}
          </label>
          <Select
            size="compact"
            id={`${ids}-place`}
            className={place.value ? "filter-place is-set" : "filter-place"}
            label={t.fPlace}
            placeholder={t.fPlace}
            icon={<Icon name="pin" size={14} />}
            value={place.value}
            options={place.options}
            onChange={(value) => setFilters(placeFilters(value))}
          />
          <label className="sr-only" htmlFor={`${ids}-date`}>
            {t.fDate}
          </label>
          <DateField
            size="compact"
            id={`${ids}-date`}
            label={t.fDate}
            placeholder={t.anyDatePill}
            value={filters.date}
            min={today}
            max={addDays(today, DATE_HORIZON_DAYS)}
            format={(date) => formatDayMonth(date, t)}
            texts={calendarTexts}
            clearLabel={t.anyDate}
            onChange={(date) => setFilters({ date })}
          />
          {capacity ? (
            <GuestsField value={filters.guests} onCommit={(guests) => setFilters({ guests })} />
          ) : null}
          {side ? (
            <button
              type="button"
              className={sheetCount > 0 ? "filter-pill filters-open is-on" : "filter-pill filters-open"}
              ref={filtersButton}
              aria-haspopup="dialog"
              onClick={() => setSheet(true)}
            >
              <Icon name="sliders" size={14} />
              {sheetCount > 0 ? t.moreFiltersN(sheetCount) : t.moreFilters}
            </button>
          ) : null}
          {/* Порядок: у раздела с полями витрины на телефоне и планшете — в шторке «Фильтры» */}
          <div className={side ? "sort in-sheet" : "sort"}>
            <Select
              size="compact"
              label={t.sortBy}
              icon={<Icon name="sort" size={14} />}
              value={filters.sort ?? defaultSort}
              options={sorts.map((sort) => ({ value: sort, label: t[SORT_LABEL[sort]] }))}
              onChange={(sort) => setFilters({ sort: sort === defaultSort ? null : sort })}
            />
          </div>
        </div>
        {/* Пустая выдача сбрасывает фильтры сама (ниже) — второй кнопки рядом не нужно */}
        {filtered && !(loaded && items.length === 0) ? (
          <button type="button" className="link-btn filters-reset" onClick={reset}>
            {t.resetFilters}
          </button>
        ) : null}
        {/* Без календаря (цветы, торты, подарки) дата не отсекает — она уйдёт в заявку */}
        {filters.date && category && !hasCalendar(category) ? (
          <p className="muted small date-note">{t.leadDateNote}</p>
        ) : null}
      </section>

      <div className={side ? "catalog-body has-side" : "catalog-body"}>
        {/* Поля витрины раздела — колонкой слева на компьютере; на телефоне и планшете — шторкой */}
        {side && category ? (
          <aside className="filters-side" aria-labelledby={`${ids}-extra`}>
            <h2 className="section-title side-title" id={`${ids}-extra`}>
              {t.extraFilters}
            </h2>
            <AttrFiltersForm
              category={category}
              attrs={filters.attrs}
              onChange={(attrs) => setFilters({ attrs })}
            />
            {extra > 0 ? (
              <button type="button" className="link-btn side-reset" onClick={() => setFilters({ attrs: {} })}>
                {t.resetFilters}
              </button>
            ) : null}
          </aside>
        ) : null}

        <div className="catalog-list">
          {sortHint && items.length > 0 ? <p className="muted small sort-hint">{sortHint}</p> : null}

          {feed.status === "loading" ? <CardsLoading /> : null}
          {feed.status === "error" ? <ErrorState onRetry={feed.retry} /> : null}
          {loaded && items.length === 0 && filters.q !== null ? (
            <SearchEmpty
              section={category ? name : null}
              elsewhere={elsewhere}
              elsewhereHref={hrefFor(
                { name: "catalog" },
                filtersQuery({
                  ...noFiltersIn(ALL_CATEGORIES, filters.q),
                  city: filters.city,
                  district: filters.district,
                  date: filters.date,
                }),
              )}
              filtered={filtered}
              onReset={reset}
              onClearSearch={clearSearch}
            />
          ) : null}
          {loaded && items.length === 0 && filters.q === null ? (
            <EmptyState
              title={empty.title}
              text={empty.text}
              action={
                filtered ? (
                  <div className="empty-filters">
                    {cutting.length > 0 ? (
                      <>
                        <p className="muted small">{t.emptyActive}</p>
                        <ul className="empty-cuts">
                          {cutting.map((cut) => (
                            <li key={cut.key}>
                              <button
                                type="button"
                                className="btn btn-secondary cut-chip"
                                aria-label={t.dropFilter(cut.label)}
                                onClick={() => setFilters(cut.drop)}
                              >
                                {cut.label}
                                <Icon name="close" size={14} />
                              </button>
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : null}
                    <button type="button" className="btn btn-primary" onClick={reset}>
                      {t.resetFilters}
                    </button>
                  </div>
                ) : null
              }
            />
          ) : null}

          {items.length > 0 ? (
            <ul className="cards">
              {items.map((card, i) => (
                <li key={card.id}>
                  <ListingCard
                    card={card}
                    date={filters.date}
                    guests={filters.guests}
                    eager={i < EAGER_CARDS}
                    priority={i === 0}
                    sizes={side ? CARD_PHOTO_SIZES_SIDE : CARD_PHOTO_SIZES}
                    showCategory={category === null}
                    perGuest={priceSort && hallUnits}
                  />
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
      </div>

      {/* Порядок и поля витрины на телефоне и планшете — шторкой; выдача за ней меняется сразу */}
      <Dialog
        open={sheet}
        onClose={() => setSheet(false)}
        title={t.moreFilters}
        className="filters-sheet"
        returnFocus={filtersButton}
        actions={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={sheetCount === 0}
              onClick={() => setFilters({ attrs: {}, sort: null })}
            >
              {t.resetFilters}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setSheet(false)}>
              {apply}
            </button>
          </>
        }
      >
        <div className="sheet-filters">
          <fieldset className="filter-group sheet-sort">
            <legend className="field-label">{t.sortBy}</legend>
            <RadioGroup
              variant="row"
              value={filters.sort ?? defaultSort}
              options={sorts.map((sort) => ({ value: sort, label: t[SORT_LABEL[sort]] }))}
              onChange={(sort) => setFilters({ sort: sort === defaultSort ? null : sort })}
            />
          </fieldset>
          {category ? (
            <AttrFiltersForm
              category={category}
              attrs={filters.attrs}
              onChange={(attrs) => setFilters({ attrs })}
            />
          ) : null}
        </div>
      </Dialog>
    </div>
  );
}

/**
 * Пусто по запросу. В разделе — сколько нашлось бы в других (ссылка на «Все» с тем же запросом),
 * а пока не ответили — без ссылки; везде пусто — сбросить фильтры и поиск, популярные разделы
 */
function SearchEmpty({
  section,
  elsewhere,
  elsewhereHref,
  filtered,
  onReset,
  onClearSearch,
}: {
  section: string | null;
  elsewhere: number | null;
  elsewhereHref: string;
  filtered: boolean;
  onReset: () => void;
  onClearSearch: () => void;
}) {
  const { t } = useLang();
  if (section !== null && elsewhere !== null && elsewhere > 0)
    return (
      <EmptyState
        title={t.srEmptyInH(section)}
        text={t.srElsewhereP}
        action={
          <Link className="btn btn-primary" href={elsewhereHref}>
            {t.srElsewhere(elsewhere)}
          </Link>
        }
      />
    );
  return (
    <EmptyState
      title={t.srNoneH}
      text={t.srEmptyP}
      action={
        <div className="empty-filters">
          <PopularSections />
          <div className="search-empty-actions">
            {filtered ? (
              <button type="button" className="btn btn-secondary" onClick={onReset}>
                {t.resetFilters}
              </button>
            ) : null}
            <button type="button" className="btn btn-primary" onClick={onClearSearch}>
              {t.srClear}
            </button>
          </div>
        </div>
      }
    />
  );
}
