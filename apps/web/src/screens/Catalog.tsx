import type { CatalogSort } from "@bayramm/shared/api";
import { categoryText } from "@bayramm/shared/categories";
import { DateField, Dialog, NumberStepper, Select } from "@bayramm/ui/react";
import { useEffect, useId, useRef, useState } from "react";
import { clientCategory, hasCalendar, hasCapacity, hasDistrict } from "../categories";
import { AttrFiltersForm } from "../components/AttrFilters";
import { useCalendarTexts } from "../components/Calendar";
import { CategorySwitch } from "../components/Categories";
import { ListingCard } from "../components/ListingCard";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { pick, useDictionaries, useLang, useServices } from "../context";
import { addDays, formatDayMonth, tashkentToday } from "../format";
import { useDocumentTitle } from "../hooks";
import { Icon } from "../icons";
import { DEFAULT_CATEGORY, hrefFor, useNav } from "../router";
import {
  busyLast,
  type CatalogFilters,
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

/* Каталог категории (/catalog?category=…): переключатель категорий, общие фильтры (дата;
   гости и район — где они есть), фильтры по полям витрины (колонка слева на компьютере,
   шторка «Фильтры» на телефоне и планшете), порядок и сетка карточек. Всё — в адресе. */

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
      <NumberStepper
        id={id}
        min={1}
        max={MAX_GUESTS}
        placeholder={t.anyGuestV}
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
  const category = clientCategory(filters.category);
  const specs = filterSpecs(category);
  const feed = useCatalogFeed(api, filters);
  const calendarTexts = useCalendarTexts();
  const dateId = useId();
  const districtId = useId();
  const sentinel = useRef<HTMLDivElement>(null);
  const filtersButton = useRef<HTMLButtonElement>(null);
  const [sheet, setSheet] = useState(false);
  const name = categoryText(lang, category.label);
  const title = category.code === DEFAULT_CATEGORY ? t.hallsTitle : t.catTitle(name);
  useDocumentTitle(title);

  const setFilters = (patch: Partial<CatalogFilters>) =>
    navigate(hrefFor({ name: "catalog" }, filtersQuery({ ...filters, ...patch })), { replace: true });
  const reset = () =>
    navigate(hrefFor({ name: "catalog" }, filtersQuery(noFiltersIn(category.code))), { replace: true });

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
  const sorts = sortsOf(category.code);
  const extra = attrFilterCount(filters.attrs);
  // Цены за гостя и за мероприятие вперемешку — объясняем, как их сравнили; у остальных
  // категорий единицы разные (за час и за мероприятие) — просим смотреть на подпись
  const priceSort = filters.sort !== "capacity_desc";
  const units = new Set(items.map((i) => i.priceUnit));
  const hallUnits = units.has("per_guest") && units.has("per_event");
  const sortHint = !priceSort
    ? null
    : hallUnits
      ? filters.guests === null
        ? t.sortHintPerGuest
        : t.sortHintTotal(filters.guests)
      : units.size > 1
        ? t.sortHintUnits
        : null;
  const empty = hasFilters(filters)
    ? { title: t.empty_h, text: hasCapacity(category) ? t.emptyHint : t.emptyHintCat }
    : category.code === DEFAULT_CATEGORY
      ? { title: t.noVenues_h, text: t.noVenues }
      : { title: t.catSoonH(name), text: t.catSoonP };

  return (
    <div className="screen catalog">
      <CategorySwitch current={category.code} date={filters.date} />

      <section
        className={hasCapacity(category) || hasDistrict(category) ? "filters" : "filters solo"}
        aria-label={t.cats}
      >
        <div className="field">
          <label className="field-label" htmlFor={dateId}>
            {t.fDate}
          </label>
          <DateField
            id={dateId}
            label={t.fDate}
            placeholder={t.anyDateV}
            value={filters.date}
            min={today}
            max={addDays(today, DATE_HORIZON_DAYS)}
            format={(date) => formatDayMonth(date, t)}
            texts={calendarTexts}
            clearLabel={t.anyDate}
            onChange={(date) => setFilters({ date })}
          />
        </div>
        {hasCapacity(category) ? (
          <GuestsField value={filters.guests} onCommit={(guests) => setFilters({ guests })} />
        ) : null}
        {hasDistrict(category) ? (
          <div className="field">
            <label className="field-label" htmlFor={districtId}>
              {t.fDistrict}
            </label>
            <Select
              id={districtId}
              label={t.fDistrict}
              value={filters.district ?? ""}
              options={[
                { value: "", label: t.anyDistrict },
                ...districts.map((district) => ({ value: district.code, label: pick(district.name, lang) })),
              ]}
              onChange={(district) => setFilters({ district: district || null })}
            />
          </div>
        ) : null}
      </section>
      {/* Без календаря (цветы, торты, подарки) дата не отсекает — она уйдёт в заявку */}
      {filters.date && !hasCalendar(category) ? (
        <p className="muted small date-note">{t.leadDateNote}</p>
      ) : null}

      <div className={specs.length > 0 ? "catalog-body has-side" : "catalog-body"}>
        {specs.length > 0 ? (
          <aside className="filters-side" aria-labelledby={`${dateId}-side`}>
            <h2 className="section-title" id={`${dateId}-side`}>
              {t.moreFilters}
            </h2>
            <AttrFiltersForm
              category={category}
              attrs={filters.attrs}
              onChange={(attrs) => setFilters({ attrs })}
            />
          </aside>
        ) : null}

        <div className="catalog-list">
          <div className="list-head">
            <div>
              <h1 className="screen-title" tabIndex={-1}>
                {title}
              </h1>
              <p className="muted small">{t.note}</p>
            </div>
            <div className="list-tools">
              {specs.length > 0 ? (
                <button
                  type="button"
                  className="btn btn-secondary filters-open"
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
                  icon={<Icon name="sliders" size={14} />}
                  value={filters.sort ?? DEFAULT_SORT}
                  options={sorts.map((sort) => ({ value: sort, label: t[SORT_LABEL[sort]] }))}
                  onChange={(sort) => setFilters({ sort: sort === DEFAULT_SORT ? null : sort })}
                />
              </div>
            </div>
            {sortHint ? <p className="muted small sort-hint">{sortHint}</p> : null}
          </div>

          {feed.status === "loading" ? <Loading /> : null}
          {feed.status === "error" ? <ErrorState onRetry={feed.retry} /> : null}
          {/* Пусто без фильтров — витрин ещё нет: «под эти условия никого» тут было бы неправдой */}
          {feed.status !== "loading" && feed.status !== "error" && items.length === 0 ? (
            <EmptyState
              title={empty.title}
              text={empty.text}
              action={
                hasFilters(filters) ? (
                  <button type="button" className="btn btn-secondary" onClick={reset}>
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
      </div>

      {/* Фильтры на телефоне и планшете — шторкой; выдача за ней меняется сразу */}
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
              {t.filtersApply}
            </button>
          </>
        }
      >
        <AttrFiltersForm
          category={category}
          attrs={filters.attrs}
          onChange={(attrs) => setFilters({ attrs })}
        />
      </Dialog>
    </div>
  );
}
