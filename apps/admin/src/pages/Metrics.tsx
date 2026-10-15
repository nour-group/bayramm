/* Метрики запуска — только чтение, только числа (все роли). Считает база, определения — одни
   с отчётами бота: ответ вендора (не «связались» от команды), в срок, какие заявки в расчёте
   доли — они в листе «Как считаем», а не абзацами над таблицами.
   Таблица — одна за раз, вкладками: недели (по неделям с заявками), вендоры за 30 дней (сортировка по
   доле ответов в срок), сводка по категориям за 30 дней, контакты витрин за 30 дней (у каких чаще
   открывают контакты и звонят или пишут в Telegram). Фильтр категории — у недель, вендоров и
   контактов (на телефоне — в шторке). Очереди «что ждёт решения» — счётчики у разделов и сами разделы.
   На странице вендора — его ответы строкой (VendorResponsePanel) и ссылка сюда. Полосы — классами:
   CSP не пускает встроенные стили. Вкладка и категория — в адресе (?tab=&category=): «назад» с
   вендора или витрины возвращает те же цифры. */

import type {
  CategoryMetrics,
  CategoryMetricsList,
  ContactMetrics,
  MetricsOverview,
  ResponseStats,
  VendorMetrics,
  VendorMetricsList,
  VendorResponseStats,
  WeeklyMetrics,
} from "@bayramm/shared/api/staff";
import { Dialog, RadioGroup, Select } from "@bayramm/ui/react";
import { useState } from "react";
import { useLoad } from "../api";
import { CategoryChip, categoryName, categoryOptions, knownCategory } from "../categories";
import { formatDuration, formatPercent, formatWeek, vendorLabel, weekNumber } from "../format";
import { useLayout, usePhone } from "../layout";
import { useQueryState } from "../router";
import { t } from "../texts";
import { ActiveFilter, EmptyList, FilterButton, Link, LoadedView, Pill, StatusPill, TableWrap } from "../ui";

/** Меньше половины заявок отвечено в срок — полоса коралловая */
const RATE_LOW = 50;

type Tab = "weeks" | "vendors" | "categories" | "contacts";
const TABS: readonly Tab[] = ["weeks", "vendors", "categories", "contacts"];
/** Вкладки, где фильтр категории что-то сужает; сводка по категориям — сама по категориям */
const FILTERED: ReadonlySet<Tab> = new Set(["weeks", "vendors", "contacts"]);

const KEYS = ["tab", "category"] as const;

export function MetricsPage({ slaHours }: { slaHours?: number | undefined }) {
  const [query, setQuery] = useQueryState(KEYS);
  const tab = TABS.find((candidate) => candidate === query.tab) ?? "weeks";
  const category = FILTERED.has(tab) ? knownCategory(query.category) : null;
  // Категория остаётся в адресе и при взгляде на сводку: вернулись на вкладку — те же цифры
  const setCategory = (next: string | null) => setQuery({ category: next });
  return (
    <div className="stack">
      <RadioGroup<Tab>
        variant="segmented"
        className="choice-segmented metrics-tabs"
        label={t.metrics}
        name="metrics-tab"
        value={tab}
        onChange={(next) => setQuery({ tab: next === "weeks" ? null : next })}
        options={TABS.map((value) => ({ value, label: t.metricsTabs[value] }))}
      />
      <div className="toolbar">
        {FILTERED.has(tab) ? <CategoryFilter category={category} onChange={setCategory} /> : null}
        {tab === "weeks" ? null : <span className="muted small">{t.metricsPeriod}</span>}
        <HowWeCount slaHours={slaHours} />
      </div>
      {tab === "weeks" ? <WeeksTab category={category} onReset={() => setCategory(null)} /> : null}
      {tab === "vendors" ? <VendorsTab category={category} onReset={() => setCategory(null)} /> : null}
      {tab === "categories" ? <CategoriesTab /> : null}
      {tab === "contacts" ? <ContactsTab category={category} onReset={() => setCategory(null)} /> : null}
    </div>
  );
}

/** Определения — одним листом: что считаем «в срок», чьи заявки в доле, за какой период */
function HowWeCount({ slaHours }: { slaHours: number | undefined }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-sm" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        {t.metricsHow}
      </button>
      <Dialog open={open} title={t.metricsHow} onClose={() => setOpen(false)}>
        <dl className="how-we-count">
          {t.metricsHowItems(slaHours).map((item) => (
            <div key={item.term}>
              <dt>{item.term}</dt>
              <dd>{item.text}</dd>
            </div>
          ))}
        </dl>
      </Dialog>
    </>
  );
}

/** Фильтр категории: на компьютере — список, на телефоне — кнопка «Фильтры» и шторка */
function CategoryFilter({
  category,
  onChange,
}: {
  category: string | null;
  onChange: (category: string | null) => void;
}) {
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  if (!phone)
    return (
      <Select
        size="compact"
        label={t.colCategory}
        value={category ?? ""}
        onChange={(code) => onChange(code === "" ? null : code)}
        options={[{ value: "", label: t.allCategories }, ...categoryOptions()]}
      />
    );
  return (
    <>
      <FilterButton count={category === null ? 0 : 1} open={open} onOpen={() => setOpen(true)} />
      {category === null ? null : (
        <ActiveFilter label={categoryName(category)} onClear={() => onChange(null)} />
      )}
      <Dialog
        open={open}
        title={t.filters}
        onClose={() => setOpen(false)}
        actions={
          <button type="button" className="ui-btn ui-btn-primary" onClick={() => setOpen(false)}>
            {t.done}
          </button>
        }
      >
        <RadioGroup<string>
          variant="row"
          label={t.colCategory}
          value={category ?? "all"}
          onChange={(value) => onChange(value === "all" ? null : value)}
          options={[{ value: "all", label: t.allCategories }, ...categoryOptions()]}
        />
      </Dialog>
    </>
  );
}

const filterOf = (category: string | null) =>
  category === null ? "" : `?category=${encodeURIComponent(category)}`;

interface TabProps {
  category: string | null;
  onReset: () => void;
}

function WeeksTab({ category }: TabProps) {
  const overview = useLoad<MetricsOverview>(`/staff/metrics${filterOf(category)}`);
  return (
    <section aria-labelledby="weekly-title">
      <h2 id="weekly-title" className="visually-hidden">
        {t.metricsWeekly}
      </h2>
      <LoadedView loaded={overview.loaded} onRetry={overview.reload}>
        {(data) => <WeeklyTable weeks={data.weeks} />}
      </LoadedView>
    </section>
  );
}

function VendorsTab({ category, onReset }: TabProps) {
  const vendors = useLoad<VendorMetricsList>(`/staff/metrics/vendors${filterOf(category)}`);
  return (
    <section aria-labelledby="vendors-metrics-title">
      <h2 id="vendors-metrics-title" className="visually-hidden">
        {t.metricsVendors}
      </h2>
      <LoadedView loaded={vendors.loaded} onRetry={vendors.reload}>
        {(list) =>
          list.items.length === 0 ? (
            // Пусто из-за категории — снять фильтр одной кнопкой
            <EmptyList text={t.metricsVendorsEmpty} onReset={category ? onReset : null} />
          ) : (
            <VendorTable items={list.items} />
          )
        }
      </LoadedView>
    </section>
  );
}

function CategoriesTab() {
  const categories = useLoad<CategoryMetricsList>("/staff/metrics/categories");
  return (
    <section aria-labelledby="categories-metrics-title">
      <h2 id="categories-metrics-title" className="visually-hidden">
        {t.metricsCategories}
      </h2>
      <LoadedView loaded={categories.loaded} onRetry={categories.reload}>
        {(list) => <CategoryTable items={list.items} />}
      </LoadedView>
    </section>
  );
}

// ── доля ответов в срок ────────────────────────────────────────────────────

/** Ширина полосы — класс с шагом 10 % (встроенных стилей нет) */
export function barClass(rate: number | null): string {
  const step = rate === null ? 0 : Math.min(10, Math.max(0, Math.round(rate / 10)));
  return `bar-fill bar-w${step}${rate !== null && rate < RATE_LOW ? " bar-low" : ""}`;
}

/** Доля ответов в срок: полоса (для глаза), процент и «a из b» (для чтения) */
function Rate({
  stats,
  partial = false,
}: {
  stats: Pick<ResponseStats, "answeredRate" | "answeredInTime" | "measurable">;
  /** Неделя ещё идёт: доли нет — сколько уже ответили в срок, словами */
  partial?: boolean;
}) {
  if (partial && stats.answeredRate === null)
    return <span className="sub">{t.weekInProgress(stats.answeredInTime, stats.measurable)}</span>;
  return (
    <div className="rate">
      <span className="bar" aria-hidden="true">
        <span className={barClass(stats.answeredRate)} />
      </span>
      <span className="rate-value">{formatPercent(stats.answeredRate)}</span>
      <span className="sub">{t.answeredOf(stats.answeredInTime, stats.measurable)}</span>
    </div>
  );
}

type Numbers = Pick<
  ResponseStats,
  "requests" | "answeredRate" | "medianResponseMinutes" | "slaBreaches" | "answeredInTime" | "measurable"
>;

/**
 * Главные числа одной строкой: заявок · в срок · медиана ответа (и «срок сорван», когда он был).
 * Карточка телефона и страница вендора — таблицы там не нужны
 */
export function statLine(stats: Numbers, partial = false): string {
  return [
    t.requestsOf(stats.requests),
    // Неделя идёт и доли ещё нет — не «в срок —», а сколько уже ответили
    partial && stats.answeredRate === null
      ? t.weekInProgress(stats.answeredInTime, stats.measurable)
      : t.inTimeShort(formatPercent(stats.answeredRate)),
    t.medianTime(formatDuration(stats.medianResponseMinutes)),
    stats.slaBreaches > 0 ? t.breachesShort(stats.slaBreaches) : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

// ── по неделям ─────────────────────────────────────────────────────────────

function WeeklyTable({ weeks }: { weeks: readonly WeeklyMetrics[] }) {
  // Уже компьютера таблица шире экрана — карточками, как на телефоне
  const phone = useLayout() !== "desktop";
  if (phone)
    return (
      <ul className="rcards">
        {weeks.map((week) => (
          <li key={week.weekStart} className="rcard">
            <div className="rcard-head">
              <p className="rcard-title">{formatWeek(week.weekStart)}</p>
              {week.partial && <Pill tone="outline">{t.weekNow}</Pill>}
            </div>
            <p className="rcard-meta">{statLine(week, week.partial)}</p>
          </li>
        ))}
      </ul>
    );
  return (
    <TableWrap label={t.metricsWeekly}>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">{t.colWeek}</th>
            <th scope="col">{t.colRequests}</th>
            <th scope="col">{t.colAnswered}</th>
            <th scope="col">{t.colMedian}</th>
            <th scope="col">{t.colBreaches}</th>
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week.weekStart}>
              <th scope="row" className="row-head">
                {formatWeek(week.weekStart)}
                <span className="sub">
                  {weekNumber(week.weekLabel)} {week.partial && <Pill tone="outline">{t.weekNow}</Pill>}
                </span>
              </th>
              <td>{week.requests}</td>
              <td>
                <Rate stats={week} partial={week.partial} />
              </td>
              <td>{formatDuration(week.medianResponseMinutes)}</td>
              <td>{week.slaBreaches}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

// ── по категориям ──────────────────────────────────────────────────────────

function CategoryTable({ items }: { items: readonly CategoryMetrics[] }) {
  // Уже компьютера таблица шире экрана — карточками, как на телефоне
  const phone = useLayout() !== "desktop";
  if (phone)
    return (
      <ul className="rcards">
        {items.map((row) => (
          <li key={row.categoryCode} className="rcard">
            <div className="rcard-head">
              <p className="rcard-title">{categoryName(row.categoryCode)}</p>
            </div>
            <p className="rcard-meta">
              {t.activeListings(row.activeListings)} · {t.activeVendors(row.activeVendors)}
            </p>
            <p className="rcard-meta">{statLine(row)}</p>
          </li>
        ))}
      </ul>
    );
  return (
    <TableWrap label={t.metricsCategories}>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">{t.colCategory}</th>
            <th scope="col">{t.colRequests}</th>
            <th scope="col">{t.colAnswered}</th>
            <th scope="col">{t.colMedian}</th>
            <th scope="col">{t.colBreaches}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((row) => (
            <tr key={row.categoryCode}>
              <th scope="row" className="row-head">
                {categoryName(row.categoryCode)}
                <span className="sub">
                  {t.activeListings(row.activeListings)} · {t.activeVendors(row.activeVendors)}
                </span>
              </th>
              <td>{row.requests}</td>
              <td>
                <Rate stats={row} />
              </td>
              <td>{formatDuration(row.medianResponseMinutes)}</td>
              <td>{row.slaBreaches}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

/** «опубликовано витрин: 2 · Тойхона, Кортеж» */
const vendorMeta = (row: VendorMetrics) =>
  [t.activeListings(row.activeListings), row.categories.map(categoryName).join(", ")]
    .filter((part) => part !== "")
    .join(" · ");

// ── по вендорам ────────────────────────────────────────────────────────────

type SortKey = "rate" | "requests" | "median";
type Sort = { readonly key: SortKey; readonly dir: "asc" | "desc" };

const SORT_VALUE: Record<SortKey, (v: VendorMetrics) => number | null> = {
  rate: (v) => v.answeredRate,
  requests: (v) => v.requests,
  median: (v) => v.medianResponseMinutes,
};

/** Сортировка вендоров: пустые значения — всегда внизу; при равенстве — по коду */
export function sortVendors(items: readonly VendorMetrics[], sort: Sort): VendorMetrics[] {
  const value = SORT_VALUE[sort.key];
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    if (x === null || y === null) {
      if (x !== y) return x === null ? 1 : -1;
    } else if (x !== y) return (x - y) * sign;
    return a.vendor.code.localeCompare(b.vendor.code, "ru", { numeric: true });
  });
}

// Первым нажатием: доля — худшие сверху, заявки — больше сверху, медиана — дольше сверху
const FIRST_DIR: Record<SortKey, Sort["dir"]> = { rate: "asc", requests: "desc", median: "desc" };

function SortHeader({
  label,
  column,
  sort,
  onSort,
}: {
  label: string;
  column: SortKey;
  sort: Sort;
  onSort: (sort: Sort) => void;
}) {
  const active = sort.key === column;
  const next: Sort = active
    ? { key: column, dir: sort.dir === "asc" ? "desc" : "asc" }
    : { key: column, dir: FIRST_DIR[column] };
  return (
    <th scope="col" aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className="sort" onClick={() => onSort(next)}>
        {label}
        <span className="sort-mark" aria-hidden="true">
          {active ? (sort.dir === "asc" ? "↑" : "↓") : "↕"}
        </span>
        {active && <span className="visually-hidden">, {sort.dir === "asc" ? t.sortAsc : t.sortDesc}</span>}
      </button>
    </th>
  );
}

/** Сортировки шторки телефона: столбец и направление — одним выбором */
const SORT_OPTIONS: readonly { readonly value: string; readonly sort: Sort; readonly label: string }[] = [
  { value: "rate-asc", sort: { key: "rate", dir: "asc" }, label: t.sortRateAsc },
  { value: "rate-desc", sort: { key: "rate", dir: "desc" }, label: t.sortRateDesc },
  { value: "requests-desc", sort: { key: "requests", dir: "desc" }, label: t.sortRequestsDesc },
  { value: "median-desc", sort: { key: "median", dir: "desc" }, label: t.sortMedianDesc },
];

const sortValue = (sort: Sort) => `${sort.key}-${sort.dir}`;

function VendorCards({
  rows,
  sort,
  onSort,
}: {
  rows: VendorMetrics[];
  sort: Sort;
  onSort: (s: Sort) => void;
}) {
  const [open, setOpen] = useState(false);
  const chosen = SORT_OPTIONS.find((option) => option.value === sortValue(sort));
  return (
    <div className="stack">
      <div className="toolbar">
        <FilterButton count={0} open={open} onOpen={() => setOpen(true)} label={t.sort} />
        {chosen ? <span className="muted small">{chosen.label}</span> : null}
      </div>
      <Dialog
        open={open}
        title={t.sort}
        onClose={() => setOpen(false)}
        actions={
          <button type="button" className="ui-btn ui-btn-primary" onClick={() => setOpen(false)}>
            {t.done}
          </button>
        }
      >
        <RadioGroup
          variant="row"
          label={t.sort}
          value={chosen?.value ?? null}
          onChange={(value) => {
            const next = SORT_OPTIONS.find((option) => option.value === value);
            if (next) onSort(next.sort);
          }}
          options={SORT_OPTIONS.map(({ value, label }) => ({ value, label }))}
        />
      </Dialog>
      <ul className="rcards">
        {rows.map((row) => (
          <li key={row.vendor.id} className="rcard rcard-tap">
            <div className="rcard-head">
              <Link to={{ name: "vendor", id: row.vendor.id }} className="rcard-link">
                {vendorLabel(row.vendor)}
              </Link>
            </div>
            <p className="rcard-meta">{vendorMeta(row)}</p>
            <p className="rcard-meta">{statLine(row)}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function VendorTable({ items }: { items: readonly VendorMetrics[] }) {
  // Уже компьютера таблица шире экрана — карточками, как на телефоне
  const phone = useLayout() !== "desktop";
  const [sort, setSort] = useState<Sort>({ key: "rate", dir: "asc" });
  const rows = sortVendors(items, sort);
  if (phone) return <VendorCards rows={rows} sort={sort} onSort={setSort} />;
  return (
    <TableWrap label={t.metricsVendors}>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">{t.colVendor}</th>
            <SortHeader label={t.colRequests} column="requests" sort={sort} onSort={setSort} />
            <SortHeader label={t.colAnswered} column="rate" sort={sort} onSort={setSort} />
            <SortHeader label={t.colMedian} column="median" sort={sort} onSort={setSort} />
            <th scope="col">{t.colBreaches}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.vendor.id}>
              <th scope="row" className="row-head">
                <Link to={{ name: "vendor", id: row.vendor.id }} className="row-link">
                  {vendorLabel(row.vendor)}
                </Link>
                <span className="sub">{vendorMeta(row)}</span>
              </th>
              <td>{row.requests}</td>
              <td>
                <Rate stats={row} />
              </td>
              <td>{formatDuration(row.medianResponseMinutes)}</td>
              <td>{row.slaBreaches}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

// ── контакты витрин ────────────────────────────────────────────────────────

type ContactRow = ContactMetrics["items"][number];

/** Контакты витрин за 30 дней: сколько раз открыли окно контактов, позвонили, написали в Telegram */
function ContactsTab({ category, onReset }: TabProps) {
  const query = new URLSearchParams({ days: "30" });
  if (category !== null) query.set("category", category);
  const { loaded, reload } = useLoad<ContactMetrics>(`/staff/metrics/contacts?${query}`);
  return (
    <section aria-labelledby="contacts-metrics-title">
      <h2 id="contacts-metrics-title" className="visually-hidden">
        {t.metricsContacts}
      </h2>
      <LoadedView loaded={loaded} onRetry={reload}>
        {(data) =>
          data.items.length === 0 ? (
            <EmptyList text={t.metricsContactsEmpty} onReset={category ? onReset : null} />
          ) : (
            <ContactTable items={data.items} days={data.days} />
          )
        }
      </LoadedView>
    </section>
  );
}

/**
 * Открытия к предыдущему такому же периоду: «+4 · было 8» — знак и число видны без цвета, диктору
 * то же словами (на сколько больше или меньше и сколько было)
 */
function OpensChange({ row, days }: { row: ContactRow; days: number }) {
  return (
    <span className="sub">
      <span aria-hidden="true">{t.opensChange(row.opens, row.opensPrev)}</span>
      <span className="visually-hidden">{t.opensChangeSpoken(row.opens, row.opensPrev, days)}</span>
    </span>
  );
}

function ContactTable({ items, days }: { items: readonly ContactRow[]; days: number }) {
  // Уже компьютера таблица шире экрана — карточками, как на телефоне
  const phone = useLayout() !== "desktop";
  if (phone)
    return (
      <ul className="rcards">
        {items.map((row) => (
          <li key={row.listing.id} className="rcard rcard-tap">
            <div className="rcard-head">
              <Link to={{ name: "listing", id: row.listing.id }} className="rcard-link">
                {row.listing.name}
              </Link>
              <StatusPill status={row.listing.status} />
            </div>
            <p className="rcard-meta">
              <CategoryChip code={row.listing.categoryCode} /> {row.vendor.name}
            </p>
            <dl className="rcard-facts">
              <dt>{t.colContactOpens}</dt>
              <dd>
                {row.opens}
                <OpensChange row={row} days={days} />
              </dd>
              <dt>{t.colContactPhone}</dt>
              <dd>{row.phone}</dd>
              <dt>{t.colContactTelegram}</dt>
              <dd>{row.telegram}</dd>
            </dl>
          </li>
        ))}
      </ul>
    );
  return (
    <TableWrap label={t.metricsContacts}>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">{t.listings}</th>
            <th scope="col">{t.colContactOpens}</th>
            <th scope="col">{t.colContactPhone}</th>
            <th scope="col">{t.colContactTelegram}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((row) => (
            <tr key={row.listing.id}>
              <th scope="row" className="row-head">
                <Link to={{ name: "listing", id: row.listing.id }} className="row-link">
                  {row.listing.name}
                </Link>{" "}
                <StatusPill status={row.listing.status} />
                <span className="sub">
                  <CategoryChip code={row.listing.categoryCode} />{" "}
                  <Link to={{ name: "vendor", id: row.vendor.id }}>{row.vendor.name}</Link>
                </span>
              </th>
              <td>
                {row.opens}
                <OpensChange row={row} days={days} />
              </td>
              <td>{row.phone}</td>
              <td>{row.telegram}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

// ── страница вендора ───────────────────────────────────────────────────────

/** Ответы вендора на заявки за 30 дней: одна строка и ссылка на метрики вендоров */
export function VendorResponsePanel({ vendorId }: { vendorId: string }) {
  const { loaded, reload } = useLoad<VendorResponseStats>(`/staff/metrics/vendors/${vendorId}`);
  return (
    <section className="panel" aria-labelledby="response-title">
      <div className="panel-head">
        <h2 id="response-title">{t.vendorResponse}</h2>
        <Link to={{ name: "metrics", query: { tab: "vendors" } }}>{t.metrics}</Link>
      </div>
      <LoadedView loaded={loaded} onRetry={reload}>
        {(stats) =>
          stats.vendor.requests === 0 ? (
            <p className="muted">{t.vendorResponseEmpty}</p>
          ) : (
            <p>{statLine(stats.vendor)}</p>
          )
        }
      </LoadedView>
    </section>
  );
}
