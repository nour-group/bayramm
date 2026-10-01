import type { DayPart, ListingDetail, PublicService } from "@bayramm/shared/api";
import { type CategoryConfig, categoryConfig, hasDayParts } from "@bayramm/shared/categories";
import { type UIEvent, useMemo, useRef, useState } from "react";
import { isNotFound } from "../api/errors";
import { categoryName, clientCategory, DAY_PART_ORDER, hasCalendar } from "../categories";
import { Calendar } from "../components/Calendar";
import { FavoriteButton } from "../components/FavoriteButton";
import { Link } from "../components/Link";
import { dayLoadChip } from "../components/ListingCard";
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
  formatQty,
  isIsoDate,
  tashkentToday,
  telHref,
} from "../format";
import { useAsync, useDocumentTitle } from "../hooks";
import { Icon } from "../icons";
import { hrefFor, useNav } from "../router";
import { useMainButton } from "../telegram";
import { DATE_HORIZON_DAYS, parseGuests } from "./catalog-feed";
import { draftServiceIds, loadDraft, toggleDraftService } from "./request-draft";
import { suggestedQty } from "./request-estimate";
import { attributeView, dayPartWindow, listingLeadDays, safeVideoLinks } from "./venue-attributes";

/** Ширина главного фото: на компьютере — левая колонка рядом с карточкой связи (styles.css, .venue) */
const GALLERY_SIZES = "(min-width: 1280px) 830px, (min-width: 1024px) 60vw, (min-width: 768px) 720px, 100vw";

/** Сколько ближайших частично занятых дней перечислить под календарём */
const PARTIAL_LIST = 6;

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

/** Услуга витрины: цена с единицей, минимум, срок, что входит, опции и «в заявку» */
function ServiceItem({
  service,
  picked,
  onToggle,
}: {
  service: PublicService;
  picked: boolean;
  onToggle: () => void;
}) {
  const { t, lang } = useLang();
  const includes = service.includes ? pick({ ru: service.includes.ru, uz: service.includes.uz }, lang) : "";
  const name = pick(service.name, lang);
  const min = service.minQty === null ? null : formatQty(service.priceUnit, service.minQty, t);
  const terms = [min ? t.svcMin(min) : null, service.leadDays ? t.svcLead(service.leadDays) : null].filter(
    Boolean,
  );
  return (
    <li className={picked ? "svc picked" : "svc"}>
      <div className="svc-head">
        <h3 className="svc-name">{name}</h3>
        <b className="svc-price">{formatPrice(service.priceUzs, service.priceUnit, t)}</b>
      </div>
      {terms.length > 0 ? <p className="muted small">{terms.join(" · ")}</p> : null}
      {includes ? (
        <p className="svc-includes">
          <span className="muted">{t.svcIncludes}: </span>
          {includes}
        </p>
      ) : null}
      {service.options.length > 0 ? (
        <div className="svc-options">
          <p className="muted small">{t.svcOptions}</p>
          <ul>
            {service.options.map((option) => (
              <li key={option.id}>
                <span>+ {pick(option.name, lang)}</span>
                <span className="muted">{formatPrice(option.priceUzs, option.priceUnit, t)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <button
        type="button"
        className={picked ? "btn btn-secondary svc-pick on" : "btn btn-secondary svc-pick"}
        aria-pressed={picked}
        aria-label={`${t.svcPick}: ${name}`}
        onClick={onToggle}
      >
        <Icon name={picked ? "check" : "plus"} size={14} />
        {picked ? t.svcPicked : t.svcPick}
      </button>
    </li>
  );
}

/** Занятость по модели категории: календарь дня, части дня, слот или срок заказа */
function Availability({
  listing,
  category,
  filterDate,
  today,
}: {
  listing: ListingDetail;
  category: CategoryConfig;
  filterDate: string | null;
  today: string;
}) {
  const { t } = useLang();
  const busy = useMemo(() => new Set(listing.busyDates), [listing.busyDates]);
  const partName = (part: DayPart) => t.dayPartName(part);
  const partial = useMemo(
    () =>
      new Map(
        listing.busyParts
          .filter((p) => p.parts.length > 0 && !busy.has(p.date))
          .map((p) => [p.date, p.parts.map((part) => t.dayPartName(part)).join(", ")]),
      ),
    [listing.busyParts, busy, t],
  );

  if (!hasCalendar(category)) {
    const lead = listingLeadDays(listing);
    return (
      <section className="section" aria-labelledby="venue-lead">
        <h2 className="section-title" id="venue-lead">
          {t.leadTitle}
        </h2>
        <p className="lead-note">
          <Icon name="clockD" size={20} />
          <span>{lead ? t.leadNote(lead) : t.leadNoteAny}</span>
        </p>
        <p className="note">
          <Icon name="info" size={14} />
          <span>{t.leadNoteSvc}</span>
        </p>
      </section>
    );
  }

  const parts = hasDayParts(category);
  const onDate = filterDate ? (listing.busyParts.find((p) => p.date === filterDate)?.parts ?? []) : [];
  const upcoming = [...partial.entries()].filter(([date]) => date >= today).slice(0, PARTIAL_LIST);

  return (
    <section className="section" aria-labelledby="venue-calendar">
      <h2 className="section-title" id="venue-calendar">
        {t.pfCal}
      </h2>
      <Calendar
        label={t.pfCal}
        min={today}
        max={addDays(today, DATE_HORIZON_DAYS)}
        busy={busy}
        partial={parts ? partial : undefined}
        selected={filterDate}
      />
      {parts && filterDate && !busy.has(filterDate) ? (
        <div className="parts-day">
          <h3 className="sub-title">{t.partsOn(formatDayMonth(filterDate, t))}</h3>
          <ul className="parts">
            {DAY_PART_ORDER.map((part) => {
              const taken = onDate.includes(part);
              return (
                <li key={part} className={taken ? "part busy" : "part"}>
                  <span>
                    {partName(part)} <span className="muted">{dayPartWindow(category, part)}</span>
                  </span>
                  <b className="part-state">{taken ? t.legBusy : t.legFree}</b>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {parts && upcoming.length > 0 ? (
        <div className="parts-upcoming">
          <h3 className="sub-title">{t.partsUpcoming}</h3>
          <ul>
            {upcoming.map(([date, taken]) => (
              <li key={date}>
                {formatDayMonth(date, t)}: {t.partsTaken(taken)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="note">
        <Icon name="info" size={14} />
        <span>
          {parts ? `${t.partsNote} ` : ""}
          {category.availability === "slot" ? `${t.slotNote} ` : ""}
          {t.pfCalNote}
        </span>
      </p>
    </section>
  );
}

function VenueView({ listing, requestHref }: { listing: ListingDetail; requestHref: string }) {
  const { webApp, now } = useServices();
  const { t, lang } = useLang();
  const { districtName } = useDictionaries();
  const { query, navigate } = useNav();
  const today = tashkentToday(now());
  const category = categoryConfig(listing.categoryCode) ?? clientCategory(listing.categoryCode);
  const date = query.get("date");
  const filterDate = isIsoDate(date) && date >= today ? date : null;
  const [picked, setPicked] = useState<readonly string[]>(() => draftServiceIds(listing.slug));
  const price = formatPriceFrom(listing.priceFromUzs, listing.priceUnit, t);
  const phone = formatPhone(listing.phone);
  const district = districtName(listing.districtCode);
  const capacity =
    listing.capMax === null
      ? null
      : listing.capMin !== null && listing.capMin > 0
        ? t.capRange(listing.capMin, listing.capMax)
        : t.people(listing.capMax);
  const address = pick(listing.address, lang);
  const description = pick(listing.description, lang);
  const view = attributeView(category, listing.attributes, lang);
  const videos = safeVideoLinks(listing.videoLinks);
  const load = (() => {
    if (!filterDate || !hasCalendar(category)) return null;
    if (listing.busyDates.includes(filterDate)) return "busy" as const;
    const parts = listing.busyParts.find((p) => p.date === filterDate)?.parts ?? [];
    return parts.length >= 3
      ? ("busy" as const)
      : parts.length > 0
        ? ("partial" as const)
        : ("free" as const);
  })();
  const chip = filterDate && load ? dayLoadChip(load, filterDate, t) : null;

  const toggle = (service: PublicService) =>
    setPicked(
      toggleDraftService(listing.slug, service, suggestedQty(service, loadDraft(listing.slug)?.values ?? {})),
    );

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
          <span>
            {[categoryName(listing.categoryCode, lang), district, capacity].filter(Boolean).join(" · ")}
          </span>
        </p>
        {chip ? <p className={chip.tone}>{chip.text}</p> : null}
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

      {listing.services.length > 0 ? (
        <section className="section" aria-labelledby="venue-services">
          <h2 className="section-title" id="venue-services">
            {t.svcTitle}
          </h2>
          <ul className="svcs">
            {listing.services.map((service) => (
              <ServiceItem
                key={service.id}
                service={service}
                picked={picked.includes(service.id)}
                onToggle={() => toggle(service)}
              />
            ))}
          </ul>
          <p className="note">
            <Icon name="info" size={14} />
            <span>{t.svcNote}</span>
          </p>
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
          {capacity === null ? null : (
            <div>
              <dt>{t.capacity}</dt>
              <dd>{capacity}</dd>
            </div>
          )}
          {view.facts.map((fact) => (
            <div key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
        {view.features.length > 0 ? (
          <ul className="features" aria-label={t.featuresLabel}>
            {view.features.map((feature) => (
              <li key={feature}>
                <Icon name="checkFill" size={14} />
                {feature}
              </li>
            ))}
          </ul>
        ) : null}
        {view.lists.map((list) => (
          <div key={list.label} className="attr-list">
            <h3 className="sub-title">{list.label}</h3>
            <ul>
              {list.items.map((item, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: записи списка без id, порядок — как у вендора
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      {videos.length > 0 ? (
        <section className="section" aria-labelledby="venue-video">
          <h2 className="section-title" id="venue-video">
            {t.videoTitle}
          </h2>
          {/* Только ссылки наружу — без встраивания чужих плееров (CSP, трекеры) */}
          <ul className="videos">
            {videos.map((video, i) => (
              <li key={video.href}>
                <a
                  href={video.href}
                  target="_blank"
                  rel="noopener noreferrer external"
                  className="video-link"
                >
                  <Icon name="video" size={20} />
                  <span>
                    {t.videoN(i + 1)} · {video.host}
                    <span className="sr-only"> {t.newTab}</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Availability listing={listing} category={category} filterDate={filterDate} today={today} />

      {/* Цена, телефон и заявка: на телефоне — панель внизу экрана, на компьютере — карточка
          справа, прилипает при прокрутке. Номер в ней виден сразу — правило продукта */}
      <div className="venue-side">
        <div className="action-bar venue-bar">
          <div className="bar-price">
            <b>{price.amount}</b>
            <span className={price.unit ? "unit" : "unit unit-phone"}>{price.unit ?? phone}</span>
            {picked.length > 0 ? <span className="bar-chosen">{t.svcChosenN(picked.length)}</span> : null}
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
