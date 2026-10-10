/* Метрики запуска — только чтение, только числа (все роли). Считает база, определения — одни
   с отчётами бота: ответ вендора (не «связались» от команды), в срок, какие заявки в расчёте
   доли. Здесь — очереди команды (плитка — ссылка в раздел, где очередь разбирают, если он есть
   у роли), сводка по категориям за 30 дней, таблица по неделям и вендоры
   за 30 дней с сортировкой по доле ответов в срок; фильтр категории — у недель и вендоров
   (на телефоне — в шторке). Ниже вендоров — «Контакты витрин»: у каких витрин чаще открывают
   контакты и звонят или пишут в Telegram (те же 30 дней и тот же фильтр категории). На странице
   вендора — его ответы по витринам с категориями (VendorResponsePanel). Полосы — классами:
   CSP не пускает встроенные стили. Фильтр категории — в адресе (?category=): «назад» с
   вендора или витрины возвращает те же цифры. */

import type {
  CategoryMetrics,
  CategoryMetricsList,
  ContactMetrics,
  ListingMetrics,
  MetricsOverview,
  OpsQueues,
  ResponseStats,
  VendorMetrics,
  VendorMetricsList,
  VendorResponseStats,
  WeeklyMetrics,
} from "@bayramm/shared/api/staff";
import { Dialog, RadioGroup, Select } from "@bayramm/ui/react";
import { useState } from "react";
import { useCan, useLoad } from "../api";
import { CategoryChip, categoryName, categoryOptions, knownCategory } from "../categories";
import { formatDuration, formatMoment, formatPercent, formatWeek, vendorLabel, weekNumber } from "../format";
import { usePhone } from "../layout";
import { SECTION_PERMISSION, sectionOf, useQueryState, type View } from "../router";
import { t } from "../texts";
import { ActiveFilter, EmptyList, FilterButton, Link, LoadedView, Pill, StatusPill } from "../ui";

/** Меньше половины заявок отвечено в срок — полоса коралловая */
const RATE_LOW = 50;

const QUEUES: readonly (keyof OpsQueues)[] = [
  "awaiting",
  "overdue",
  "deadTotal",
  "listingsReview",
  "revisionsPending",
  "servicesPending",
  "photosPending",
];
/**
 * Где очередь разбирают: плитка «Сейчас» ведёт туда — сразу к нужной очереди или с нужным
 * фильтром (просроченные заявки — «Требуют действия»)
 */
const QUEUE_LINK: Readonly<Record<keyof OpsQueues, View>> = {
  awaiting: { name: "requests" },
  overdue: { name: "requests", query: { sla: "late" } },
  deadTotal: { name: "notifications" },
  listingsReview: { name: "moderation", query: { queue: "review" } },
  revisionsPending: { name: "moderation", query: { queue: "revisions" } },
  servicesPending: { name: "moderation", query: { queue: "services" } },
  photosPending: { name: "moderation", query: { queue: "photos" } },
};
/** Эти очереди, если не пусты, — выделить */
const QUEUE_WARN: ReadonlySet<keyof OpsQueues> = new Set(["overdue", "deadTotal"]);

export function MetricsPage() {
  const [query, setQuery] = useQueryState(["category"] as const);
  const category = knownCategory(query.category);
  const setCategory = (next: string | null) => setQuery({ category: next });
  const filter = category === null ? "" : `?category=${encodeURIComponent(category)}`;
  const overview = useLoad<MetricsOverview>(`/staff/metrics${filter}`);
  const vendors = useLoad<VendorMetricsList>(`/staff/metrics/vendors${filter}`);
  const categories = useLoad<CategoryMetricsList>("/staff/metrics/categories");
  return (
    <div className="stack">
      <LoadedView loaded={overview.loaded} onRetry={overview.reload} skeleton="stats">
        {(data) => (
          <section className="stack" aria-labelledby="queues-title">
            <h2 id="queues-title" className="section-title">
              {t.metricsNow}
            </h2>
            <Queues queues={data.queues} />
          </section>
        )}
      </LoadedView>
      <section className="stack" aria-labelledby="categories-metrics-title">
        <h2 id="categories-metrics-title" className="section-title">
          {t.metricsCategories}
        </h2>
        <p className="muted small">{t.metricsCategoriesHint}</p>
        <LoadedView loaded={categories.loaded} onRetry={categories.reload}>
          {(list) => <CategoryTable items={list.items} />}
        </LoadedView>
      </section>
      <CategoryFilter category={category} onChange={setCategory} />
      <LoadedView loaded={overview.loaded} onRetry={overview.reload} skeleton="stats">
        {(data) => (
          <section className="stack" aria-labelledby="weekly-title">
            <h2 id="weekly-title" className="section-title">
              {t.metricsWeekly}
            </h2>
            <p className="muted small">{t.metricsWeeklyHint(data.slaHours)}</p>
            <WeeklyTable weeks={data.weeks} />
          </section>
        )}
      </LoadedView>
      <section className="stack" aria-labelledby="vendors-metrics-title">
        <h2 id="vendors-metrics-title" className="section-title">
          {t.metricsVendors}
        </h2>
        <p className="muted small">{t.metricsVendorsHint}</p>
        <LoadedView loaded={vendors.loaded} onRetry={vendors.reload}>
          {(list) =>
            list.items.length === 0 ? (
              // Пусто из-за категории — снять фильтр одной кнопкой
              <EmptyList text={t.metricsVendorsEmpty} onReset={category ? () => setCategory(null) : null} />
            ) : (
              <VendorTable items={list.items} />
            )
          }
        </LoadedView>
      </section>
      <ContactsSection category={category} onReset={() => setCategory(null)} />
    </div>
  );
}

/** Фильтр категории недель и вендоров: на компьютере — список, на телефоне — шторка */
function CategoryFilter({
  category,
  onChange,
}: {
  category: string | null;
  onChange: (category: string | null) => void;
}) {
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  // Что именно фильтр сужает — всегда словами: он стоит между сводкой по категориям и неделями
  const hint = (
    <p className="muted small">
      {category === null ? t.metricsFilterScope : t.metricsCategoryFilter(categoryName(category))}
    </p>
  );
  if (!phone)
    return (
      <div className="stack">
        <div className="toolbar">
          <Select
            size="compact"
            label={t.colCategory}
            value={category ?? ""}
            onChange={(code) => onChange(code === "" ? null : code)}
            options={[{ value: "", label: t.allCategories }, ...categoryOptions()]}
          />
        </div>
        {hint}
      </div>
    );
  return (
    <div className="stack">
      <div className="toolbar">
        <FilterButton count={category === null ? 0 : 1} open={open} onOpen={() => setOpen(true)} />
      </div>
      {category === null ? null : (
        <ActiveFilter label={categoryName(category)} onClear={() => onChange(null)} />
      )}
      {hint}
      <Dialog
        open={open}
        title={t.filters}
        onClose={() => setOpen(false)}
        actions={
          <button type="button" className="ui-btn ui-btn-primary sheet-done" onClick={() => setOpen(false)}>
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
    </div>
  );
}

function Queues({ queues }: { queues: OpsQueues }) {
  const can = useCan();
  return (
    <ul className="stats">
      {QUEUES.map((key) => {
        const className = `stat${QUEUE_WARN.has(key) && queues[key] > 0 ? " stat-warn" : ""}`;
        const link = QUEUE_LINK[key];
        const body = (
          <>
            <span className="stat-value">{queues[key]}</span>
            <span className="stat-label">{t.metricsQueues[key]}</span>
          </>
        );
        // Раздела у роли нет (модератору — заявки): плитка без ссылки, иначе — «нет доступа»
        return can(SECTION_PERMISSION[sectionOf(link)]) ? (
          <li key={key}>
            <Link to={link} className={`${className} stat-link`}>
              {body}
            </Link>
          </li>
        ) : (
          <li key={key} className={className}>
            {body}
          </li>
        );
      })}
    </ul>
  );
}

// ── доля ответов в срок ────────────────────────────────────────────────────

/** Ширина полосы — класс с шагом 10 % (встроенных стилей нет) */
export function barClass(rate: number | null): string {
  const step = rate === null ? 0 : Math.min(10, Math.max(0, Math.round(rate / 10)));
  return `bar-fill bar-w${step}${rate !== null && rate < RATE_LOW ? " bar-low" : ""}`;
}

/** Доля ответов в срок: полоса (для глаза), процент и «a из b» (для чтения) */
function Rate({ stats }: { stats: Pick<ResponseStats, "answeredRate" | "answeredInTime" | "measurable"> }) {
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

// ── по неделям ─────────────────────────────────────────────────────────────

function WeeklyTable({ weeks }: { weeks: readonly WeeklyMetrics[] }) {
  const phone = usePhone();
  if (phone)
    return (
      <ul className="rcards">
        {weeks.map((week) => (
          <li key={week.weekStart} className="rcard">
            <div className="rcard-head">
              <p className="rcard-title">{formatWeek(week.weekStart)}</p>
              {week.partial && <Pill tone="outline">{t.weekNow}</Pill>}
            </div>
            <p className="rcard-meta">{weekNumber(week.weekLabel)}</p>
            <Rate stats={week} />
            <dl className="rcard-facts">
              <dt>{t.colRequests}</dt>
              <dd>
                {week.requests} · {t.clientsCount(week.clients)}
              </dd>
              <dt>{t.colResponseTime}</dt>
              <dd>
                {t.medianTime(formatDuration(week.medianResponseMinutes))} ·{" "}
                {t.p90Time(formatDuration(week.p90ResponseMinutes))}
              </dd>
              <dt>{t.colAgreed}</dt>
              <dd>
                {week.agreed} · {formatPercent(week.agreedRate)}
              </dd>
              <dt>{t.colBreaches}</dt>
              <dd>{week.slaBreaches}</dd>
              <dt>{t.colDead}</dt>
              <dd>{week.deadNotifications}</dd>
            </dl>
          </li>
        ))}
      </ul>
    );
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">{t.colWeek}</th>
            <th scope="col">{t.colRequests}</th>
            <th scope="col">{t.colAnswered}</th>
            <th scope="col">{t.colResponseTime}</th>
            <th scope="col">{t.colAgreed}</th>
            <th scope="col">{t.colBreaches}</th>
            <th scope="col">{t.colDead}</th>
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
              <td>
                {week.requests}
                <span className="sub">{t.clientsCount(week.clients)}</span>
              </td>
              <td>
                <Rate stats={week} />
              </td>
              <td>
                {t.medianTime(formatDuration(week.medianResponseMinutes))}
                <span className="sub">{t.p90Time(formatDuration(week.p90ResponseMinutes))}</span>
              </td>
              <td>
                {week.agreed}
                <span className="sub">{formatPercent(week.agreedRate)}</span>
              </td>
              <td>{week.slaBreaches}</td>
              <td>{week.deadNotifications}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── по категориям ──────────────────────────────────────────────────────────

function CategoryTable({ items }: { items: readonly CategoryMetrics[] }) {
  const phone = usePhone();
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
            <Rate stats={row} />
            <dl className="rcard-facts">
              <dt>{t.colRequests}</dt>
              <dd>
                {row.requests} · {t.clientsCount(row.clients)}
              </dd>
              <dt>{t.colMedian}</dt>
              <dd>{formatDuration(row.medianResponseMinutes)}</dd>
              <dt>{t.colAgreed}</dt>
              <dd>
                {row.agreed} · {formatPercent(row.agreedRate)}
              </dd>
              <dt>{t.colBreaches}</dt>
              <dd>{row.slaBreaches}</dd>
            </dl>
          </li>
        ))}
      </ul>
    );
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">{t.colCategory}</th>
            <th scope="col">{t.colRequests}</th>
            <th scope="col">{t.colAnswered}</th>
            <th scope="col">{t.colResponseTime}</th>
            <th scope="col">{t.colAgreed}</th>
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
              <td>
                {row.requests}
                <span className="sub">{t.clientsCount(row.clients)}</span>
              </td>
              <td>
                <Rate stats={row} />
              </td>
              <td>
                {t.medianTime(formatDuration(row.medianResponseMinutes))}
                <span className="sub">{t.p90Time(formatDuration(row.p90ResponseMinutes))}</span>
              </td>
              <td>
                {row.agreed}
                <span className="sub">{formatPercent(row.agreedRate)}</span>
              </td>
              <td>{row.slaBreaches}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
          <button type="button" className="ui-btn ui-btn-primary sheet-done" onClick={() => setOpen(false)}>
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
            <Rate stats={row} />
            <dl className="rcard-facts">
              <dt>{t.colRequests}</dt>
              <dd>{row.requests}</dd>
              <dt>{t.colMedian}</dt>
              <dd>{formatDuration(row.medianResponseMinutes)}</dd>
              <dt>{t.colBreaches}</dt>
              <dd>{row.slaBreaches}</dd>
              <dt>{t.colAgreed}</dt>
              <dd>{row.agreed}</dd>
              <dt>{t.colLastRequest}</dt>
              <dd>{formatMoment(row.lastRequestAt)}</dd>
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}

function VendorTable({ items }: { items: readonly VendorMetrics[] }) {
  const phone = usePhone();
  const [sort, setSort] = useState<Sort>({ key: "rate", dir: "asc" });
  const rows = sortVendors(items, sort);
  if (phone) return <VendorCards rows={rows} sort={sort} onSort={setSort} />;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">{t.colVendor}</th>
            <SortHeader label={t.colRequests} column="requests" sort={sort} onSort={setSort} />
            <SortHeader label={t.colAnswered} column="rate" sort={sort} onSort={setSort} />
            <SortHeader label={t.colMedian} column="median" sort={sort} onSort={setSort} />
            <th scope="col">{t.colBreaches}</th>
            <th scope="col">{t.colAgreed}</th>
            <th scope="col">{t.colLastRequest}</th>
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
              <td>{row.agreed}</td>
              <td>{formatMoment(row.lastRequestAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── контакты витрин ────────────────────────────────────────────────────────

type ContactRow = ContactMetrics["items"][number];

/** Контакты витрин за 30 дней: сколько раз открыли окно контактов, позвонили, написали в Telegram */
function ContactsSection({ category, onReset }: { category: string | null; onReset: () => void }) {
  const query = new URLSearchParams({ days: "30" });
  if (category !== null) query.set("category", category);
  const { loaded, reload } = useLoad<ContactMetrics>(`/staff/metrics/contacts?${query}`);
  return (
    <section className="stack" aria-labelledby="contacts-metrics-title">
      <h2 id="contacts-metrics-title" className="section-title">
        {t.metricsContacts}
      </h2>
      <p className="muted small">{t.metricsContactsHint}</p>
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
  const phone = usePhone();
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
    <div className="table-wrap">
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
    </div>
  );
}

// ── страница вендора ───────────────────────────────────────────────────────

/** Ответы вендора на заявки за 30 дней и по его витринам (если их несколько) */
export function VendorResponsePanel({ vendorId }: { vendorId: string }) {
  const { loaded, reload } = useLoad<VendorResponseStats>(`/staff/metrics/vendors/${vendorId}`);
  return (
    <section className="panel" aria-labelledby="response-title">
      <h2 id="response-title">{t.vendorResponse}</h2>
      <p className="muted small">{t.vendorResponseHint}</p>
      <LoadedView loaded={loaded} onRetry={reload}>
        {(stats) =>
          stats.vendor.requests === 0 ? (
            <p className="muted">{t.vendorResponseEmpty}</p>
          ) : (
            <div className="stack">
              <ResponseList stats={stats.vendor} />
              {stats.listings.length > 1 && <ListingTable listings={stats.listings} />}
            </div>
          )
        }
      </LoadedView>
    </section>
  );
}

function ResponseList({ stats }: { stats: VendorMetrics }) {
  return (
    <dl className="dl">
      {stats.categories.length > 0 ? (
        <>
          <dt>{t.vendorCategories}</dt>
          <dd>{stats.categories.map(categoryName).join(", ")}</dd>
        </>
      ) : null}
      <dt>{t.colRequests}</dt>
      <dd>{stats.requests}</dd>
      <dt>{t.colAnswered}</dt>
      <dd>
        <Rate stats={stats} />
      </dd>
      <dt>{t.colMedian}</dt>
      <dd>{formatDuration(stats.medianResponseMinutes)}</dd>
      <dt>{t.colBreaches}</dt>
      <dd>{stats.slaBreaches}</dd>
      <dt>{t.colAgreed}</dt>
      <dd>{stats.agreed}</dd>
      <dt>{t.colLastRequest}</dt>
      <dd>{formatMoment(stats.lastRequestAt)}</dd>
    </dl>
  );
}

function ListingTable({ listings }: { listings: readonly ListingMetrics[] }) {
  const phone = usePhone();
  if (phone)
    return (
      <ul className="rcards">
        {listings.map((row) => (
          <li key={row.listing.id} className="rcard rcard-tap">
            <div className="rcard-head">
              <Link to={{ name: "listing", id: row.listing.id }} className="rcard-link">
                {row.listing.name}
              </Link>
              <StatusPill status={row.listing.status} />
            </div>
            <p className="rcard-meta">
              <CategoryChip code={row.listing.categoryCode} />
            </p>
            <Rate stats={row} />
            <dl className="rcard-facts">
              <dt>{t.colRequests}</dt>
              <dd>{row.requests}</dd>
              <dt>{t.colMedian}</dt>
              <dd>{formatDuration(row.medianResponseMinutes)}</dd>
            </dl>
          </li>
        ))}
      </ul>
    );
  return (
    <div className="table-wrap">
      <table className="table table-compact">
        <thead>
          <tr>
            <th scope="col">{t.listings}</th>
            <th scope="col">{t.colRequests}</th>
            <th scope="col">{t.colAnswered}</th>
            <th scope="col">{t.colMedian}</th>
          </tr>
        </thead>
        <tbody>
          {listings.map((row) => (
            <tr key={row.listing.id}>
              <th scope="row" className="row-head">
                <CategoryChip code={row.listing.categoryCode} />{" "}
                <Link to={{ name: "listing", id: row.listing.id }}>{row.listing.name}</Link>{" "}
                <StatusPill status={row.listing.status} />
              </th>
              <td>{row.requests}</td>
              <td>
                <Rate stats={row} />
              </td>
              <td>{formatDuration(row.medianResponseMinutes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
