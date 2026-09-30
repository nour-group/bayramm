/* Модерация: карточки на проверке — по порядку отправки (решение — на странице карточки),
   правки опубликованных карточек от вендоров и менеджеров (решение — на странице правки)
   и новые фото опубликованных карточек — старые загрузки первыми (одобрить или отклонить —
   на странице карточки, в блоке фото). Элемент очереди — карточка целиком: нажатие в любом
   её месте открывает то, по чему решать. */

import type { ListingList, RevisionList } from "@bayramm/shared/api/staff";
import { useLoad } from "../api";
import { formatMoment, formatPrice, vendorLabel } from "../format";
import { t } from "../texts";
import { Blockers, Link, LoadedView, publishBlockers } from "../ui";

export function ModerationPage({ minPhotos }: { minPhotos: number }) {
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
