/* Модерация: витрины на проверке — по порядку отправки (решение — на странице витрины),
   предложения изменений от вендоров и менеджеров (решение — на странице предложения), услуги
   и изменения услуг (решение — прямо в очереди: одобрить или отклонить с причиной для
   партнёра) и новые фото — старые загрузки первыми (одобрить или отклонить — на странице
   витрины, в блоке фото). Услуги и фото — у любых витрин, кроме отклонённых: партнёр видит
   «на проверке» и у черновика, поэтому у карточки очереди — статус витрины, если она не на
   сайте. Элемент очереди — карточка целиком: нажатие в любом её месте открывает то, по чему
   решать.

   Разбор с телефона: вверху — сколько ждёт в каждой очереди (кнопки ведут к ней), у заголовка
   очереди — число (всего, а не только загруженное), пустая очередь — одной строкой, пояснение —
   только у непустой. Решение по услуге — без клавиатуры (одобрить) или с причиной в шторке
   (ServiceDecision — тот же, что на странице витрины); после решения очередь перечитывается
   тихо, фокус — на следующей услуге (или на заголовке очереди, если она кончилась), что
   решили — говорит строка статуса.

   Очередь — страницами: на компьютере листается, на телефоне «Показать ещё» дописывает
   следующую; число у заголовка — всего. Какая очередь открыта — в адресе (?queue=photos):
   «назад» из витрины и ссылка из метрик ведут к ней. Фото и услуги очереди открывают витрину
   сразу на своём блоке (?focus=). */

import type {
  ListingList,
  ListingListItem,
  ListingStatus,
  RevisionList,
  RevisionListItem,
  ServiceQueue,
  ServiceQueueItem,
} from "@bayramm/shared/api/staff";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useCan } from "../api";
import { CategoryChip, formatPrice } from "../categories";
import { formatMoment, vendorLabel } from "../format";
import { usePhone } from "../layout";
import { useQueryState } from "../router";
import { t } from "../texts";
import {
  Blockers,
  focusSection,
  Link,
  ListFooter,
  LoadedView,
  Pill,
  publishBlockers,
  StatusPill,
  toneOf,
  usePagedList,
} from "../ui";
import { ServiceChanges, ServiceDecision } from "./Services";

type Queue = "review" | "revisions" | "services" | "photos";

const QUEUES: readonly Queue[] = ["review", "revisions", "services", "photos"];

/** Карточек очереди на странице */
const PAGE = 20;

const QUEUE_TITLE: Readonly<Record<Queue, string>> = {
  review: t.listingsInReview,
  revisions: t.revisions,
  services: t.serviceQueue,
  photos: t.photoQueue,
};

const QUEUE_HINT: Readonly<Record<Queue, string | null>> = {
  review: null,
  revisions: t.revisionsHint,
  services: t.serviceQueueHint,
  photos: t.photoQueueHint,
};

const QUEUE_EMPTY: Readonly<Record<Queue, string>> = {
  review: t.moderationEmpty,
  revisions: t.revisionsEmpty,
  services: t.serviceQueueEmpty,
  photos: t.photoQueueEmpty,
};

const titleId = (queue: Queue) => `queue-${queue}-title`;

/** Очередь страницами: компьютер — своя страница у каждой очереди, телефон — «Показать ещё» */
function useQueue<I, L extends { readonly total: number; readonly items: readonly I[] }>(
  path: string | null,
) {
  const phone = usePhone();
  const [offset, setOffset] = useState(0);
  const list = usePagedList<I, L>(path, { size: PAGE, offset, append: phone });
  // Сколько всего (не только показанная страница), когда загрузилась: для сводки и заголовка
  const count = list.loaded.state === "ready" ? list.total : null;
  return { list, offset, setOffset, count };
}

/** Подвал очереди: страницы или «Показать ещё» — только когда в ней больше страницы */
function QueueFooter({
  queue,
  state,
}: {
  queue: Queue;
  state: {
    readonly list: Parameters<typeof ListFooter>[0]["list"];
    readonly offset: number;
    readonly setOffset: (offset: number) => void;
  };
}) {
  if (state.list.total <= PAGE && state.offset === 0) return null;
  return (
    <ListFooter
      list={state.list}
      offset={state.offset}
      size={PAGE}
      onPage={(next) => {
        state.setOffset(next);
        focusSection(titleId(queue));
      }}
    />
  );
}

/** Витрина не на сайте (черновик, на проверке…) — её статус у карточки очереди; опубликованная — без него */
function NotLiveStatus({ status }: { status: ListingStatus }) {
  return status === "active" ? null : <StatusPill status={status} />;
}

/**
 * Очередь: заголовок с числом (на него — фокус после перехода из сводки и когда очередь
 * кончилась), пояснение — если есть что разбирать, пустая — одной строкой
 */
function QueueSection({
  queue,
  count,
  children,
}: {
  queue: Queue;
  count: number | null;
  children: ReactNode;
}) {
  const hint = QUEUE_HINT[queue];
  return (
    <section className="stack queue" aria-labelledby={titleId(queue)}>
      <h2 id={titleId(queue)} className="section-title" tabIndex={-1}>
        {QUEUE_TITLE[queue]} {count !== null ? <span className="count">{count}</span> : null}
      </h2>
      {hint && count !== 0 ? <p className="muted small">{hint}</p> : null}
      {children}
    </section>
  );
}

/** Пустая очередь — строкой, а не большой рамкой: разбирать нечего, место — тем, где есть */
function QueueEmpty({ queue }: { queue: Queue }) {
  return <p className="muted queue-empty">{QUEUE_EMPTY[queue]}</p>;
}

export function ModerationPage({ minPhotos }: { minPhotos: number }) {
  const can = useCan();
  const services = can("revisions.moderate");
  const [query, setQuery] = useQueryState(["queue"] as const);
  const review = useQueue<ListingListItem, ListingList>("/staff/listings?status=review");
  const revisions = useQueue<RevisionListItem, RevisionList>("/staff/revisions?status=pending");
  const photos = useQueue<ListingListItem, ListingList>("/staff/listings?photos=pending");
  const queues = QUEUES.filter((queue) => queue !== "services" || services);
  const [serviceCount, setServiceCount] = useState<number | null>(null);
  const counts: Readonly<Record<Queue, number | null>> = {
    review: review.count,
    revisions: revisions.count,
    services: serviceCount,
    photos: photos.count,
  };
  // Очередь из адреса (?queue=photos — ссылка из метрик или «назад» из витрины): к ней, когда
  // она загрузилась
  const anchor = queues.find((queue) => queue === query.queue) ?? null;
  const anchorReady = anchor !== null && counts[anchor] !== null;
  const jumped = useRef(false);
  useEffect(() => {
    if (!anchorReady || jumped.current || anchor === null) return;
    jumped.current = true;
    focusSection(titleId(anchor));
  }, [anchor, anchorReady]);
  const jump = (queue: Queue) => {
    setQuery({ queue });
    focusSection(titleId(queue));
  };

  return (
    <div className="stack">
      {/* Сводка: сколько ждёт решения в каждой очереди — кнопкой к ней (на телефоне очереди
          длинные, листать до нужной долго) */}
      <nav className="queue-jump" aria-label={t.moderation}>
        {queues.map((queue) => (
          <button
            key={queue}
            type="button"
            className={`chip${counts[queue] ? " is-active" : ""}`}
            onClick={() => jump(queue)}
          >
            {QUEUE_TITLE[queue]}
            <span className="chip-count">{counts[queue] ?? "…"}</span>
          </button>
        ))}
      </nav>

      <QueueSection queue="review" count={counts.review}>
        <LoadedView loaded={review.list.loaded} onRetry={review.list.reload} skeleton="block">
          {() => <ReviewQueue items={review.list.items} minPhotos={minPhotos} />}
        </LoadedView>
        <QueueFooter queue="review" state={review} />
      </QueueSection>
      <QueueSection queue="revisions" count={counts.revisions}>
        <LoadedView loaded={revisions.list.loaded} onRetry={revisions.list.reload} skeleton="block">
          {() => <RevisionQueue items={revisions.list.items} />}
        </LoadedView>
        <QueueFooter queue="revisions" state={revisions} />
      </QueueSection>
      {services ? (
        <QueueSection queue="services" count={counts.services}>
          <ServiceQueueList onCount={setServiceCount} />
        </QueueSection>
      ) : null}
      <QueueSection queue="photos" count={counts.photos}>
        <LoadedView loaded={photos.list.loaded} onRetry={photos.list.reload} skeleton="block">
          {() => <PhotoQueue items={photos.list.items} />}
        </LoadedView>
        <QueueFooter queue="photos" state={photos} />
      </QueueSection>
    </div>
  );
}

/** «до 300 гостей» — вместимость там, где она есть (залы) */
const capacityText = (capMax: number | null) => (capMax ? ` · ${t.guestsUpTo(capMax)}` : "");

function ReviewQueue({ items, minPhotos }: { items: readonly ListingListItem[]; minPhotos: number }) {
  if (items.length === 0) return <QueueEmpty queue="review" />;
  return (
    <ul className="rcards">
      {items.map((listing) => (
        <li key={listing.id} className="rcard rcard-tap">
          <div className="rcard-head">
            <Link to={{ name: "listing", id: listing.id }} className="rcard-link">
              {listing.name}
            </Link>
            <CategoryChip code={listing.categoryCode} />
          </div>
          <p className="rcard-meta">
            {vendorLabel(listing.vendor)} · {t.submittedAt} {formatMoment(listing.submittedAt)}
          </p>
          <p className="rcard-meta">
            {formatPrice(listing.priceFromUzs, listing.priceUnit)}
            {capacityText(listing.capMax)} · {t.photosCount(listing.photos.ready, listing.photos.approved)}
          </p>
          <Blockers
            title={t.blockersActive}
            codes={publishBlockers(listing.blockers, listing.photos.ready, minPhotos)}
          />
        </li>
      ))}
    </ul>
  );
}

function RevisionQueue({ items }: { items: readonly RevisionListItem[] }) {
  if (items.length === 0) return <QueueEmpty queue="revisions" />;
  return (
    <ul className="rcards">
      {items.map((revision) => (
        <li key={revision.id} className="rcard rcard-tap">
          <Link to={{ name: "revision", id: revision.id }} className="rcard-link">
            {revision.listing.name}
          </Link>
          <p className="rcard-meta">
            {vendorLabel(revision.vendor)} · {t.submittedAt} {formatMoment(revision.submittedAt)}
          </p>
          <p className="rcard-meta">{t.proposedBy(revision.proposedBy.kind, revision.proposedBy.name)}</p>
          <p className="rcard-meta">
            {revision.fields.map((field) => t.revisionFields[field] ?? field).join(", ")}
          </p>
          {revision.stale && <p className="notice notice-warn">{t.revisionStale}</p>}
        </li>
      ))}
    </ul>
  );
}

function PhotoQueue({ items }: { items: readonly ListingListItem[] }) {
  if (items.length === 0) return <QueueEmpty queue="photos" />;
  return (
    <ul className="rcards">
      {items.map((listing) => (
        <li key={listing.id} className="rcard rcard-tap">
          <div className="rcard-head">
            {/* Витрина — сразу на блоке фото: решать по ним, а не листать страницу */}
            <Link to={{ name: "listing", id: listing.id, query: { focus: "photos" } }} className="rcard-link">
              {listing.name}
            </Link>
            <NotLiveStatus status={listing.status} />
          </div>
          <p className="rcard-meta">{vendorLabel(listing.vendor)}</p>
          <p className="rcard-meta">
            {t.pendingPhotos(listing.photos.pending)} ·{" "}
            {t.photosCount(listing.photos.ready, listing.photos.approved)}
          </p>
        </li>
      ))}
    </ul>
  );
}

/**
 * Очередь услуг: решение — прямо здесь. После решения очередь перечитывается тихо (без
 * заготовки), фокус — на «Одобрить» услуги, вставшей на место решённой, а если очередь
 * кончилась — на её заголовок; строка статуса говорит, что решили
 */
function ServiceQueueList({ onCount }: { onCount: (n: number | null) => void }) {
  const state = useQueue<ServiceQueueItem, ServiceQueue>("/staff/services?status=pending");
  const { loaded, reload } = state.list;
  const list = useRef<HTMLUListElement>(null);
  // Место решённой услуги в очереди: после перечитывания фокус — туда
  const decidedAt = useRef<number | null>(null);
  const [said, setSaid] = useState("");
  const count = state.count;
  useEffect(() => onCount(count), [count, onCount]);
  useEffect(() => {
    if (loaded.state !== "ready" || decidedAt.current === null) return;
    const at = decidedAt.current;
    decidedAt.current = null;
    const buttons = list.current?.querySelectorAll<HTMLButtonElement>(".queue-approve") ?? [];
    const next = buttons[Math.min(at, buttons.length - 1)];
    if (next) next.focus({ preventScroll: false });
    else focusSection(titleId("services"));
  }, [loaded]);
  const decided = useCallback(
    (index: number, text: string) => {
      decidedAt.current = index;
      setSaid(text);
      reload();
    },
    [reload],
  );
  return (
    <>
      <p className="visually-hidden" aria-live="polite">
        {said}
      </p>
      <LoadedView loaded={loaded} onRetry={reload} skeleton="block">
        {() =>
          state.list.items.length === 0 ? (
            <QueueEmpty queue="services" />
          ) : (
            <ul className="rcards" ref={list}>
              {state.list.items.map((item, index) => (
                <ServiceQueueCard
                  key={`${item.kind}-${item.service.id}`}
                  item={item}
                  onDecided={(text) => decided(index, text)}
                />
              ))}
            </ul>
          )
        }
      </LoadedView>
      <QueueFooter queue="services" state={state} />
    </>
  );
}

/** Услуга в очереди: что предлагают, кто и когда; одобрить или отклонить с причиной */
function ServiceQueueCard({
  item,
  onDecided,
}: {
  item: ServiceQueueItem;
  onDecided: (said: string) => void;
}) {
  const { service } = item;
  const name = service.name.ru;

  return (
    <li className="rcard rcard-tap">
      <div className="rcard-head">
        <Link
          to={{ name: "listing", id: item.listing.id, query: { focus: "services" } }}
          className="rcard-link"
        >
          {name}
        </Link>
        <Pill tone={toneOf("serviceQueue", item.kind)}>{t.serviceQueueKinds[item.kind]}</Pill>
      </div>
      <p className="rcard-meta">
        <CategoryChip code={item.listing.categoryCode} /> {item.listing.name} · {vendorLabel(item.vendor)}{" "}
        <NotLiveStatus status={item.listing.status} />
      </p>
      <p className="rcard-meta">
        {t.proposedBy(item.proposedBy.kind, item.proposedBy.name)} · {formatMoment(item.submittedAt)}
      </p>
      {item.kind === "proposal" ? (
        <ServiceChanges service={service} />
      ) : (
        <p className="rcard-meta">
          {formatPrice(service.priceUzs, service.priceUnit)}
          {service.options.length > 0
            ? ` · ${t.serviceFields.options}: ${service.options.map((o) => `${o.name.ru} — ${formatPrice(o.priceUzs, o.priceUnit)}`).join("; ")}`
            : ""}
          {service.includes?.ru ? ` · ${service.includes.ru}` : ""}
        </p>
      )}
      <ServiceDecision
        service={service}
        approveClass="queue-approve"
        onDecided={(outcome) =>
          onDecided(outcome === "approved" ? t.serviceApproved(name) : t.serviceDeclinedSaid(name))
        }
      />
    </li>
  );
}
