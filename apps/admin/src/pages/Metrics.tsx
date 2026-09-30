/* Метрики запуска — только чтение, только числа (все роли). Считает база, определения — одни
   с отчётами бота: ответ площадки (не «связались» от команды), в срок, какие заявки в расчёте
   доли. Здесь — очереди команды, таблица по неделям и вендоры за 30 дней с сортировкой по доле
   ответов в срок; на странице вендора — его ответы (VendorResponsePanel). Полосы — классами:
   CSP не пускает встроенные стили. */

import type {
  ListingMetrics,
  MetricsOverview,
  OpsQueues,
  ResponseStats,
  VendorMetrics,
  VendorMetricsList,
  VendorResponseStats,
  WeeklyMetrics,
} from "@bayramm/shared/api/staff";
import { useState } from "react";
import { useLoad } from "../api";
import { formatDuration, formatMoment, formatPercent, formatWeek, vendorLabel } from "../format";
import { t } from "../texts";
import { Link, LoadedView, Pill, StatusPill } from "../ui";

/** Меньше половины заявок отвечено в срок — полоса коралловая */
const RATE_LOW = 50;

const QUEUES: readonly (keyof OpsQueues)[] = [
  "awaiting",
  "overdue",
  "deadTotal",
  "listingsReview",
  "revisionsPending",
  "photosPending",
];
/** Эти очереди, если не пусты, — выделить */
const QUEUE_WARN: ReadonlySet<keyof OpsQueues> = new Set(["overdue", "deadTotal"]);

export function MetricsPage() {
  const overview = useLoad<MetricsOverview>("/staff/metrics");
  const vendors = useLoad<VendorMetricsList>("/staff/metrics/vendors");
  return (
    <div className="stack">
      <LoadedView loaded={overview.loaded} onRetry={overview.reload}>
        {(data) => (
          <>
            <section className="stack" aria-labelledby="queues-title">
              <h2 id="queues-title" className="section-title">
                {t.metricsNow}
              </h2>
              <Queues queues={data.queues} />
            </section>
            <section className="stack" aria-labelledby="weekly-title">
              <h2 id="weekly-title" className="section-title">
                {t.metricsWeekly}
              </h2>
              <p className="muted small">{t.metricsWeeklyHint(data.slaHours)}</p>
              <WeeklyTable weeks={data.weeks} />
            </section>
          </>
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
              <p className="empty">{t.metricsVendorsEmpty}</p>
            ) : (
              <VendorTable items={list.items} />
            )
          }
        </LoadedView>
      </section>
    </div>
  );
}

function Queues({ queues }: { queues: OpsQueues }) {
  return (
    <ul className="stats">
      {QUEUES.map((key) => (
        <li key={key} className={`stat${QUEUE_WARN.has(key) && queues[key] > 0 ? " stat-warn" : ""}`}>
          <span className="stat-value">{queues[key]}</span>
          <span className="stat-label">{t.metricsQueues[key]}</span>
        </li>
      ))}
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
                  {week.weekLabel} {week.partial && <Pill tone="outline">{t.weekNow}</Pill>}
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

function VendorTable({ items }: { items: readonly VendorMetrics[] }) {
  const [sort, setSort] = useState<Sort>({ key: "rate", dir: "asc" });
  const rows = sortVendors(items, sort);
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
                <span className="sub">{t.activeListings(row.activeListings)}</span>
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

// ── страница вендора ───────────────────────────────────────────────────────

/** Ответы вендора на заявки за 30 дней и по его площадкам (если их несколько) */
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

function ResponseList({ stats }: { stats: ResponseStats }) {
  return (
    <dl className="dl">
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
