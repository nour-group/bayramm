/* Площадка — карточка как есть в базе (то, что видит клиент). Название, цену, описания и
   пакеты партнёр меняет предложением (Proposal.tsx): его проверяет команда, до одобрения
   клиенты видят прежнюю карточку. Фото, адрес и вместимость меняет менеджер — для
   разговора с ним здесь код вендора. Рейтинга нет: его на первом запуске не показываем. */

import type { VendorListing, VendorListingRef } from "@bayramm/shared/api/vendor";
import { api } from "./api";
import { formatMoney, formatPhone } from "./format";
import { fill, textOf, type VendorDict } from "./i18n";
import { Icon } from "./icons";
import { ListingPicker } from "./ListingPicker";
import { Proposal } from "./Proposal";
import { Empty, Heading, LoadError, Loading, type ScreenProps } from "./ui";
import { useLoad } from "./useLoad";

function Capacity({ listing, t }: { listing: VendorListing; t: VendorDict }) {
  if (listing.capMax === null) return <>{t.notSet}</>;
  return (
    <>
      {listing.capMin !== null
        ? fill(t.capRange, { min: listing.capMin, max: listing.capMax })
        : fill(t.capUpTo, { max: listing.capMax })}
    </>
  );
}

function Photos({ listing, t }: { listing: VendorListing; t: VendorDict }) {
  if (listing.photos.length === 0) return <p className="note">{t.noPhotos}</p>;
  return (
    <ul className="photos">
      {listing.photos.map((photo, index) => (
        <li key={photo.id}>
          <img
            src={photo.src}
            srcSet={photo.srcSet}
            sizes="(min-width: 720px) 300px, 50vw"
            width={photo.width}
            height={photo.height}
            alt={`${listing.name} — ${t.photos} ${index + 1}`}
            loading={index < 2 ? "eager" : "lazy"}
            decoding="async"
          />
          {photo.moderation !== "approved" ? (
            <span className={`chip photo-chip chip-${photo.moderation === "declined" ? "off" : "wait"}`}>
              {photo.moderation === "declined" ? t.photoDeclined : t.photoPending}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

interface VenueProps extends ScreenProps {
  readonly listings: readonly VendorListingRef[];
  readonly listingId: string | null;
  readonly onListing: (id: string) => void;
  readonly vendorCode: string;
}

export function Venue({ t, lang, headingRef, listings, listingId, onListing, vendorCode }: VenueProps) {
  const [listing, reload] = useLoad<VendorListing>(listingId, (id) => api.listing(id));

  if (listings.length === 0 || !listingId) {
    return (
      <section className="page" aria-labelledby="page-title">
        <Heading headingRef={headingRef}>{t.card}</Heading>
        <Empty icon="hall" title={t.noListings} text={t.noListingsText} />
        <p className="note">{fill(t.vendorCode, { code: vendorCode })}</p>
      </section>
    );
  }

  return (
    <section className="page" aria-labelledby="page-title">
      <Heading headingRef={headingRef}>{t.card}</Heading>
      <ListingPicker listings={listings} value={listingId} onChange={onListing} t={t} />
      <p className="promise">
        <Icon name="info" size={17} />
        <span>
          {t.venueNote} {fill(t.vendorCode, { code: vendorCode })}
        </span>
      </p>

      {listing.state === "loading" ? <Loading t={t} /> : null}
      {listing.state === "error" ? <LoadError t={t} onRetry={reload} /> : null}
      {listing.state === "ready" ? (
        <article className="venue">
          <div className="detail-top">
            <h2 className="venue-name">{listing.data.name}</h2>
            <span className={`chip chip-${listing.data.status === "active" ? "done" : "wait"}`}>
              {textOf(t, `ls_${listing.data.status}`)}
            </span>
          </div>
          {listing.data.statusReason ? (
            <p className="note">{fill(t.reasonLine, { reason: listing.data.statusReason })}</p>
          ) : null}
          {listing.data.status !== "active" && listing.data.blockers.length > 0 ? (
            <div className="notice">
              <p className="panel-title">{t.blockersTitle}</p>
              <ul className="blockers">
                {listing.data.blockers.map((code) => (
                  <li key={code}>{textOf(t, `blocker_${code}`)}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <Photos listing={listing.data} t={t} />

          <dl className="facts">
            <div>
              <dt>{t.priceLabel}</dt>
              <dd>
                {listing.data.priceFromUzs !== null
                  ? `${fill(t.priceFrom, { price: formatMoney(listing.data.priceFromUzs, t, lang) })} ${
                      listing.data.priceUnit === "per_guest" ? t.perGuest : t.perEvent
                    }`
                  : t.notSet}
              </dd>
            </div>
            <div>
              <dt>{t.capacity}</dt>
              <dd>
                <Capacity listing={listing.data} t={t} />
              </dd>
            </div>
            <div>
              <dt>{t.district}</dt>
              <dd>{listing.data.districtCode ? textOf(t, `dist_${listing.data.districtCode}`) : t.notSet}</dd>
            </div>
            <div>
              <dt>{t.phoneLabel}</dt>
              <dd>{listing.data.phone ? formatPhone(listing.data.phone) : t.notSet}</dd>
            </div>
            <div className="facts-wide">
              <dt>{t.address}</dt>
              <dd>{listing.data.address[lang] || t.notSet}</dd>
            </div>
          </dl>

          {listing.data.packages.length > 0 ? (
            <div className="panel">
              <p className="panel-title">{t.packages}</p>
              <ul className="packages">
                {listing.data.packages.map((pack) => (
                  <li key={`${pack.kind}-${pack.name.ru}`}>
                    <span>{pack.name[lang]}</span>
                    <strong className="package-price">
                      {formatMoney(pack.priceUzs, t, lang)}{" "}
                      {pack.priceUnit === "per_guest" ? t.perGuest : t.perEvent}
                    </strong>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="panel">
            <p className="panel-title">{t.description}</p>
            <p className="description">{listing.data.description[lang] || t.notSet}</p>
          </div>

          {/* Ключ — площадка: при смене площадки форма и предложения — заново */}
          <Proposal key={listing.data.id} listing={listing.data} t={t} lang={lang} />
        </article>
      ) : null}
    </section>
  );
}
