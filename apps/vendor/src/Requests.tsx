/* Входящие: вкладки «Новые · В работе · Закрытые» со счётчиками. В открытых вкладках
   сверху те, где время ответа истекает (просроченные — первыми), в закрытой — новые;
   порядок задаёт API. У ждущих ответа — счётчик 12 часов. Телефона в списке нет: он в
   карточке заявки, где его чтение записывается в журнал.

   На компьютере список стоит рядом с карточкой (Inbox.tsx): открытая заявка отмечена в
   списке (aria-current), а список перечитывается тихо, когда карточка что-то изменила. */

import {
  REQUEST_TABS,
  type RequestTab,
  type VendorRequestItem,
  type VendorRequestPage,
} from "@bayramm/shared/api/vendor";
import { type MouseEvent, useEffect, useState } from "react";
import { api } from "./api";
import { formatBudget, formatDate, formatDuration, formatGuests, slaView, tashkentTime } from "./format";
import { fill, type TextKey, textOf, type VendorDict } from "./i18n";
import { Icon } from "./icons";
import { type Navigate, pathOf } from "./router";
import { Empty, Heading, LoadError, Loading, type ScreenProps, StatusChip } from "./ui";
import { useLoad } from "./useLoad";
import { useNow } from "./useNow";

const TAB_LABEL: Readonly<Record<RequestTab, TextKey>> = {
  new: "tabNew",
  active: "tabActive",
  closed: "tabClosed",
};

const EMPTY: Readonly<Record<RequestTab, [TextKey, TextKey]>> = {
  new: ["emptyNew", "emptyNewText"],
  active: ["emptyActive", "emptyActiveText"],
  closed: ["emptyClosed", "emptyClosedText"],
};

/** Статусы, в которых заявка ещё ждёт первого ответа — для них идёт счётчик */
export const awaitsAnswer = (item: VendorRequestItem): boolean =>
  (item.status === "new" || item.status === "viewed") && item.sla.firstResponseAt === null;

export function SlaTimer({ item, t, now }: { item: VendorRequestItem; t: VendorDict; now: number }) {
  const view = slaView(item.sla, now);
  const due = tashkentTime(item.sla.dueAt);
  if (view.kind === "answered") {
    return view.late ? <p className="sla-note">{t.answeredLate}</p> : null;
  }
  if (view.kind === "late") {
    return (
      <div className="sla sla-late">
        <p className="sla-text">
          <Icon name="warning" size={14} />
          <strong>{fill(t.slaLate, { time: formatDuration(view.ms, t) })}</strong>
          <span>{fill(t.slaWasUntil, { time: due })}</span>
        </p>
      </div>
    );
  }
  return (
    <div className={`sla${view.warn ? " sla-warn" : ""}`}>
      <p className="sla-text">
        <Icon name="clock" size={14} />
        <strong>{fill(t.slaLeft, { time: formatDuration(view.ms, t) })}</strong>
        <span>{fill(t.slaUntil, { time: due })}</span>
      </p>
      <progress className="sla-bar" max={100} value={Math.round(view.share * 100)} aria-hidden="true" />
    </div>
  );
}

interface CardProps {
  readonly item: VendorRequestItem;
  readonly t: VendorDict;
  readonly lang: "ru" | "uz";
  readonly now: number;
  readonly showListing: boolean;
  readonly navigate: Navigate;
  /** Эта заявка открыта рядом (компьютер) */
  readonly selected: boolean;
}

function RequestCard({ item, t, lang, now, showListing, navigate, selected }: CardProps) {
  const location = { route: "request", id: item.id } as const;
  const late = awaitsAnswer(item) && slaView(item.sla, now).kind === "late";
  const budget = formatBudget(item.budgetMinUzs, item.budgetMaxUzs, t, lang);
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(location);
  };
  return (
    <li>
      <a
        className={`rq${late ? " rq-late" : ""}`}
        href={pathOf(location)}
        aria-current={selected ? "page" : undefined}
        onClick={onClick}
      >
        <span className="rq-top">
          <span className="rq-name">{item.contactName ?? fill(t.requestNo, { n: item.publicNo })}</span>
          <StatusChip status={item.status} late={late} t={t} />
        </span>
        <span className="rq-meta">
          {textOf(t, `occ_${item.occasionCode}`)} · {formatDate(item.eventDate, t, true)}
        </span>
        <span className="rq-facts">
          <span>
            <Icon name="guests" size={14} />
            {formatGuests(item.guests, t)}
          </span>
          <span>
            <Icon name="wallet" size={14} />
            {budget ?? t.budgetNone}
          </span>
          {showListing ? (
            <span>
              <Icon name="hall" size={14} />
              {item.listing.name}
            </span>
          ) : null}
        </span>
        {awaitsAnswer(item) ? <SlaTimer item={item} t={t} now={now} /> : null}
      </a>
    </li>
  );
}

interface RequestsProps extends Omit<ScreenProps, "headingRef"> {
  /** Фокус после перехода — на заголовок списка; рядом с открытой заявкой — на её заголовок */
  readonly headingRef?: ScreenProps["headingRef"];
  readonly tab: RequestTab;
  readonly onTab: (tab: RequestTab) => void;
  readonly navigate: Navigate;
  readonly listingCount: number;
  /** Открытая рядом заявка (компьютер) */
  readonly selectedId?: string;
  /** Растёт, когда карточка рядом что-то изменила: список перечитывается тихо */
  readonly version?: number;
  /** Счётчики вкладок из ответа API — для значка у раздела «Заявки» */
  readonly onCounts?: (counts: VendorRequestPage["counts"]) => void;
}

export function Requests({
  t,
  lang,
  headingRef,
  tab,
  onTab,
  navigate,
  listingCount,
  selectedId,
  version = 0,
  onCounts,
}: RequestsProps) {
  const now = useNow();
  const [page, reload, setPage, refresh] = useLoad<VendorRequestPage>(tab, (key) => api.requests(key));
  const [more, setMore] = useState<"idle" | "loading" | "failed">("idle");

  // Карточка рядом изменила заявку — список и счётчики тоже (без «Загрузка…» и потери фокуса)
  useEffect(() => {
    if (version > 0) void refresh();
  }, [version, refresh]);

  const counts = page.state === "ready" ? page.data.counts : null;
  useEffect(() => {
    if (counts) onCounts?.(counts);
  }, [counts, onCounts]);

  const loadMore = async (cursor: string) => {
    setMore("loading");
    try {
      const next = await api.requests(tab, cursor);
      setPage((current) => ({ ...next, items: [...current.items, ...next.items] }));
      setMore("idle");
    } catch {
      setMore("failed");
    }
  };

  const hasLate =
    page.state === "ready" &&
    page.data.items.some((i) => awaitsAnswer(i) && slaView(i.sla, now).kind === "late");

  return (
    <section className="page inbox-list" aria-labelledby="page-title">
      <Heading headingRef={headingRef}>{t.requests}</Heading>
      <p className={`promise${hasLate ? " promise-late" : ""}`}>
        <Icon name={hasLate ? "warning" : "clock"} size={17} />
        <span>{t.inboxPromise}</span>
      </p>

      {/* biome-ignore lint/a11y/useSemanticElements: переключатель вкладок — группа кнопок, не форма */}
      <div className="pills pills-fill" role="group" aria-label={t.requests}>
        {REQUEST_TABS.map((key) => (
          <button
            key={key}
            type="button"
            className="pill"
            aria-pressed={key === tab}
            onClick={() => onTab(key)}
          >
            {t[TAB_LABEL[key]]}
            {counts ? <span className="pill-count">{counts[key]}</span> : null}
          </button>
        ))}
      </div>

      {page.state === "loading" ? <Loading t={t} /> : null}
      {page.state === "error" ? <LoadError t={t} onRetry={reload} /> : null}
      {page.state === "ready" && page.data.items.length === 0 ? (
        <Empty icon="requests" title={t[EMPTY[tab][0]]} text={t[EMPTY[tab][1]]} />
      ) : null}
      {page.state === "ready" && page.data.items.length > 0 ? (
        <>
          <ul className="rq-list">
            {page.data.items.map((item) => (
              <RequestCard
                key={item.id}
                item={item}
                t={t}
                lang={lang}
                now={now}
                showListing={listingCount > 1}
                navigate={navigate}
                selected={item.id === selectedId}
              />
            ))}
          </ul>
          {page.data.nextCursor ? (
            <button
              type="button"
              className="btn btn-ghost btn-wide"
              disabled={more === "loading"}
              onClick={() => page.data.nextCursor && void loadMore(page.data.nextCursor)}
            >
              {more === "loading" ? t.loading : t.loadMore}
            </button>
          ) : null}
          {more === "failed" ? (
            <p className="form-error" role="alert">
              {t.loadFailed}
            </p>
          ) : null}
        </>
      ) : null}
      {/* Рядом с карточкой заявки (компьютер) то же сказано в ней */}
      {selectedId === undefined ? <p className="note">{t.consentNote}</p> : null}
    </section>
  );
}
