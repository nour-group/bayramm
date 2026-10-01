/* Площадка — карточка выбранной витрины как есть в базе (то, что видит клиент). Название,
   описания, поля витрины категории и ссылки на видео владелец кабинета меняет предложением
   (Proposal.tsx), фото — загрузкой здесь: и то, и другое проверяет команда, до одобрения
   клиенты видят прежнюю карточку. Цена «от» — из услуг (раздел «Услуги»), здесь — сводка
   услуг на витрине. Адрес и вместимость меняет менеджер — для разговора с ним здесь код
   вендора. Сотрудник площадки (роль member) карточку только смотрит: заявки и календарь —
   его, карточка — владельца. Рейтинга нет: его на первом запуске не показываем.

   Готовность к публикации: чего не хватает (blockers из базы) и какие обязательные поля
   витрины пусты (missingAttributes).

   Фото — по правилу категории (photoPolicy). no_people: на фото не должно быть лиц —
   предупреждение всегда на виду, без галочки «лиц нет» (не отмеченной заранее) файлы не
   выбрать (X-No-Faces). portfolio (фото и видео, студия): люди на снимках бывают — вторая
   галочка «люди согласны на публикацию» (X-Photo-Consent) вместо «лиц нет»; нужна хоть одна.
   Каждый файл перекодирует браузер (compressForUpload: без EXIF и геопозиции) и отправляет
   по одному; новое фото ждёт модератора. Удаление — через подтверждение. Порядок и обложку
   выбирает команда.

   На компьютере — две колонки: фото слева, сведения карточки справа; правки — ниже во всю
   ширину, поля формы парами (RU рядом с UZ). */

import { isImageError } from "@bayramm/media";
import { compressForUpload } from "@bayramm/media/browser";
import type { VendorListing, VendorListingRef, VendorPhoto, VendorRole } from "@bayramm/shared/api/vendor";
import {
  attributeLabel,
  type CategoryConfig,
  categoryConfig,
  priceUnitLabel,
  serviceTypeLabel,
} from "@bayramm/shared/categories";
import { Checkbox, ConfirmSheet, FileDrop } from "@bayramm/ui/react";
import { type MouseEvent, useRef, useState } from "react";
import { AttributeFacts } from "./Attributes";
import { ApiFailure, api } from "./api";
import { categoryName, priceText } from "./category";
import { formatMoney, formatPhone } from "./format";
import { fill, textOf, type VendorDict } from "./i18n";
import { Icon } from "./icons";
import { ListingPicker } from "./ListingPicker";
import { Proposal } from "./Proposal";
import { type Navigate, pathOf } from "./router";
import { Empty, Heading, LoadError, Loading, type ScreenProps } from "./ui";
import { useLoad } from "./useLoad";

/** Что можно выбрать: HEIC с iPhone браузер перекодирует сам, где умеет */
const PHOTO_ACCEPT = "image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif";

/** Почему файл не загрузился: код проверки файла (в браузере или на сервере) или ответ API */
export function uploadErrorText(err: unknown, t: VendorDict): string {
  const known = (key: string) => {
    const text = textOf(t, key);
    return text === key ? t.up_failed : text;
  };
  if (isImageError(err)) return known(`img_${err.code}`);
  if (err instanceof ApiFailure) {
    if (err.code === "invalid_image") return known(`img_${err.details[0] ?? ""}`);
    return known(`up_${err.code}`);
  }
  return t.up_failed;
}

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

interface PhotosProps {
  readonly listing: VendorListing;
  /** Правило фото категории: portfolio — люди на фото с их согласия */
  readonly portfolio: boolean;
  readonly t: VendorDict;
  /** Владелец кабинета: загружает и удаляет; сотрудник площадки только смотрит */
  readonly owner: boolean;
  /** После загрузки и удаления — перечитать карточку: меняются фото и блокеры */
  readonly onChanged: () => Promise<void>;
}

interface Problem {
  readonly key: string;
  readonly text: string;
}

function Photos({ listing, portfolio, t, owner, onChanged }: PhotosProps) {
  const { photos, photoLimits } = listing;
  const [ack, setAck] = useState(false);
  const [consent, setConsent] = useState(false);
  const acknowledged = ack || (portfolio && consent);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [problems, setProblems] = useState<readonly Problem[]>([]);
  const [removing, setRemoving] = useState<VendorPhoto | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const title = useRef<HTMLHeadingElement>(null);
  // Куда вернуть фокус после подтверждения: на кнопку, а если фото удалено — на заголовок
  const focusBack = useRef<HTMLElement | null>(null);
  const room = Math.max(0, photoLimits.max - photos.length);
  const uploading = progress !== null;

  const upload = async (picked: readonly File[]) => {
    const files = picked.slice(0, room);
    if (files.length === 0) return;
    setProblems([]);
    const found: Problem[] = [];
    for (const [index, file] of files.entries()) {
      setProgress({ done: index, total: files.length });
      try {
        // Перекодирование всегда: EXIF и геопозиция не уходят дальше телефона
        const photo = await compressForUpload(file);
        await api.uploadPhoto(listing.id, photo.blob, { noFaces: ack, consent: portfolio && consent });
      } catch (err) {
        found.push({
          key: `${index}:${file.name}`,
          text: fill(t.photoFailed, { name: file.name, why: uploadErrorText(err, t) }),
        });
      }
    }
    if (picked.length > files.length) {
      found.push({
        key: "skipped",
        text: fill(t.photosSkipped, { n: picked.length - files.length, max: photoLimits.max }),
      });
    }
    await onChanged();
    setProgress(null);
    setProblems(found);
    // Подтверждение — про выбранные фото: следующие — снова с галочкой
    setAck(false);
    setConsent(false);
  };

  const remove = async () => {
    if (!removing) return;
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await api.deletePhoto(listing.id, removing.id);
    } catch (err) {
      // Фото уже нет (удалили с другого устройства) — как удалено
      if (!(err instanceof ApiFailure && err.code === "not_found")) {
        setRemoveError(
          err instanceof ApiFailure && err.code === "publish_blocked"
            ? fill(t.photoDeleteBlocked, { min: photoLimits.min })
            : t.actionFailed,
        );
        setRemoveBusy(false);
        return;
      }
    }
    await onChanged();
    // Кнопки удалённого фото больше нет — фокус на заголовок раздела
    focusBack.current = title.current;
    setRemoveBusy(false);
    setRemoving(null);
  };

  return (
    <section className="panel" aria-labelledby="photos-title">
      <h2 className="section-title" id="photos-title" ref={title} tabIndex={-1}>
        {t.photos}
      </h2>
      <p className="note">{fill(t.photosLimits, { min: photoLimits.min, max: photoLimits.max })}</p>
      {photos.length === 0 ? (
        <p className="note">{t.noPhotos}</p>
      ) : (
        <ul className="photos">
          {photos.map((photo, index) => (
            <li key={photo.id}>
              <img
                src={photo.src}
                srcSet={photo.srcSet}
                sizes="(min-width: 1024px) 220px, (min-width: 720px) 30vw, 50vw"
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
              {owner ? (
                <button
                  type="button"
                  className="btn btn-danger photo-delete"
                  aria-label={fill(t.photoDeleteLabel, { n: index + 1 })}
                  disabled={uploading}
                  onClick={(event) => {
                    focusBack.current = event.currentTarget;
                    setRemoveError(null);
                    setRemoving(photo);
                  }}
                >
                  {t.photoDelete}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {owner ? (
        <>
          <p className="notice notice-warn">{portfolio ? t.portfolioWarning : t.noFacesWarning}</p>
          <p className="note">{t.photosModeration}</p>
          {room > 0 ? (
            <div className="upload">
              {portfolio ? (
                <Checkbox checked={consent} onChange={setConsent} disabled={uploading}>
                  {t.consentAck}
                </Checkbox>
              ) : null}
              <Checkbox checked={ack} onChange={setAck} disabled={uploading}>
                {t.noFacesAck}
              </Checkbox>
              <FileDrop
                title={t.addPhotos}
                hint={t.photosDrop}
                accept={PHOTO_ACCEPT}
                multiple={room > 1}
                disabled={!acknowledged || uploading}
                onFiles={(files) => void upload(files)}
              />
            </div>
          ) : (
            <p className="note">{fill(t.photosFull, { max: photoLimits.max })}</p>
          )}
          {progress ? (
            <p className="status-line" role="status">
              {fill(t.uploading, { n: progress.done + 1, total: progress.total })}
            </p>
          ) : null}
          {problems.length > 0 ? (
            <div className="notice notice-error photo-problems" role="alert">
              <ul>
                {problems.map((problem) => (
                  <li key={problem.key}>{problem.text}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <ConfirmSheet
            open={removing !== null}
            title={t.photoDeleteQ}
            text={t.photoDeleteText}
            confirmLabel={t.photoDelete}
            cancelLabel={t.cancel}
            tone="danger"
            busy={removeBusy}
            error={removeError ?? undefined}
            onConfirm={() => void remove()}
            onCancel={() => setRemoving(null)}
            returnFocus={focusBack}
          />
        </>
      ) : null}
    </section>
  );
}

/** Чего не хватает для публикации: код базы словами; обязательные услуги — названиями */
function blockerText(code: string, category: CategoryConfig | undefined, t: VendorDict, lang: "ru" | "uz") {
  if (code === "packages" && category && category.requiredServices.length > 0) {
    const list = category.requiredServices.map((type) => serviceTypeLabel(lang, category, type)).join(", ");
    return fill(t.blockerServices, { list });
  }
  return textOf(t, `blocker_${code}`);
}

/** Ссылка на раздел без перезагрузки (новая вкладка, окно — как решит браузер) */
function SectionLink({
  navigate,
  className,
  children,
}: {
  navigate: Navigate;
  className: string;
  children: string;
}) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate({ route: "services" });
  };
  return (
    <a className={className} href={pathOf({ route: "services" })} onClick={onClick}>
      {children}
    </a>
  );
}

interface VenueProps extends ScreenProps {
  readonly listings: readonly VendorListingRef[];
  readonly listingId: string | null;
  readonly onListing: (id: string) => void;
  readonly vendorCode: string;
  /** Роль в кабинете: карточку (фото и предложения) меняет только владелец */
  readonly role: VendorRole;
  /** Выбор витрины — в боковой панели (компьютер) */
  readonly inSidebar?: boolean;
  readonly navigate: Navigate;
}

export function Venue({
  t,
  lang,
  headingRef,
  listings,
  listingId,
  onListing,
  vendorCode,
  role,
  inSidebar = false,
  navigate,
}: VenueProps) {
  const [listing, reload, , refresh] = useLoad<VendorListing>(listingId, (id) => api.listing(id));
  const owner = role === "owner";
  // Тихо, чтобы список ошибок загрузки и фокус остались; не вышло — обычная загрузка с повтором
  const refreshListing = async () => {
    if (!(await refresh())) reload();
  };

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
      <ListingPicker
        listings={listings}
        value={listingId}
        onChange={onListing}
        t={t}
        lang={lang}
        inSidebar={inSidebar}
        line={false}
      />
      <p className="promise">
        <Icon name="info" size={17} />
        <span>
          {owner ? t.venueNote : t.venueNoteMember} {fill(t.vendorCode, { code: vendorCode })}
        </span>
      </p>

      {listing.state === "loading" ? <Loading t={t} /> : null}
      {listing.state === "error" ? <LoadError t={t} onRetry={reload} /> : null}
      {listing.state === "ready" ? (
        <VenueCard
          listing={listing.data}
          t={t}
          lang={lang}
          owner={owner}
          navigate={navigate}
          onChanged={refreshListing}
        />
      ) : null}
    </section>
  );
}

interface VenueCardProps {
  readonly listing: VendorListing;
  readonly t: VendorDict;
  readonly lang: "ru" | "uz";
  readonly owner: boolean;
  readonly navigate: Navigate;
  readonly onChanged: () => Promise<void>;
}

function VenueCard({ listing, t, lang, owner, navigate, onChanged }: VenueCardProps) {
  const category = categoryConfig(listing.categoryCode);
  const fields = category?.listingFields ?? ["guest_capacity", "district"];
  const active = listing.services.filter((service) => service.status === "active");
  return (
    <article className="venue">
      <div className="detail-top">
        <h2 className="venue-name">{listing.name}</h2>
        <span className="venue-chips">
          <span className="chip chip-cat">{categoryName(lang, listing.categoryCode)}</span>
          <span className={`chip chip-${listing.status === "active" ? "done" : "wait"}`}>
            {textOf(t, `ls_${listing.status}`)}
          </span>
        </span>
      </div>
      {listing.statusReason ? (
        <p className="note">{fill(t.reasonLine, { reason: listing.statusReason })}</p>
      ) : null}
      {listing.status !== "active" && listing.blockers.length > 0 ? (
        <div className="notice">
          <p className="panel-title">{t.blockersTitle}</p>
          <ul className="blockers">
            {listing.blockers.map((code) => (
              <li key={code}>{blockerText(code, category, t, lang)}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {/* Обязательные поля витрины без значения — их заполняет предложение изменений ниже */}
      {listing.missingAttributes.length > 0 && category ? (
        <div className="notice notice-warn readiness">
          <p className="panel-title">{t.missingTitle}</p>
          <ul className="blockers">
            {listing.missingAttributes.map((key) => (
              <li key={key}>{attributeLabel(lang, category, key)}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="venue-grid">
        {/* Ключ — площадка: галочка и ошибки загрузки другой площадки не переносятся.
          Не тот же, что у Proposal: ключи соседей в одном родителе обязаны различаться */}
        <Photos
          key={`photos-${listing.id}`}
          listing={listing}
          portfolio={category?.photoPolicy === "portfolio"}
          t={t}
          owner={owner}
          onChanged={onChanged}
        />

        <div className="venue-side">
          {/* Цена и телефон — во всю ширину: «от 25 млн сум за мероприятие» и номер в
            половине строки телефона переносились посреди числа */}
          <dl className="facts">
            <div className="facts-wide">
              <dt>{t.priceLabel}</dt>
              <dd>
                {listing.priceFromUzs !== null
                  ? `${fill(t.priceFrom, { price: formatMoney(listing.priceFromUzs, t, lang) })} ${priceUnitLabel(
                      lang,
                      listing.priceUnit,
                    )}`
                  : t.notSet}
                <span className="fact-sub fact-note">{t.priceFromServices}</span>
              </dd>
            </div>
            {fields.includes("guest_capacity") ? (
              <div>
                <dt>{t.capacity}</dt>
                <dd>
                  <Capacity listing={listing} t={t} />
                </dd>
              </div>
            ) : null}
            {fields.includes("district") || listing.districtCode ? (
              <div>
                <dt>{t.district}</dt>
                <dd>{listing.districtCode ? textOf(t, `dist_${listing.districtCode}`) : t.notSet}</dd>
              </div>
            ) : null}
            <div className="facts-wide">
              <dt>{t.phoneLabel}</dt>
              <dd className="fact-phone">{listing.phone ? formatPhone(listing.phone) : t.notSet}</dd>
            </div>
            <div className="facts-wide">
              <dt>{t.address}</dt>
              <dd>{listing.address[lang] || t.notSet}</dd>
            </div>
          </dl>

          <section className="panel" aria-labelledby="venue-services-title">
            <h3 className="panel-title" id="venue-services-title">
              {t.servicesSummary}
            </h3>
            {active.length === 0 ? (
              <p className="note">{t.noActiveServices}</p>
            ) : (
              <ul className="packages">
                {active.map((service) => (
                  <li key={service.id}>
                    <span>{service.name[lang] || service.name.ru}</span>
                    <strong className="package-price">
                      {priceText(service.priceUzs, service.priceUnit, t, lang)}
                    </strong>
                  </li>
                ))}
              </ul>
            )}
            <SectionLink navigate={navigate} className="btn btn-ghost venue-services-link">
              {t.toServices}
            </SectionLink>
          </section>

          {category && category.attributes.length > 0 ? (
            <section className="panel" aria-labelledby="venue-attrs-title">
              <h3 className="panel-title" id="venue-attrs-title">
                {t.attributesTitle}
              </h3>
              {Object.keys(listing.attributes).length === 0 ? (
                <p className="note">{t.notSet}</p>
              ) : (
                <AttributeFacts category={category} attributes={listing.attributes} t={t} lang={lang} />
              )}
            </section>
          ) : null}

          {listing.videoLinks.length > 0 ? (
            <section className="panel" aria-labelledby="venue-video-title">
              <h3 className="panel-title" id="venue-video-title">
                {t.videoTitle}
              </h3>
              <ul className="video-list">
                {listing.videoLinks.map((link) => (
                  <li key={link}>{link}</li>
                ))}
              </ul>
            </section>
          ) : null}

          <div className="panel">
            <p className="panel-title">{t.description}</p>
            <p className="description">{listing.description[lang] || t.notSet}</p>
          </div>
        </div>
      </div>

      {/* Ключ — площадка: при смене площадки форма и предложения — заново */}
      <Proposal key={listing.id} listing={listing} t={t} lang={lang} owner={owner} />
    </article>
  );
}
