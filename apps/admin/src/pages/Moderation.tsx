/* Модерация: витрины на проверке — по порядку отправки (решение — на странице витрины),
   предложения изменений от вендоров и менеджеров (решение — на странице предложения), услуги
   и изменения услуг (решение — прямо в очереди: одобрить или отклонить с причиной для
   партнёра) и новые фото (решение — плиткой: ✓ одобрить, ✕ отклонить с причиной, «Одобрить
   все» — по карточке). Услуги и фото — у любых витрин, кроме отклонённых: партнёр видит «на
   проверке» и у черновика, поэтому у карточки очереди — статус витрины, если она не на сайте.
   Фото: под плиткой — что отметил загрузивший («лиц нет» или «люди согласны»), над плитками —
   правило фото категории; нажатие на плитку открывает просмотр во весь экран (листать ← →,
   решать там же). «Одобрить все» — сразу, если каждое фото открыто, иначе — с подтверждением
   числа. Число у очереди «Фото» — сами фото, а не витрины.
   Карточка витрины и предложения — ссылка целиком: нажатие в любом месте открывает то, по чему
   решать.

   Разбор с телефона: одна очередь за раз — сегменты «Витрины · Предложения · Услуги · Фото» с
   числом ждущих; пустые очереди в них не показываются, открыта первая непустая, а все пусты —
   одна строка «Всё разобрано». Какая очередь открыта — в адресе (?queue=photos): «назад» из
   витрины и ссылка из метрик ведут к ней; пустую очередь из адреса не открываем. Пояснений у
   очередей нет — кто и что прислал, видно по самой карточке. Смена контактов витрины (партнёр
   просит новый телефон или Telegram) — своя очередь «Контакты»: решение — на странице витрины
   (блок «Партнёр предлагает новые контакты»), номеров в очереди нет.

   После решения очередь перечитывается тихо (без заготовки), фокус — на следующую услугу или
   фото (в той же карточке, а кончилась она — в следующей), а когда очередь опустела, — на
   сегменты (или на «Всё разобрано»); что решили — говорит строка статуса.

   Очередь — страницами: на компьютере листается, на телефоне «Показать ещё» дописывает
   следующую. Фото и услуги очереди открывают витрину сразу на своём блоке (?focus=). Фото
   очереди приходят в самом списке (pendingPhotos): запроса на каждую карточку нет. */

import type {
  ContactChangeList,
  ContactChangeListItem,
  ListingList,
  ListingListItem,
  ListingStatus,
  PendingPhoto,
  RevisionList,
  RevisionListItem,
  ServiceQueue,
  ServiceQueueItem,
} from "@bayramm/shared/api/staff";
import { categoryConfig } from "@bayramm/shared/categories";
import { ConfirmSheet, Dialog, RadioGroup } from "@bayramm/ui/react";
import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from "react";
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

type Queue = "review" | "revisions" | "services" | "contacts" | "photos";

const QUEUES: readonly Queue[] = ["review", "revisions", "services", "contacts", "photos"];

/** Карточек очереди на странице */
const PAGE = 20;

/** Причина отказа по фото — не длиннее, чем принимает сервер */
const REASON_MAX = 500;

/** Названия очередей — для диктора (заголовок над карточками); на глаз — сегменты */
const QUEUE_TITLE: Readonly<Record<Queue, string>> = {
  review: t.listingsInReview,
  revisions: t.revisions,
  services: t.serviceQueue,
  contacts: t.contactQueue,
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
  // Смену контактов решают те же, кто решает по правкам (revisions.moderate)
  const contacts = useQueue<ContactChangeListItem, ContactChangeList>(
    decidesServices ? "/staff/contact-changes" : null,
  );
  const photos = useQueue<ListingListItem, ListingList>("/staff/listings?photos=pending");
  // У очереди фото число — фото (как у остальных очередей — их предметы), а не витрины
  const photosLoaded = photos.list.loaded;
  const photoCount =
    photosLoaded.state === "ready" ? (photosLoaded.data.pendingPhotosTotal ?? photos.count) : null;
  const counts: Readonly<Record<Queue, number | null>> = {
    review: review.count,
    revisions: revisions.count,
    services: services.count,
    contacts: contacts.count,
    photos: photoCount,
  };
  const loaded = {
    review: review.list.loaded,
    revisions: revisions.list.loaded,
    services: services.list.loaded,
    contacts: contacts.list.loaded,
    photos: photos.list.loaded,
  };
  const queues = QUEUES.filter((queue) => (queue !== "services" && queue !== "contacts") || decidesServices);
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
        {active === "contacts" ? (
          <>
            <LoadedView loaded={contacts.list.loaded} onRetry={contacts.list.reload} skeleton="block">
              {() => <ContactQueue items={contacts.list.items} />}
            </LoadedView>
            <QueueFooter queue="contacts" state={contacts} />
          </>
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
            {t.queueChanges(revision.fields.map((field) => t.revisionFields[field] ?? field).join(", "))}
          </p>
          {revision.stale && <p className="notice notice-warn">{t.revisionStale}</p>}
        </li>
      ))}
    </ul>
  );
}

/** Смена контактов: что меняют и когда подано — без номеров; решение — на странице витрины */
function ContactQueue({ items }: { items: readonly ContactChangeListItem[] }) {
  return (
    <ul className="rcards">
      {items.map((change) => (
        <li key={change.id} className="rcard rcard-tap">
          <div className="rcard-head">
            <Link
              to={{ name: "listing", id: change.listing.id, query: { focus: "contacts" } }}
              className="rcard-link"
            >
              {change.listing.name}
            </Link>
            <CategoryChip code={change.listing.categoryCode} />
            <NotLiveStatus status={change.listing.status} />
          </div>
          <p className="rcard-meta">
            {change.vendor.code} ·{" "}
            {t.contactChange.what(
              change.phoneChanged,
              change.telegramChanged,
              formatMoment(change.submittedAt),
            )}
          </p>
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
 * Карточка витрины в очереди фото: правило фото категории, плитки ждущих фото (их присылает сам
 * список) с отметкой загрузившего, под каждой — ✓ и ✕ (отказ — с причиной в шторке), и «Одобрить
 * все» — по карточке. Плитка открывает просмотр во весь экран. Решённая плитка тускнеет, пока
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
  // Просмотр во весь экран: какое фото открыто и какие уже открывали («Одобрить все» без вопроса)
  const [viewing, setViewing] = useState<string | null>(null);
  const [seen, setSeen] = useState<ReadonlySet<string>>(new Set());
  const [confirmAll, setConfirmAll] = useState(false);
  const title = useRef<HTMLAnchorElement>(null);
  const allButton = useRef<HTMLButtonElement>(null);
  const base = `/staff/listings/${listing.id}/photos`;
  const open = photos.filter((photo) => !decidedIds.has(photo.id));
  const more = Math.max(0, listing.photos.pending - photos.length);
  const mark = (id: string) => setDecidedIds((prev) => new Set(prev).add(id));
  const policy = categoryConfig(listing.categoryCode)?.photoPolicy;

  const view = (id: string) => {
    setViewing(id);
    setSeen((prev) => new Set(prev).add(id));
  };
  /** После решения в просмотре — следующее нерешённое фото; кончились — просмотр закрывается */
  const nextAfter = (id: string): string | null => {
    const rest = photos.filter((photo) => photo.id !== id && !decidedIds.has(photo.id));
    if (rest.length === 0) return null;
    const at = photos.findIndex((photo) => photo.id === id);
    return (rest.find((photo) => photos.indexOf(photo) > at) ?? rest[0] ?? null)?.id ?? null;
  };

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
    if (viewing === photo.id) {
      const next = nextAfter(photo.id);
      if (next) view(next);
      else setViewing(null);
    }
    onDecided({ listing: listing.id, tile, card: index }, t.photoApprovedSaid(listing.name));
  };

  const approveAll = async () => {
    setConfirmAll(false);
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
  // Каждое фото открыто во весь экран — одобрить все сразу; иначе — подтвердить число
  const unseen = open.filter((photo) => !seen.has(photo.id)).length;
  const askAll = () => (unseen === 0 ? void approveAll() : setConfirmAll(true));

  const decline = async (reason: string): Promise<Failure | null> => {
    if (!declining) return null;
    const { photo } = declining;
    const result = await api.post(`${base}/${photo.id}/moderation`, { decision: "declined", reason });
    if (!result.ok) return result;
    mark(photo.id);
    setDeclining(null);
    if (viewing === photo.id) {
      const next = nextAfter(photo.id);
      if (next) view(next);
      else setViewing(null);
    }
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

  const viewed = viewing === null ? -1 : photos.findIndex((photo) => photo.id === viewing);
  const current = viewed === -1 ? null : (photos[viewed] ?? null);

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
      {policy ? <p className="photo-rule">{t.photoRule[policy]}</p> : null}
      <ul className="queue-photos">
        {photos.map((photo, tile) => {
          const decidedHere = decidedIds.has(photo.id);
          return (
            <li key={photo.id} className={`queue-photo${decidedHere ? " is-decided" : ""}`}>
              {/* Плитка — кнопка: фото во весь экран, листать и решать там же */}
              <button
                type="button"
                className="queue-photo-open"
                aria-label={t.photoOpen(tile + 1, listing.name)}
                aria-haspopup="dialog"
                onClick={() => view(photo.id)}
              >
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
              </button>
              <p className="photo-claim">{t.photoAckClaim[photo.ack]}</p>
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
            ref={allButton}
            type="button"
            className="btn btn-primary photo-approve-all"
            aria-busy={working || undefined}
            disabled={working}
            onClick={askAll}
          >
            {t.photoApproveAll(open.length)}
            <span className="visually-hidden">: {listing.name}</span>
          </button>
        </div>
      ) : null}
      {failure ? <ErrorText failure={failure} /> : null}
      <ConfirmSheet
        open={confirmAll}
        title={t.photoApproveAllQ(open.length)}
        text={t.photoApproveAllText(open.length, open.length - unseen)}
        confirmLabel={t.photoApproveAllGo}
        cancelLabel={t.cancel}
        returnFocus={allButton}
        onConfirm={() => void approveAll()}
        onCancel={() => setConfirmAll(false)}
      />
      {current ? (
        <PhotoViewer
          photos={photos}
          at={viewed}
          listing={listing}
          decides={decides}
          working={working}
          decided={decidedIds}
          returnFocus={title}
          onGo={(id) => {
            setDeclining(null);
            view(id);
          }}
          onApprove={(photo, tile) => void approve(photo, tile)}
          onDecline={(photo, tile) => {
            setFailure(null);
            setDeclining({ photo, n: tile + 1 });
          }}
          declining={declining !== null && declining.photo.id === current.id}
          declineForm={
            declining ? (
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
            ) : null
          }
          failure={failure}
          onClose={() => {
            setDeclining(null);
            setViewing(null);
          }}
        />
      ) : (
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
      )}
    </li>
  );
}

interface PhotoViewerProps {
  photos: readonly PendingPhoto[];
  /** Какое по счёту открыто */
  at: number;
  listing: ListingListItem;
  decides: boolean;
  working: boolean;
  decided: ReadonlySet<string>;
  returnFocus: RefObject<HTMLElement | null>;
  onGo: (id: string) => void;
  onApprove: (photo: PendingPhoto, tile: number) => void;
  onDecline: (photo: PendingPhoto, tile: number) => void;
  /** Причина отказа открытого фото — форма прямо в просмотре */
  declining: boolean;
  declineForm: ReactNode;
  failure: Failure | null;
  onClose: () => void;
}

/**
 * Фото во весь экран: снимок целиком (не обрезан плиткой), что отметил загрузивший и правило
 * категории, листать — кнопками и стрелками ← →, решить — здесь же. Диалог набора: Esc и
 * крестик закрывают, Tab ходит внутри, фокус после закрытия — на название витрины
 */
function PhotoViewer({
  photos,
  at,
  listing,
  decides,
  working,
  decided,
  returnFocus,
  onGo,
  onApprove,
  onDecline,
  declining,
  declineForm,
  failure,
  onClose,
}: PhotoViewerProps) {
  const photo = photos[at];
  const total = photos.length;
  const go = (step: number) => {
    const next = photos[(at + step + total) % total];
    if (next) onGo(next.id);
  };
  // Стрелки листают, пока не вписывают причину отказа (в поле стрелки двигают курсор)
  const goRef = useRef(go);
  goRef.current = go;
  useEffect(() => {
    if (declining || total < 2) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, [role='radiogroup']")) return;
      if (event.key === "ArrowLeft") goRef.current(-1);
      else if (event.key === "ArrowRight") goRef.current(1);
      else return;
      event.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [declining, total]);
  // Решили или перелистнули: кнопка «Одобрить» была недоступна, пока шёл запрос, и фокус ушёл с
  // неё — возвращаем его в просмотр (на «Одобрить», без него — на сам диалог), иначе Esc и Tab
  // не дошли бы до просмотра
  const approveRef = useRef<HTMLButtonElement>(null);
  const shownId = photo?.id;
  useEffect(() => {
    if (working || shownId === undefined) return;
    const viewer = document.querySelector<HTMLElement>(".photo-viewer");
    if (viewer?.contains(document.activeElement)) return;
    (approveRef.current ?? viewer)?.focus({ preventScroll: true });
  }, [working, shownId]);
  if (!photo) return null;
  const policy = categoryConfig(listing.categoryCode)?.photoPolicy;
  const decidedHere = decided.has(photo.id);
  return (
    <Dialog
      open
      title={t.photoViewerTitle(at + 1, total, listing.name)}
      onClose={onClose}
      returnFocus={returnFocus}
      className="photo-viewer"
      actions={
        <div className="viewer-actions">
          <button
            type="button"
            className="btn btn-icon viewer-step"
            disabled={total < 2}
            onClick={() => go(-1)}
          >
            <Icon name="back" size={20} />
            <span className="visually-hidden">{t.photoPrev}</span>
          </button>
          {decides ? (
            <>
              <button
                ref={approveRef}
                type="button"
                className="btn btn-primary viewer-approve"
                disabled={working || decidedHere}
                onClick={() => onApprove(photo, at)}
              >
                {decidedHere ? t.photoDecidedHere : t.photoApprove}
              </button>
              <button
                type="button"
                className="btn btn-danger-fill viewer-decline"
                disabled={working || decidedHere || declining}
                onClick={() => onDecline(photo, at)}
              >
                {t.photoDecline}
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="btn btn-icon viewer-step"
            disabled={total < 2}
            onClick={() => go(1)}
          >
            <Icon name="forward" size={20} />
            <span className="visually-hidden">{t.photoNext}</span>
          </button>
        </div>
      }
    >
      <figure className="viewer-figure">
        <img
          key={photo.id}
          className="viewer-image"
          src={photoSrc(photo.key, 1280)}
          srcSet={photoSrcSet(photo.key, true)}
          sizes="100vw"
          width={photo.width > 0 ? photo.width : undefined}
          height={photo.height > 0 ? photo.height : undefined}
          alt=""
          decoding="async"
        />
        <figcaption className="viewer-claim">
          <span className="photo-claim">{t.photoAckClaim[photo.ack]}</span>
          {policy ? <span className="photo-rule">{t.photoRule[policy]}</span> : null}
          {total > 1 ? <span className="muted small viewer-keys">{t.photoViewerKeys}</span> : null}
        </figcaption>
      </figure>
      {declining ? declineForm : null}
      {failure ? <ErrorText failure={failure} /> : null}
    </Dialog>
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
