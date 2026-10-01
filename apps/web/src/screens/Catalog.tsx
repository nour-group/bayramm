import type { CatalogSort } from "@bayramm/shared/api";
import { DateField, Dialog, NumberStepper, Select } from "@bayramm/ui/react";
import { useEffect, useId, useRef, useState } from "react";
import { categoryName, clientCategory, hasCalendar, hasCapacity, hasDistrict } from "../categories";
import { AttrFiltersForm } from "../components/AttrFilters";
import { useCalendarTexts } from "../components/Calendar";
import { CategorySwitch } from "../components/Categories";
import { CARD_PHOTO_SIZES, CARD_PHOTO_SIZES_SIDE, ListingCard } from "../components/ListingCard";
import { CardsLoading, EmptyState, ErrorState, Loading } from "../components/States";
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
  noFiltersIn,
  parseGuests,
  readFilters,
  sortsOf,
  useCatalogFeed,
} from "./catalog-feed";
import { attrFilterCount, filterSpecs } from "./catalog-filters";

/* Каталог раздела (/catalog?category=…): заголовок, переключатель разделов, фильтры, порядок и
   сетка карточек. Всё — в адресе. Фильтры — одним блоком «Фильтры»: на телефоне и планшете
   дата (гости и район — где они есть) над выдачей, поля витрины — в шторке «Фильтры»; на
   компьютере весь блок — колонкой слева, прилипает при прокрутке. */

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
  const ids = useId();
  const sentinel = useRef<HTMLDivElement>(null);
  const filtersButton = useRef<HTMLButtonElement>(null);
  const [sheet, setSheet] = useState(false);
  const name = categoryName(category.code, t, lang) ?? category.code;
  const title = t.catTitle(name);
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
  const side = specs.length > 0;
  const filtered = hasFilters(filters);
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
  // Пусто с фильтрами — «никого не нашли» и сброс; без фильтров — в разделе ещё никого: «скоро»
  const empty = filtered
    ? { title: t.emptyH, text: hasCapacity(category) ? t.emptyHint : t.emptyHintCat }
    : { title: t.catSoonH(name), text: t.catSoonP };
  const loaded = feed.status !== "loading" && feed.status !== "error";
  // Кнопка шторки показывает, сколько нашлось (пока выдача грузится — просто «Показать»)
  const apply = loaded ? t.filtersShowN(items.length, feed.hasMore) : t.filtersApply;

  return (
    <div className="screen catalog">
      <div className="catalog-head">
        <h1 className="screen-title" tabIndex={-1}>
          {title}
        </h1>
        <p className="muted small">{t.catalogNote}</p>
      </div>

      <CategorySwitch current={category.code} date={filters.date} />

      <div className={side ? "catalog-body has-side" : "catalog-body"}>
        <section className="filters-panel" aria-labelledby={`${ids}-filters`}>
          {/* Заголовок колонки фильтров — виден только колонкой (компьютер); диктору — всегда */}
          <h2 className="section-title filters-title" id={`${ids}-filters`}>
            {t.moreFilters}
          </h2>
          <div className={hasCapacity(category) || hasDistrict(category) ? "filters" : "filters solo"}>
            <div className="field">
              <label className="field-label" htmlFor={`${ids}-date`}>
                {t.fDate}
              </label>
              <DateField
                id={`${ids}-date`}
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
                <label className="field-label" htmlFor={`${ids}-district`}>
                  {t.fDistrict}
                </label>
                <Select
                  id={`${ids}-district`}
                  label={t.fDistrict}
                  value={filters.district ?? ""}
                  options={[
                    { value: "", label: t.anyDistrict },
                    ...districts.map((district) => ({
                      value: district.code,
                      label: pick(district.name, lang),
                    })),
                  ]}
                  onChange={(district) => setFilters({ district: district || null })}
                />
              </div>
            ) : null}
          </div>
          {/* Без календаря (цветы, торты, подарки) дата не отсекает — она уйдёт в заявку */}
          {filters.date && !hasCalendar(category) ? (
            <p className="muted small date-note">{t.leadDateNote}</p>
          ) : null}
          {side ? (
            <div className="filters-side">
              <AttrFiltersForm
                category={category}
                attrs={filters.attrs}
                onChange={(attrs) => setFilters({ attrs })}
              />
            </div>
          ) : null}
          {filtered ? (
            <button type="button" className="link-btn filters-reset" onClick={reset}>
              {t.resetFilters}
            </button>
          ) : null}
        </section>

        <div className="catalog-list">
          <div className="list-tools">
            {side ? (
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
          {sortHint && items.length > 0 ? <p className="muted small sort-hint">{sortHint}</p> : null}

          {feed.status === "loading" ? <CardsLoading /> : null}
          {feed.status === "error" ? <ErrorState onRetry={feed.retry} /> : null}
          {loaded && items.length === 0 ? (
            <EmptyState
              title={empty.title}
              text={empty.text}
              action={
                filtered ? (
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
                  <ListingCard
                    card={card}
                    date={filters.date}
                    guests={filters.guests}
                    eager={i < EAGER_CARDS}
                    priority={i === 0}
                    sizes={side ? CARD_PHOTO_SIZES_SIDE : CARD_PHOTO_SIZES}
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
        <AttrFiltersForm
          category={category}
          attrs={filters.attrs}
          onChange={(attrs) => setFilters({ attrs })}
        />
      </Dialog>
    </div>
  );
}
