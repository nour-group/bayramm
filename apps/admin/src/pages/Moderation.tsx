/* Модерация: карточки на проверке — по порядку отправки. Решение — на странице карточки. */

import type { ListingList } from "@bayramm/shared/api/staff";
import { useLoad } from "../api";
import { formatMoment, formatPrice } from "../format";
import { t } from "../texts";
import { Blockers, Link, LoadedView, publishBlockers } from "../ui";

export function ModerationPage({ minPhotos }: { minPhotos: number }) {
  const { loaded, reload } = useLoad<ListingList>("/staff/listings?status=review&limit=100");
  return (
    <LoadedView loaded={loaded} onRetry={reload}>
      {(list) =>
        list.items.length === 0 ? (
          <p className="empty">{t.moderationEmpty}</p>
        ) : (
          <ul className="cards">
            {list.items.map((listing) => (
              <li key={listing.id} className="panel card-row">
                <div>
                  <Link to={{ name: "listing", id: listing.id }} className="row-link">
                    {listing.name}
                  </Link>
                  <span className="sub">
                    {listing.vendor.name ?? listing.vendor.code} · {listing.vendor.code} · {t.submittedAt}{" "}
                    {formatMoment(listing.submittedAt)}
                  </span>
                  <span className="sub">
                    {formatPrice(listing.priceFromUzs, listing.priceUnit)}
                    {listing.capMax ? ` · до ${listing.capMax}` : ""} ·{" "}
                    {t.photosCount(listing.photos.ready, listing.photos.approved)}
                  </span>
                </div>
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
