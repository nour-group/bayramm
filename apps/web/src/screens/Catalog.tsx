import type { CatalogSort } from "@bayramm/shared/api";
import { DateField, Dialog, NumberStepper, Select } from "@bayramm/ui/react";
import { useEffect, useId, useRef, useState } from "react";
import { categoryDesc, categoryName, hasCalendar, hasCapacity } from "../categories";
import { AttrFiltersForm } from "../components/AttrFilters";
import { useCalendarTexts } from "../components/Calendar";
import { CategorySwitch } from "../components/Categories";
import { CARD_PHOTO_SIZES, CARD_PHOTO_SIZES_SIDE, ListingCard } from "../components/ListingCard";
import { CardsLoading, EmptyState, ErrorState, Loading } from "../components/States";
import { useDictionaries, useLang, useServices } from "../context";
import { addDays, formatDayMonth, tashkentToday } from "../format";
import { useDocumentTitle } from "../hooks";
import { Icon } from "../icons";
import { hrefFor, useNav } from "../router";
import {
  busyLast,
  type CatalogFilters,
  catalogCategory,
  DATE_HORIZON_DAYS,
  DEFAULT_SORT,
  filtersQuery,
  hasFilters,
  MAX_GUESTS,
  noFiltersIn,
  parseGuests,
  readFilters,
  sortsOf,
  useCatalogFeed,
} from "./catalog-feed";
import { attrFilterCount, filterSpecs } from "./catalog-filters";
import { placeChoice, placeFilters } from "./catalog-place";

/* Каталог: весь (/catalog — раздел «Все») или раздел (/catalog?category=…): заголовок,
   переключатель разделов, фильтры, порядок и сетка карточек. Всё — в адресе. Главные фильтры —
   одной строкой пилюль над выдачей: место (город → район), дата, гости (где вместимость),
   порядок; на телефоне строка листается вбок, каждая пилюля открывает шторку. Поля витрины
   раздела — кнопкой «Фильтры» (шторка) на телефоне и планшете, на компьютере — колонкой слева. */

const SORT_LABEL = {
  price_asc: "s_cheap",
  price_desc: "s_rich",
  capacity_desc: "s_capacity",
} as const satisfies Record<CatalogSort, string>;

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
  const title = category ? t.catTitle(name) : t.catAllTitle;
  useDocumentTitle(title);

  const setFilters = (patch: Partial<CatalogFilters>) =>
    navigate(hrefFor({ name: "catalog" }, filtersQuery({ ...filters, ...patch })), { replace: true });
  const reset = () =>
    navigate(hrefFor({ name: "catalog" }, filtersQuery(noFiltersIn(filters.category))), { replace: true });

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
  const sorts = sortsOf(filters.category);
  const capacity = category !== null && hasCapacity(category);
  const extra = attrFilterCount(filters.attrs);
  const place = placeChoice(filters, dicts.status === "ready" ? dicts.data : null, t, lang);
  const side = specs.length > 0;
  const filtered = hasFilters(filters);
  // Цены за гостя и за мероприятие вперемешку — объясняем, как их сравнили; у остальных
  // категорий единицы разные (за час и за мероприятие) — просим смотреть на подпись
  const priceSort = filters.sort !== "capacity_desc";
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

      <CategorySwitch current={filters.category} date={filters.date} />

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
              className={extra > 0 ? "filter-pill filters-open is-on" : "filter-pill filters-open"}
              ref={filtersButton}
              onClick={() => setSheet(true)}
            >
              <Icon name="sliders" size={14} />
              {extra > 0 ? t.moreFiltersN(extra) : t.moreFilters}
            </button>
          ) : null}
          <div className="sort">
            <Select
              size="compact"
              label={t.sortBy}
              icon={<Icon name="sort" size={14} />}
              value={filters.sort ?? DEFAULT_SORT}
              options={sorts.map((sort) => ({ value: sort, label: t[SORT_LABEL[sort]] }))}
              onChange={(sort) => setFilters({ sort: sort === DEFAULT_SORT ? null : sort })}
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
          {loaded && items.length === 0 ? (
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

      {/* Поля витрины на телефоне и планшете — шторкой; выдача за ней меняется сразу */}
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
              disabled={extra === 0}
              onClick={() => setFilters({ attrs: {} })}
            >
              {t.resetFilters}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setSheet(false)}>
              {apply}
            </button>
          </>
        }
      >
        {category ? (
          <AttrFiltersForm
            category={category}
            attrs={filters.attrs}
            onChange={(attrs) => setFilters({ attrs })}
          />
        ) : null}
      </Dialog>
    </div>
  );
}
