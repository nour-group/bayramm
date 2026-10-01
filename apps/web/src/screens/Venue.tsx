import type { ListingDetail } from "@bayramm/shared/api";
import { type UIEvent, useMemo, useRef, useState } from "react";
import { isNotFound } from "../api/errors";
import { Calendar } from "../components/Calendar";
import { FavoriteButton } from "../components/FavoriteButton";
import { Link } from "../components/Link";
import { NewBadge } from "../components/NewBadge";
import { Photo } from "../components/Photo";
import { Paragraphs } from "../components/RichText";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { pick, useDictionaries, useLang, useServices } from "../context";
import {
  addDays,
  formatDayMonth,
  formatPhone,
  formatPrice,
  formatPriceFrom,
  isIsoDate,
  tashkentToday,
  telHref,
} from "../format";
import { useAsync, useDocumentTitle } from "../hooks";
import { Icon } from "../icons";
import { hrefFor, useNav } from "../router";
import { useMainButton } from "../telegram";
import { DATE_HORIZON_DAYS, parseGuests } from "./catalog-feed";

/** Ширина главного фото: на компьютере — левая колонка рядом с карточкой связи (styles.css, .venue) */
const GALLERY_SIZES = "(min-width: 1280px) 830px, (min-width: 1024px) 60vw, (min-width: 768px) 720px, 100vw";

function Gallery({ listing }: { listing: ListingDetail }) {
  const { t } = useLang();
  const photos = listing.photos.length > 0 ? listing.photos : [listing.cover];
  const [index, setIndex] = useState(0);
  const track = useRef<HTMLUListElement>(null);
  const total = photos.length;

  const onScroll = (event: UIEvent<HTMLUListElement>) => {
    const list = event.currentTarget;
    if (list.clientWidth > 0) setIndex(Math.round(list.scrollLeft / list.clientWidth));
  };

  // Листать кнопками — мышью на компьютере (вбок колесо не крутит). scrollTo есть не везде
  // (ловушка №5) — тогда сдвигаем scrollLeft напрямую
  const go = (step: number) => {
    const list = track.current;
    if (!list) return;
    const left = Math.max(0, Math.min(total - 1, index + step)) * list.clientWidth;
    if (typeof list.scrollTo === "function") list.scrollTo({ left, behavior: "smooth" });
    else list.scrollLeft = left;
  };

  return (
    <div className="gallery">
      {/* Лента прокручивается вбок — с клавиатуры тоже: в фокусе её листают стрелки (WCAG 2.1.1) */}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: прокручиваемая область обязана принимать фокус */}
      <ul className="gallery-track" aria-label={t.photos} tabIndex={0} onScroll={onScroll} ref={track}>
        {photos.map((photo, i) => (
          <li key={photo?.key ?? i} className="gallery-item">
            <Photo
              photo={photo}
              alt={t.photoOf(listing.name, i + 1, total)}
              sizes={GALLERY_SIZES}
              eager={i === 0}
            />
          </li>
        ))}
      </ul>
      {total > 1 ? (
        <>
          <span className="gallery-count" aria-hidden="true">
            {Math.min(index + 1, total)} / {total}
          </span>
          <button
            type="button"
            className="icon-btn gallery-nav gallery-prev"
            aria-label={t.galleryPrev}
            disabled={index <= 0}
            onClick={() => go(-1)}
          >
            <Icon name="prev" size={17} />
          </button>
          <button
            type="button"
            className="icon-btn gallery-nav gallery-next"
            aria-label={t.galleryNext}
            disabled={index >= total - 1}
            onClick={() => go(1)}
          >
            <Icon name="next" size={17} />
          </button>
        </>
      ) : null}
    </div>
  );
}

function VenueView({ listing, requestHref }: { listing: ListingDetail; requestHref: string }) {
  const { webApp, now } = useServices();
  const { t, lang } = useLang();
  const { districtName } = useDictionaries();
  const { query, navigate } = useNav();
  const today = tashkentToday(now());
  const date = query.get("date");
  const filterDate = isIsoDate(date) && date >= today ? date : null;
  const busy = useMemo(() => new Set(listing.busyDates), [listing.busyDates]);
  const price = formatPriceFrom(listing.priceFromUzs, listing.priceUnit, t);
  const phone = formatPhone(listing.phone);
  const district = districtName(listing.districtCode);
  const capacity =
    listing.capMin !== null && listing.capMin > 0
      ? t.capRange(listing.capMin, listing.capMax)
      : t.people(listing.capMax);
  const address = pick(listing.address, lang);
  const description = pick(listing.description, lang);

  // В Telegram «Оставить заявку» — его главная кнопка внизу; в браузере — своя в панели
  const nativeMain = useMainButton(webApp, {
    text: t.pfReq,
    visible: true,
    onClick: () => navigate(requestHref),
  });

  return (
    <article className="screen venue">
      <Gallery listing={listing} />

      <div className="venue-head">
        <div className="card-top">
          <h1 className="screen-title" tabIndex={-1}>
            {listing.name}
          </h1>
          <NewBadge />
          <FavoriteButton listing={listing} className="fav-btn fav-inline" />
        </div>
        <p className="venue-meta">
          <Icon name="pin" size={14} />
          <span>{[district, capacity].filter(Boolean).join(" · ")}</span>
        </p>
        {filterDate ? (
          <p className={busy.has(filterDate) ? "chip chip-busy" : "chip chip-free"}>
            {busy.has(filterDate)
              ? t.dayBusy(formatDayMonth(filterDate, t))
              : t.dayFree(formatDayMonth(filterDate, t))}
          </p>
        ) : null}
      </div>

      {/* Телефон виден сразу, до заявки — правило продукта */}
      <section className="section contact" aria-labelledby="venue-phone">
        <h2 className="section-title" id="venue-phone">
          {t.rqPhone}
        </h2>
        <div className="contact-row">
          <a className="contact-phone" href={telHref(listing.phone)}>
            {phone}
          </a>
          <a className="btn btn-secondary" href={telHref(listing.phone)}>
            <Icon name="phone" size={17} />
            {t.sentCall}
          </a>
        </div>
        <p className="muted small">{t.callNote}</p>
      </section>

      {listing.packages.length > 0 ? (
        <section className="section" aria-labelledby="venue-packages">
          <h2 className="section-title" id="venue-packages">
            {t.pfPack}
          </h2>
          <ul className="packages">
            {listing.packages.map((item) => (
              <li key={`${item.kind}-${item.name.ru}`}>
                <span>{pick(item.name, lang)}</span>
                <b>{formatPrice(item.priceUzs, item.priceUnit, t)}</b>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="section" aria-labelledby="venue-about">
        <h2 className="section-title" id="venue-about">
          {t.pfAbout}
        </h2>
        {description ? <Paragraphs text={description} className="prose" /> : null}
        <dl className="facts">
          {address ? (
            <div>
              <dt>{t.address}</dt>
              <dd>{address}</dd>
            </div>
          ) : null}
          <div>
            <dt>{t.capacity}</dt>
            <dd>{capacity}</dd>
          </div>
        </dl>
      </section>

      <section className="section" aria-labelledby="venue-calendar">
        <h2 className="section-title" id="venue-calendar">
          {t.pfCal}
        </h2>
        <Calendar
          label={t.pfCal}
          min={today}
          max={addDays(today, DATE_HORIZON_DAYS)}
          busy={busy}
          selected={filterDate}
        />
        <p className="note">
          <Icon name="info" size={14} />
          <span>{t.pfCalNote}</span>
        </p>
      </section>

      {/* Цена, телефон и заявка: на телефоне — панель внизу экрана, на компьютере — карточка
          справа, прилипает при прокрутке. Номер в ней виден сразу — правило продукта */}
      <div className="venue-side">
        <div className="action-bar venue-bar">
          <div className="bar-price">
            <b>{price.amount}</b>
            <span className={price.unit ? "unit" : "unit unit-phone"}>{price.unit ?? phone}</span>
          </div>
          <a className="contact-phone bar-phone" href={telHref(listing.phone)}>
            {phone}
          </a>
          <a className="icon-btn call" href={telHref(listing.phone)} aria-label={`${t.sentCall}: ${phone}`}>
            <Icon name="phone" size={20} />
            <span className="call-label" aria-hidden="true">
              {t.sentCall}
            </span>
          </a>
          {nativeMain ? null : (
            <Link className="btn btn-primary" href={requestHref}>
              {t.pfReq}
            </Link>
          )}
        </div>
        <p className="bar-note">{t.pfBarNote}</p>
      </div>
    </article>
  );
}

export function Venue({ slug }: { slug: string }) {
  const { api } = useServices();
  const { t } = useLang();
  const { query } = useNav();
  const listing = useAsync(`listing:${slug}`, (signal) => api.listing(slug, signal));
  useDocumentTitle(listing.status === "ready" ? listing.data.name : "");

  if (listing.status === "loading") return <Loading />;
  if (listing.status === "error")
    return isNotFound(listing.error) ? (
      <EmptyState
        headingLevel={1}
        title={t.venueGoneH}
        text={t.venueGoneP}
        action={
          <Link className="btn btn-secondary" href={hrefFor({ name: "catalog" })}>
            {t.toCatalog}
          </Link>
        }
      />
    ) : (
      <ErrorState onRetry={listing.reload} />
    );

  const requestHref = hrefFor(
    { name: "request", slug },
    { date: query.get("date"), guests: parseGuests(query.get("guests")) },
  );
  return <VenueView listing={listing.data} requestHref={requestHref} />;
}
