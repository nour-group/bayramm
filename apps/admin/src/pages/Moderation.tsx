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
   решили — говорит строка статуса. */

import type {
  ListingList,
  ListingStatus,
  RevisionList,
  ServiceQueue,
  ServiceQueueItem,
} from "@bayramm/shared/api/staff";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { type Loaded, useCan, useLoad } from "../api";
import { CategoryChip } from "../categories";
import { formatMoment, formatPrice, vendorLabel } from "../format";
import { t } from "../texts";
import { Blockers, focusSection, Link, LoadedView, Pill, publishBlockers, StatusPill } from "../ui";
import { ServiceChanges, ServiceDecision } from "./Services";

type Queue = "review" | "revisions" | "services" | "photos";

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

/** Сколько в очереди всего (не только загруженная сотня), когда загрузилась: для сводки и заголовка */
function countOf<T extends { readonly total: number }>(loaded: Loaded<T>): number | null {
  return loaded.state === "ready" ? loaded.data.total : null;
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
  const review = useLoad<ListingList>("/staff/listings?status=review&limit=100");
  const revisions = useLoad<RevisionList>("/staff/revisions?status=pending&limit=100");
  const photos = useLoad<ListingList>("/staff/listings?photos=pending&limit=100");
  const queues: readonly Queue[] = services
    ? ["review", "revisions", "services", "photos"]
    : ["review", "revisions", "photos"];
  const [serviceCount, setServiceCount] = useState<number | null>(null);
  const counts: Readonly<Record<Queue, number | null>> = {
    review: countOf(review.loaded),
    revisions: countOf(revisions.loaded),
    services: serviceCount,
    photos: countOf(photos.loaded),
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
            onClick={() => focusSection(titleId(queue))}
          >
            {QUEUE_TITLE[queue]}
            <span className="chip-count">{counts[queue] ?? "…"}</span>
          </button>
        ))}
      </nav>

      <QueueSection queue="review" count={counts.review}>
        <LoadedView loaded={review.loaded} onRetry={review.reload} skeleton="block">
          {(list) => <ReviewQueue list={list} minPhotos={minPhotos} />}
        </LoadedView>
      </QueueSection>
      <QueueSection queue="revisions" count={counts.revisions}>
        <LoadedView loaded={revisions.loaded} onRetry={revisions.reload} skeleton="block">
          {(list) => <RevisionQueue list={list} />}
        </LoadedView>
      </QueueSection>
      {services ? (
        <QueueSection queue="services" count={counts.services}>
          <ServiceQueueList onCount={setServiceCount} />
        </QueueSection>
      ) : null}
      <QueueSection queue="photos" count={counts.photos}>
        <LoadedView loaded={photos.loaded} onRetry={photos.reload} skeleton="block">
          {(list) => <PhotoQueue list={list} />}
        </LoadedView>
      </QueueSection>
    </div>
  );
}

/** «до 300 гостей» — вместимость там, где она есть (залы) */
const capacityText = (capMax: number | null) => (capMax ? ` · ${t.guestsUpTo(capMax)}` : "");

function ReviewQueue({ list, minPhotos }: { list: ListingList; minPhotos: number }) {
  if (list.items.length === 0) return <QueueEmpty queue="review" />;
  return (
    <ul className="rcards">
      {list.items.map((listing) => (
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

function RevisionQueue({ list }: { list: RevisionList }) {
  if (list.items.length === 0) return <QueueEmpty queue="revisions" />;
  return (
    <ul className="rcards">
      {list.items.map((revision) => (
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

function PhotoQueue({ list }: { list: ListingList }) {
  if (list.items.length === 0) return <QueueEmpty queue="photos" />;
  return (
    <ul className="rcards">
      {list.items.map((listing) => (
        <li key={listing.id} className="rcard rcard-tap">
          <div className="rcard-head">
            <Link to={{ name: "listing", id: listing.id }} className="rcard-link">
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
  const { loaded, reload } = useLoad<ServiceQueue>("/staff/services?status=pending&limit=100");
  const list = useRef<HTMLUListElement>(null);
  // Место решённой услуги в очереди: после перечитывания фокус — туда
  const decidedAt = useRef<number | null>(null);
  const [said, setSaid] = useState("");
  const count = countOf(loaded);
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
        {(queue) =>
          queue.items.length === 0 ? (
            <QueueEmpty queue="services" />
          ) : (
            <ul className="rcards" ref={list}>
              {queue.items.map((item, index) => (
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
        <Link to={{ name: "listing", id: item.listing.id }} className="rcard-link">
          {name}
        </Link>
        <Pill tone={item.kind === "proposal" ? "outline" : "muted"}>{t.serviceQueueKinds[item.kind]}</Pill>
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
