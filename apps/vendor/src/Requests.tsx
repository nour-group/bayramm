/* Входящие: вкладки «Новые · В работе · Закрытые» со счётчиками. В открытых вкладках
   сверху те, где время ответа истекает (просроченные — первыми), в закрытой — новые;
   порядок задаёт API. У ждущих ответа — счётчик 12 часов; плашка про 12 часов над списком
   есть, только когда какая-то заявка уже просрочена (в остальное время счётчик — в самой
   заявке). Телефона в списке нет: он в карточке заявки, где его чтение записывается в журнал,
   там же — текст о согласии клиента.

   Витрин несколько — над вкладками выбор: все витрины или одна (запрос с listingId,
   счётчики вкладок — тоже по ней); на компьютере этот выбор — в боковой панели. У каждой
   заявки — одна приглушённая строка «Категория · Витрина», часть дня (модель parts) и не
   больше одного поля заявки категории (часы, машины, кг): остальное — в карточке.

   Витрина ещё не на сайте (новый партнёр, первый вход) — под списком строка «что дальше» со
   ссылкой на витрину, где чек-лист готовности: заявок не будет, пока витрину не опубликуют.

   На компьютере список стоит рядом с карточкой (Inbox.tsx): открытая заявка отмечена в
   списке (aria-current), а список перечитывается тихо, когда карточка что-то изменила. */

import {
  REQUEST_TABS,
  type RequestTab,
  type VendorListingRef,
  type VendorRequestItem,
  type VendorRequestPage,
} from "@bayramm/shared/api/vendor";
import { categoryConfig, chosenServices, detailRows } from "@bayramm/shared/categories";
import { type MouseEvent, useEffect, useState } from "react";
import { api } from "./api";
import { categoryName, partsLabel } from "./category";
import { formatBudget, formatDate, formatDuration, formatGuests, slaView, tashkentTime } from "./format";
import { fill, type TextKey, textOf, type VendorDict } from "./i18n";
import { Icon } from "./icons";
import { ListingPicker } from "./ListingPicker";
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

/**
 * Главное поле заявки категории для списка — первое по порядку формы: «Начало: 18:00». Нет
 * полей — первая выбранная услуга; остальное (и часть дня, она в строке даты) — в карточке
 */
export function detailsLine(item: VendorRequestItem, t: VendorDict, lang: "ru" | "uz"): string {
  const category = categoryConfig(item.listing.categoryCode);
  const [row] = detailRows(lang, category, item.details, (code) => textOf(t, `dist_${code}`));
  if (row) return row.value === null ? row.label : `${row.label}: ${row.value}`;
  const [service] = chosenServices(category, item.details);
  return service ? service.name[lang] : "";
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
  const details = detailsLine(item, t, lang);
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
          {[
            formatDate(item.eventDate, t, true),
            partsLabel(t, item.listing.categoryCode, item.dayParts),
            textOf(t, `occ_${item.occasionCode}`),
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
        {showListing ? (
          <span className="rq-vitrina">
            {categoryName(lang, item.listing.categoryCode)} · {item.listing.name}
          </span>
        ) : null}
        <span className="rq-facts">
          {item.guests === null ? null : (
            <span>
              <Icon name="guests" size={14} />
              {formatGuests(item.guests, t)}
            </span>
          )}
          <span>
            <Icon name="wallet" size={14} />
            {budget ?? t.budgetNone}
          </span>
        </span>
        {details ? <span className="rq-details">{details}</span> : null}
        {item.firstResponseBy === "staff" ? (
          <span className="rq-staff">
            <Icon name="info" size={14} />
            {t.firstByStaff}
          </span>
        ) : null}
        {awaitsAnswer(item) ? <SlaTimer item={item} t={t} now={now} /> : null}
      </a>
    </li>
  );
}

/** Что сказать о витрине, которой ещё нет на сайте: по статусу */
const NOT_LIVE: Readonly<Record<Exclude<VendorListingRef["status"], "active">, TextKey>> = {
  lead: "notLiveDraft",
  draft: "notLiveDraft",
  review: "notLiveReview",
  suspended: "notLiveSuspended",
  rejected: "notLiveRejected",
};

/**
 * Витрины не на сайте: почему и куда идти. Новый партнёр видит это первым — заявок не будет,
 * пока витрину не опубликуют
 */
function NotLive({
  listings,
  t,
  onOpen,
}: {
  listings: readonly VendorListingRef[];
  t: VendorDict;
  onOpen: (id: string) => void;
}) {
  const pending = listings.filter((listing) => listing.status !== "active");
  if (pending.length === 0) return null;
  return (
    <ul className="not-live">
      {pending.map((listing) => (
        <li key={listing.id} className="notice not-live-item">
          <p>
            {fill(t[NOT_LIVE[listing.status as Exclude<VendorListingRef["status"], "active">]], {
              name: listing.name,
            })}
          </p>
          <button type="button" className="btn btn-ghost" onClick={() => onOpen(listing.id)}>
            {listing.status === "review" ? t.openVitrina : t.whatIsLeft}
            <span className="sr-only">: {listing.name}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

interface RequestsProps extends Omit<ScreenProps, "headingRef"> {
  /** Фокус после перехода — на заголовок списка; рядом с открытой заявкой — на её заголовок */
  readonly headingRef?: ScreenProps["headingRef"];
  readonly tab: RequestTab;
  readonly onTab: (tab: RequestTab) => void;
  readonly navigate: Navigate;
  readonly listings: readonly VendorListingRef[];
  /** Заявки одной витрины; null — всех */
  readonly filter: string | null;
  readonly onFilter: (listingId: string | null) => void;
  /** Выбор витрины — в боковой панели (компьютер): над списком его нет */
  readonly inSidebar?: boolean;
  /** Открыть витрину (чек-лист готовности): витрина ещё не на сайте */
  readonly onOpenListing: (listingId: string) => void;
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
  listings,
  filter,
  onFilter,
  inSidebar = false,
  onOpenListing,
  selectedId,
  version = 0,
  onCounts,
}: RequestsProps) {
  const now = useNow();
  // Ключ — вкладка и витрина: смена любой из них — новая загрузка, ответ на старую отброшен
  const [page, reload, setPage, refresh] = useLoad<VendorRequestPage>(`${tab}/${filter ?? ""}`, (key) => {
    const [askedTab = "new", listingId = ""] = key.split("/");
    return api.requests(askedTab, null, listingId || null);
  });
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
      const next = await api.requests(tab, cursor, filter);
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
      {hasLate ? (
        <p className="promise promise-late">
          <Icon name="warning" size={17} />
          <span>{t.inboxLate}</span>
        </p>
      ) : null}

      <ListingPicker
        listings={listings}
        value={filter}
        onChange={onFilter}
        allLabel={t.allListings}
        label={t.inboxFilter}
        inSidebar={inSidebar}
        line={false}
        t={t}
        lang={lang}
      />

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

      {page.state === "loading" ? <Loading t={t} kind="list" /> : null}
      {page.state === "error" ? <LoadError t={t} onRetry={reload} error={page.error} /> : null}
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
                showListing={listings.length > 1}
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
      {/* Под списком: заявки — главное на экране; у нового партнёра список пуст, и строка
        «что дальше» всё равно на первом экране */}
      <NotLive listings={listings} t={t} onOpen={onOpenListing} />
    </section>
  );
}
