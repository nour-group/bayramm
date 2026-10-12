/* Модерация: витрины на проверке — по порядку отправки (решение — на странице витрины),
   предложения изменений от вендоров и менеджеров (решение — на странице предложения), услуги
   и изменения услуг (решение — прямо в очереди: одобрить или отклонить с причиной для
   партнёра) и новые фото (решение — плиткой: ✓ одобрить, ✕ отклонить с причиной, «Одобрить
   все» — по карточке). Услуги и фото — у любых витрин, кроме отклонённых: партнёр видит «на
   проверке» и у черновика, поэтому у карточки очереди — статус витрины, если она не на сайте.
   Карточка витрины и предложения — ссылка целиком: нажатие в любом месте открывает то, по чему
   решать.

   Разбор с телефона: одна очередь за раз — сегменты «Витрины · Предложения · Услуги · Фото» с
   числом ждущих; пустые очереди в них не показываются, открыта первая непустая, а все пусты —
   одна строка «Всё разобрано». Какая очередь открыта — в адресе (?queue=photos): «назад» из
   витрины и ссылка из метрик ведут к ней; пустую очередь из адреса не открываем. Пояснений у
   очередей нет — кто и что прислал, видно по самой карточке.

   После решения очередь перечитывается тихо (без заготовки), фокус — на следующую услугу или
   фото (в той же карточке, а кончилась она — в следующей), а когда очередь опустела, — на
   сегменты (или на «Всё разобрано»); что решили — говорит строка статуса.

   Очередь — страницами: на компьютере листается, на телефоне «Показать ещё» дописывает
   следующую. Фото и услуги очереди открывают витрину сразу на своём блоке (?focus=). Фото
   очереди приходят в самом списке (pendingPhotos): запроса на каждую карточку нет. */

import type {
  ListingList,
  ListingListItem,
  ListingStatus,
  PendingPhoto,
  RevisionList,
  RevisionListItem,
  ServiceQueue,
  ServiceQueueItem,
} from "@bayramm/shared/api/staff";
import { Dialog, RadioGroup } from "@bayramm/ui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Failure, useCan, useSession } from "../api";
import { CategoryChip, formatPrice } from "../categories";
import { formatMoment, photoSrc, photoSrcSet, vendorLabel } from "../format";
import { Icon } from "../icons";
import { usePhone } from "../layout";
import { useQueryState } from "../router";
import { t } from "../texts";
import {
  ConfirmForm,
  ErrorText,
  focusSection,
  Link,
  ListFooter,
  LoadedView,
  Pill,
  publishBlockers,
  Skeleton,
  StatusPill,
  toneOf,
  usePagedList,
} from "../ui";
import { ServiceChanges, ServiceDecision } from "./Services";

type Queue = "review" | "revisions" | "services" | "photos";

const QUEUES: readonly Queue[] = ["review", "revisions", "services", "photos"];

/** Карточек очереди на странице */
const PAGE = 20;

/** Причина отказа по фото — не длиннее, чем принимает сервер */
const REASON_MAX = 500;

/** Названия очередей — для диктора (заголовок над карточками); на глаз — сегменты */
const QUEUE_TITLE: Readonly<Record<Queue, string>> = {
  review: t.listingsInReview,
  revisions: t.revisions,
  services: t.serviceQueue,
  photos: t.photoQueue,
};

const titleId = (queue: Queue) => `queue-${queue}-title`;

/** Очередь страницами: компьютер — своя страница у каждой очереди, телефон — «Показать ещё» */
function useQueue<I, L extends { readonly total: number; readonly items: readonly I[] }>(
  path: string | null,
) {
  const phone = usePhone();
  const [offset, setOffset] = useState(0);
  const list = usePagedList<I, L>(path, { size: PAGE, offset, append: phone });
  // Сколько всего (не только показанная страница), когда загрузилась: для сегментов и заголовка
  const ready = list.loaded.state === "ready";
  const count = ready ? list.total : null;
  // Решили все карточки последней страницы — страницы такой больше нет: к последней из оставшихся
  useEffect(() => {
    if (ready && list.items.length === 0 && list.total > 0 && offset > 0) {
      setOffset(Math.floor((list.total - 1) / PAGE) * PAGE);
    }
  }, [ready, list.items.length, list.total, offset]);
  return { list, offset, setOffset, count };
}

type QueueState<I, L extends { readonly total: number; readonly items: readonly I[] }> = ReturnType<
  typeof useQueue<I, L>
>;

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

export function ModerationPage({ minPhotos }: { minPhotos: number }) {
  const can = useCan();
  const decidesServices = can("revisions.moderate");
  const decidesPhotos = can("photos.moderate");
  const [query, setQuery] = useQueryState(["queue"] as const);
  const review = useQueue<ListingListItem, ListingList>("/staff/listings?status=review");
  const revisions = useQueue<RevisionListItem, RevisionList>("/staff/revisions?status=pending");
  const services = useQueue<ServiceQueueItem, ServiceQueue>(
    decidesServices ? "/staff/services?status=pending" : null,
  );
  const photos = useQueue<ListingListItem, ListingList>("/staff/listings?photos=pending");
  const counts: Readonly<Record<Queue, number | null>> = {
    review: review.count,
    revisions: revisions.count,
    services: services.count,
    photos: photos.count,
  };
  const loaded = {
    review: review.list.loaded,
    revisions: revisions.list.loaded,
    services: services.list.loaded,
    photos: photos.list.loaded,
  };
  const queues = QUEUES.filter((queue) => queue !== "services" || decidesServices);
  const settled = queues.every((queue) => loaded[queue].state !== "loading");
  // Пустые очереди не показываем; не прочитавшаяся — показываем: у неё «Повторить»
  const open = queues.filter((queue) => counts[queue] === null || counts[queue] !== 0);
  // Из адреса — если в ней есть что решать; иначе первая непустая
  const active = open.find((queue) => queue === query.queue) ?? open[0] ?? null;

  // Решили последнее в очереди — она пропала из сегментов: фокус не теряется, а идёт на сегменты
  const tabs = useRef<HTMLDivElement>(null);
  const done = useRef<HTMLParagraphElement>(null);
  const deciding = useRef(false);
  const previous = useRef<Queue | null>(null);
  useEffect(() => {
    if (!settled) return;
    if (previous.current !== null && previous.current !== active && deciding.current) {
      deciding.current = false;
      if (active === null) done.current?.focus({ preventScroll: true });
      else tabs.current?.querySelector<HTMLElement>("input:checked")?.focus({ preventScroll: true });
    }
    previous.current = active;
  }, [active, settled]);
  const onDecided = useCallback(() => {
    deciding.current = true;
  }, []);
  const settledFocus = useCallback(() => {
    deciding.current = false;
  }, []);

  if (!settled) return <Skeleton kind="block" />;
  if (active === null) {
    return (
      <p ref={done} tabIndex={-1} className="muted queue-empty" role="status">
        {t.moderationAllDone}
      </p>
    );
  }

  return (
    <div className="stack">
      {/* Одна очередь за раз: число ждущих — в сегменте, пустые не показываются */}
      <div ref={tabs}>
        <RadioGroup<Queue>
          variant="pill"
          className="queue-tabs"
          name="moderation-queue"
          label={t.moderation}
          value={active}
          onChange={(queue) => setQuery({ queue })}
          options={open.map((queue) => ({
            value: queue,
            label: counts[queue] === null ? t.queueTabs[queue] : `${t.queueTabs[queue]} ${counts[queue]}`,
          }))}
        />
      </div>

      <section className="stack queue" aria-labelledby={titleId(active)}>
        <h2 id={titleId(active)} className="visually-hidden" tabIndex={-1}>
          {QUEUE_TITLE[active]}{" "}
          {counts[active] !== null ? <span className="count">{counts[active]}</span> : null}
        </h2>
        {active === "review" ? (
          <>
            <LoadedView loaded={review.list.loaded} onRetry={review.list.reload} skeleton="block">
              {() => <ReviewQueue items={review.list.items} minPhotos={minPhotos} />}
            </LoadedView>
            <QueueFooter queue="review" state={review} />
          </>
        ) : null}
        {active === "revisions" ? (
          <>
            <LoadedView loaded={revisions.list.loaded} onRetry={revisions.list.reload} skeleton="block">
              {() => <RevisionQueue items={revisions.list.items} />}
            </LoadedView>
            <QueueFooter queue="revisions" state={revisions} />
          </>
        ) : null}
        {active === "services" ? (
          <ServiceQueueList state={services} onDecided={onDecided} onFocused={settledFocus} />
        ) : null}
        {active === "photos" ? (
          <PhotoQueueList
            state={photos}
            decides={decidesPhotos}
            onDecided={onDecided}
            onFocused={settledFocus}
          />
        ) : null}
      </section>
    </div>
  );
}

/** «до 300 гостей» — вместимость там, где она есть (залы) */
const capacityText = (capMax: number | null) => (capMax ? ` · ${t.guestsUpTo(capMax)}` : "");

function ReviewQueue({ items, minPhotos }: { items: readonly ListingListItem[]; minPhotos: number }) {
  return (
    <ul className="rcards">
      {items.map((listing) => {
        // Что именно не хватает — на странице витрины: в карточке очереди хватит числа
        const missing = publishBlockers(listing.blockers, listing.photos.ready, minPhotos).length;
        return (
          <li key={listing.id} className="rcard rcard-tap">
            <div className="rcard-head">
              <Link to={{ name: "listing", id: listing.id }} className="rcard-link">
                {listing.name}
              </Link>
              <CategoryChip code={listing.categoryCode} />
            </div>
            <p className="rcard-meta">
              {vendorLabel(listing.vendor)} · {formatMoment(listing.submittedAt)}
            </p>
            <p className="rcard-meta">
              {formatPrice(listing.priceFromUzs, listing.priceUnit)}
              {capacityText(listing.capMax)}
              {missing > 0 ? (
                <>
                  {" · "}
                  <strong className="rcard-missing">{t.missingN(missing)}</strong>
                </>
              ) : null}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

function RevisionQueue({ items }: { items: readonly RevisionListItem[] }) {
  return (
    <ul className="rcards">
      {items.map((revision) => (
        <li key={revision.id} className="rcard rcard-tap">
          <Link to={{ name: "revision", id: revision.id }} className="rcard-link">
            {revision.listing.name}
          </Link>
          <p className="rcard-meta">
            {vendorLabel(revision.vendor)} · {formatMoment(revision.submittedAt)}
          </p>
          <p className="rcard-meta">
            {t.queueProposer(revision.proposedBy.kind, revision.proposedBy.name)} ·{" "}
            {revision.fields.map((field) => t.revisionFields[field] ?? field).join(", ")}
          </p>
          {revision.stale && <p className="notice notice-warn">{t.revisionStale}</p>}
        </li>
      ))}
    </ul>
  );
}

// ── фото ───────────────────────────────────────────────────────────────────

/** Куда вернуть фокус после перечитывания очереди: карточка, плитка в ней и место карточки */
interface DecidedPhoto {
  readonly listing: string;
  readonly tile: number;
  readonly card: number;
}

interface PhotoQueueProps {
  state: QueueState<ListingListItem, ListingList>;
  /** Решает по фото (photos.moderate): без права плитки — только смотреть */
  decides: boolean;
  onDecided: () => void;
  onFocused: () => void;
}

/**
 * Очередь фото: карточка витрины с плитками ждущих фото. После решения очередь перечитывается
 * тихо, фокус — на ✓ следующей плитки этой карточки, а решили все — на ✓ первой плитки
 * следующей карточки; опустела очередь — фокус ставит страница
 */
function PhotoQueueList({ state, decides, onDecided, onFocused }: PhotoQueueProps) {
  const { loaded, reload } = state.list;
  const list = useRef<HTMLUListElement>(null);
  const decidedAt = useRef<DecidedPhoto | null>(null);
  const [said, setSaid] = useState("");
  useEffect(() => {
    if (loaded.state !== "ready" || decidedAt.current === null) return;
    const at = decidedAt.current;
    decidedAt.current = null;
    const cards = Array.from(list.current?.children ?? []);
    const own = cards
      .find((card) => card instanceof HTMLElement && card.dataset.listing === at.listing)
      ?.querySelectorAll<HTMLButtonElement>(".photo-approve:not(:disabled)");
    const next =
      own && own.length > 0
        ? own[Math.min(at.tile, own.length - 1)]
        : cards[Math.min(at.card, cards.length - 1)]?.querySelector<HTMLButtonElement>(".photo-approve");
    if (next) {
      next.focus();
      onFocused();
    }
  }, [loaded, onFocused]);
  const decided = useCallback(
    (at: DecidedPhoto, text: string) => {
      decidedAt.current = at;
      setSaid(text);
      onDecided();
      reload();
    },
    [onDecided, reload],
  );
  return (
    <>
      <p className="visually-hidden" aria-live="polite">
        {said}
      </p>
      <LoadedView loaded={loaded} onRetry={reload} skeleton="block">
        {() => (
          <ul className="rcards" ref={list}>
            {state.list.items.map((listing, index) => (
              <PhotoCard
                key={listing.id}
                listing={listing}
                index={index}
                decides={decides}
                onDecided={decided}
              />
            ))}
          </ul>
        )}
      </LoadedView>
      <QueueFooter queue="photos" state={state} />
    </>
  );
}

/**
 * Карточка витрины в очереди фото: плитки ждущих фото (их присылает сам список), под каждой — ✓ и
 * ✕ (отказ — с причиной в шторке), и «Одобрить все» — по карточке. Решённая плитка тускнеет, пока
 * очередь не перечитается: фокус и порядок остаются на месте
 */
function PhotoCard({
  listing,
  index,
  decides,
  onDecided,
}: {
  listing: ListingListItem;
  index: number;
  decides: boolean;
  onDecided: (at: DecidedPhoto, said: string) => void;
}) {
  const { api } = useSession();
  const photos = listing.pendingPhotos ?? [];
  const [decidedIds, setDecidedIds] = useState<ReadonlySet<string>>(new Set());
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [declining, setDeclining] = useState<{ photo: PendingPhoto; n: number } | null>(null);
  const base = `/staff/listings/${listing.id}/photos`;
  const open = photos.filter((photo) => !decidedIds.has(photo.id));
  const more = Math.max(0, listing.photos.pending - photos.length);
  const mark = (id: string) => setDecidedIds((prev) => new Set(prev).add(id));

  const approve = async (photo: PendingPhoto, tile: number) => {
    setWorking(true);
    setFailure(null);
    const result = await api.post(`${base}/${photo.id}/moderation`, { decision: "approved" });
    setWorking(false);
    if (!result.ok) {
      setFailure(result);
      return;
    }
    mark(photo.id);
    onDecided({ listing: listing.id, tile, card: index }, t.photoApprovedSaid(listing.name));
  };

  const approveAll = async () => {
    setWorking(true);
    setFailure(null);
    let approved = 0;
    for (const photo of open) {
      const result = await api.post(`${base}/${photo.id}/moderation`, { decision: "approved" });
      if (!result.ok) {
        setFailure(result);
        break;
      }
      mark(photo.id);
      approved += 1;
    }
    setWorking(false);
    // Хоть что-то решили — перечитать очередь, даже если на какой-то по счёту отказали
    if (approved > 0)
      onDecided(
        { listing: listing.id, tile: 0, card: index },
        t.photoApprovedAllSaid(approved, listing.name),
      );
  };

  const decline = async (reason: string): Promise<Failure | null> => {
    if (!declining) return null;
    const { photo } = declining;
    const result = await api.post(`${base}/${photo.id}/moderation`, { decision: "declined", reason });
    if (!result.ok) return result;
    mark(photo.id);
    setDeclining(null);
    onDecided(
      {
        listing: listing.id,
        tile: Math.max(
          0,
          open.findIndex((p) => p.id === photo.id),
        ),
        card: index,
      },
      t.photoDeclinedSaid(listing.name),
    );
    return null;
  };

  return (
    <li className="rcard photo-card" data-listing={listing.id}>
      <div className="rcard-head">
        {/* Витрина — сразу на блоке фото: целиком посмотреть и решить там */}
        <Link to={{ name: "listing", id: listing.id, query: { focus: "photos" } }} className="rcard-title">
          {listing.name}
        </Link>
        <NotLiveStatus status={listing.status} />
      </div>
      <p className="rcard-meta">
        {vendorLabel(listing.vendor)} · {t.pendingPhotos(listing.photos.pending)}
      </p>
      <ul className="queue-photos">
        {photos.map((photo, tile) => {
          const decidedHere = decidedIds.has(photo.id);
          return (
            <li key={photo.id} className={`queue-photo${decidedHere ? " is-decided" : ""}`}>
              <img
                src={photoSrc(photo.key, 640)}
                srcSet={photoSrcSet(photo.key)}
                sizes="(max-width: 719px) 50vw, 200px"
                width={photo.width > 0 ? photo.width : undefined}
                height={photo.height > 0 ? photo.height : undefined}
                alt=""
                loading="lazy"
                decoding="async"
              />
              {decides ? (
                <div className="queue-photo-acts">
                  <button
                    type="button"
                    className="btn btn-icon photo-approve"
                    disabled={working || decidedHere}
                    onClick={() => void approve(photo, tile)}
                  >
                    <Icon name="check" size={20} />
                    <span>{t.photoApproveOne(tile + 1, listing.name)}</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-icon btn-danger"
                    disabled={working || decidedHere}
                    onClick={() => {
                      setFailure(null);
                      setDeclining({ photo, n: tile + 1 });
                    }}
                  >
                    <Icon name="close" size={20} />
                    <span>{t.photoDeclineOne(tile + 1, listing.name)}</span>
                  </button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {more > 0 ? <p className="rcard-meta">{t.photosMoreOnPage(more)}</p> : null}
      {decides && open.length > 1 ? (
        <div className="rcard-actions">
          <button
            type="button"
            className="btn btn-primary photo-approve-all"
            aria-busy={working || undefined}
            disabled={working}
            onClick={() => void approveAll()}
          >
            {t.photoApproveAll(open.length)}
            <span className="visually-hidden">: {listing.name}</span>
          </button>
        </div>
      ) : null}
      {failure ? <ErrorText failure={failure} /> : null}
      <Dialog
        open={declining !== null}
        title={`${t.declinePhotoTitle(declining?.n ?? 0)} · ${listing.name}`}
        onClose={() => setDeclining(null)}
      >
        {declining ? (
          <ConfirmForm
            key={declining.photo.id}
            hint={t.declinePhotoHint(declining.n)}
            label={t.reason}
            required
            danger
            presets={t.reasons.photoDecline}
            maxLength={REASON_MAX}
            submitLabel={t.declinePhoto}
            onSubmit={decline}
            onCancel={() => setDeclining(null)}
          />
        ) : null}
      </Dialog>
    </li>
  );
}

// ── услуги ─────────────────────────────────────────────────────────────────

interface ServiceQueueProps {
  state: QueueState<ServiceQueueItem, ServiceQueue>;
  onDecided: () => void;
  onFocused: () => void;
}

/**
 * Очередь услуг: решение — прямо здесь. После решения очередь перечитывается тихо (без
 * заготовки), фокус — на «Одобрить» услуги, вставшей на место решённой; кончилась очередь —
 * фокус ставит страница; строка статуса говорит, что решили
 */
function ServiceQueueList({ state, onDecided, onFocused }: ServiceQueueProps) {
  const { loaded, reload } = state.list;
  const list = useRef<HTMLUListElement>(null);
  // Место решённой услуги в очереди: после перечитывания фокус — туда
  const decidedAt = useRef<number | null>(null);
  const [said, setSaid] = useState("");
  useEffect(() => {
    if (loaded.state !== "ready" || decidedAt.current === null) return;
    const at = decidedAt.current;
    decidedAt.current = null;
    const buttons = list.current?.querySelectorAll<HTMLButtonElement>(".queue-approve") ?? [];
    const next = buttons[Math.min(at, buttons.length - 1)];
    if (next) {
      next.focus({ preventScroll: false });
      onFocused();
    }
  }, [loaded, onFocused]);
  const decided = useCallback(
    (index: number, text: string) => {
      decidedAt.current = index;
      setSaid(text);
      onDecided();
      reload();
    },
    [onDecided, reload],
  );
  return (
    <>
      <p className="visually-hidden" aria-live="polite">
        {said}
      </p>
      <LoadedView loaded={loaded} onRetry={reload} skeleton="block">
        {() => (
          <ul className="rcards" ref={list}>
            {state.list.items.map((item, index) => (
              <ServiceQueueCard
                key={`${item.kind}-${item.service.id}`}
                item={item}
                onDecided={(text) => decided(index, text)}
              />
            ))}
          </ul>
        )}
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
        {t.queueProposer(item.proposedBy.kind, item.proposedBy.name)} · {formatMoment(item.submittedAt)}
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
