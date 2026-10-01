/* Модерация: карточки на проверке — по порядку отправки (решение — на странице карточки),
   правки опубликованных карточек от вендоров и менеджеров (решение — на странице правки),
   услуги и правки услуг опубликованных витрин (решение — прямо в очереди: одобрить или
   отклонить с причиной для партнёра) и новые фото опубликованных карточек — старые загрузки
   первыми (одобрить или отклонить — на странице карточки, в блоке фото). Элемент очереди —
   карточка целиком: нажатие в любом её месте открывает то, по чему решать. */

import type {
  ListingList,
  ListingService,
  RevisionList,
  ServiceQueue,
  ServiceQueueItem,
} from "@bayramm/shared/api/staff";
import { useRef, useState } from "react";
import { type Failure, useCan, useLoad, useSession } from "../api";
import { formatMoment, formatPrice, vendorLabel } from "../format";
import { t } from "../texts";
import {
  Blockers,
  CategoryChip,
  ConfirmForm,
  ErrorText,
  Link,
  LoadedView,
  PhoneSheet,
  Pill,
  publishBlockers,
} from "../ui";
import { ServiceChanges } from "./Services";

export function ModerationPage({ minPhotos }: { minPhotos: number }) {
  const can = useCan();
  return (
    <div className="stack">
      <section className="stack" aria-labelledby="review-title">
        <h2 id="review-title" className="section-title">
          {t.listingsInReview}
        </h2>
        <ReviewQueue minPhotos={minPhotos} />
      </section>
      <section className="stack" aria-labelledby="revisions-title">
        <h2 id="revisions-title" className="section-title">
          {t.revisions}
        </h2>
        <p className="muted small">{t.revisionsHint}</p>
        <RevisionQueue />
      </section>
      {can("revisions.moderate") ? (
        <section className="stack" aria-labelledby="service-queue-title">
          <h2 id="service-queue-title" className="section-title">
            {t.serviceQueue}
          </h2>
          <p className="muted small">{t.serviceQueueHint}</p>
          <ServiceQueueList />
        </section>
      ) : null}
      <section className="stack" aria-labelledby="photo-queue-title">
        <h2 id="photo-queue-title" className="section-title">
          {t.photoQueue}
        </h2>
        <p className="muted small">{t.photoQueueHint}</p>
        <PhotoQueue />
      </section>
    </div>
  );
}

function ReviewQueue({ minPhotos }: { minPhotos: number }) {
  const { loaded, reload } = useLoad<ListingList>("/staff/listings?status=review&limit=100");
  return (
    <LoadedView loaded={loaded} onRetry={reload} skeleton="block">
      {(list) =>
        list.items.length === 0 ? (
          <p className="empty">{t.moderationEmpty}</p>
        ) : (
          <ul className="rcards">
            {list.items.map((listing) => (
              <li key={listing.id} className="rcard rcard-tap">
                <Link to={{ name: "listing", id: listing.id }} className="rcard-link">
                  {listing.name}
                </Link>
                <p className="rcard-meta">
                  {vendorLabel(listing.vendor)} · {t.submittedAt} {formatMoment(listing.submittedAt)}
                </p>
                <p className="rcard-meta">
                  {formatPrice(listing.priceFromUzs, listing.priceUnit)}
                  {listing.capMax ? ` · до ${listing.capMax}` : ""} ·{" "}
                  {t.photosCount(listing.photos.ready, listing.photos.approved)}
                </p>
                <Blockers
                  title={t.blockersActive}
                  codes={publishBlockers(listing.blockers, listing.photos.ready, minPhotos)}
                />
              </li>
            ))}
          </ul>
        )
      }
    </LoadedView>
  );
}

function RevisionQueue() {
  const { loaded, reload } = useLoad<RevisionList>("/staff/revisions?status=pending&limit=100");
  return (
    <LoadedView loaded={loaded} onRetry={reload} skeleton="block">
      {(list) =>
        list.items.length === 0 ? (
          <p className="empty">{t.revisionsEmpty}</p>
        ) : (
          <ul className="rcards">
            {list.items.map((revision) => (
              <li key={revision.id} className="rcard rcard-tap">
                <Link to={{ name: "revision", id: revision.id }} className="rcard-link">
                  {revision.listing.name}
                </Link>
                <p className="rcard-meta">
                  {vendorLabel(revision.vendor)} · {t.submittedAt} {formatMoment(revision.submittedAt)}
                </p>
                <p className="rcard-meta">
                  {t.proposedBy(revision.proposedBy.kind, revision.proposedBy.name)}
                </p>
                <p className="rcard-meta">
                  {revision.fields.map((field) => t.revisionFields[field] ?? field).join(", ")}
                </p>
                {revision.stale && <p className="notice notice-warn">{t.revisionStale}</p>}
              </li>
            ))}
          </ul>
        )
      }
    </LoadedView>
  );
}

function PhotoQueue() {
  const { loaded, reload } = useLoad<ListingList>("/staff/listings?photos=pending&limit=100");
  return (
    <LoadedView loaded={loaded} onRetry={reload} skeleton="block">
      {(list) =>
        list.items.length === 0 ? (
          <p className="empty">{t.photoQueueEmpty}</p>
        ) : (
          <ul className="rcards">
            {list.items.map((listing) => (
              <li key={listing.id} className="rcard rcard-tap">
                <Link to={{ name: "listing", id: listing.id }} className="rcard-link">
                  {listing.name}
                </Link>
                <p className="rcard-meta">{vendorLabel(listing.vendor)}</p>
                <p className="rcard-meta">
                  {t.pendingPhotos(listing.photos.pending)} ·{" "}
                  {t.photosCount(listing.photos.ready, listing.photos.approved)}
                </p>
              </li>
            ))}
          </ul>
        )
      }
    </LoadedView>
  );
}

function ServiceQueueList() {
  const { loaded, reload } = useLoad<ServiceQueue>("/staff/services?status=pending&limit=100");
  return (
    <LoadedView loaded={loaded} onRetry={reload} skeleton="block">
      {(queue) =>
        queue.items.length === 0 ? (
          <p className="empty">{t.serviceQueueEmpty}</p>
        ) : (
          <ul className="rcards">
            {queue.items.map((item) => (
              <ServiceQueueCard key={`${item.kind}-${item.service.id}`} item={item} onDecided={reload} />
            ))}
          </ul>
        )
      }
    </LoadedView>
  );
}

/** Услуга в очереди: что предлагают, кто и когда; одобрить или отклонить с причиной */
function ServiceQueueCard({ item, onDecided }: { item: ServiceQueueItem; onDecided: () => void }) {
  const { api } = useSession();
  const [declining, setDeclining] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const declineButton = useRef<HTMLButtonElement>(null);
  const { service } = item;
  const name = service.name.ru;

  const approve = async () => {
    setBusy(true);
    const result = await api.post<ListingService>(`/staff/services/${service.id}/approve`);
    setBusy(false);
    setFailure(result.ok ? null : result);
    if (result.ok) onDecided();
  };
  const decline = async (reason: string): Promise<Failure | null> => {
    const result = await api.post<ListingService>(`/staff/services/${service.id}/decline`, { reason });
    if (!result.ok) return result;
    setDeclining(false);
    onDecided();
    return null;
  };

  return (
    <li className="rcard rcard-tap">
      <div className="rcard-head">
        <Link to={{ name: "listing", id: item.listing.id }} className="rcard-link">
          {name}
        </Link>
        <Pill tone={item.kind === "proposal" ? "outline" : "muted"}>{t.serviceQueueKinds[item.kind]}</Pill>
      </div>
      <p className="rcard-meta">
        <CategoryChip code={item.listing.categoryCode} /> {item.listing.name} · {vendorLabel(item.vendor)}
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
      <div className="rcard-actions">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void approve()}>
          {t.serviceApprove}
          <span className="visually-hidden">: {name}</span>
        </button>
        <button
          ref={declineButton}
          type="button"
          className="btn btn-danger"
          aria-expanded={declining}
          disabled={busy}
          onClick={() => setDeclining(!declining)}
        >
          {t.serviceDecline}
          <span className="visually-hidden">: {name}</span>
        </button>
      </div>
      {failure ? <ErrorText failure={failure} /> : null}
      <PhoneSheet
        open={declining}
        title={`${t.serviceDecline}: ${name}`}
        onClose={() => setDeclining(false)}
        returnFocus={declineButton}
      >
        <div className="rcard-actions">
          <ConfirmForm
            hint={t.serviceDeclineHint}
            label={t.reason}
            required
            danger
            submitLabel={t.serviceDecline}
            onSubmit={decline}
            onCancel={() => setDeclining(false)}
          />
        </div>
      </PhoneSheet>
    </li>
  );
}
