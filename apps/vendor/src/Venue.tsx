/* Площадка — карточка как есть в базе (то, что видит клиент). Название, цену, описания и
   пакеты владелец кабинета меняет предложением (Proposal.tsx), фото — загрузкой здесь: и то,
   и другое проверяет команда, до одобрения клиенты видят прежнюю карточку. Адрес и
   вместимость меняет менеджер — для разговора с ним здесь код вендора. Сотрудник площадки
   (роль member) карточку только смотрит: заявки и календарь — его, карточка — владельца.
   Рейтинга нет: его на первом запуске не показываем.

   Фото: на фото не должно быть лиц — предупреждение всегда на виду, без галочки (не
   отмеченной заранее) файлы не выбрать. Каждый файл перекодирует браузер
   (compressForUpload: без EXIF и геопозиции) и отправляет по одному; новое фото ждёт
   модератора. Удаление — через подтверждение. Порядок и обложку выбирает команда.

   На компьютере — две колонки: фото слева, сведения карточки справа; правки — ниже во всю
   ширину, поля формы парами (RU рядом с UZ). */

import { isImageError } from "@bayramm/media";
import { compressForUpload } from "@bayramm/media/browser";
import type { VendorListing, VendorListingRef, VendorPhoto, VendorRole } from "@bayramm/shared/api/vendor";
import { Checkbox, ConfirmSheet, FileDrop } from "@bayramm/ui/react";
import { useRef, useState } from "react";
import { ApiFailure, api } from "./api";
import { formatMoney, formatPhone } from "./format";
import { fill, textOf, type VendorDict } from "./i18n";
import { Icon } from "./icons";
import { ListingPicker } from "./ListingPicker";
import { Proposal } from "./Proposal";
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

function Photos({ listing, t, owner, onChanged }: PhotosProps) {
  const { photos, photoLimits } = listing;
  const [ack, setAck] = useState(false);
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
        await api.uploadPhoto(listing.id, photo.blob);
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
          <p className="notice notice-warn">{t.noFacesWarning}</p>
          <p className="note">{t.photosModeration}</p>
          {room > 0 ? (
            <div className="upload">
              <Checkbox checked={ack} onChange={setAck} disabled={uploading}>
                {t.noFacesAck}
              </Checkbox>
              <FileDrop
                title={t.addPhotos}
                hint={t.photosDrop}
                accept={PHOTO_ACCEPT}
                multiple={room > 1}
                disabled={!ack || uploading}
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

interface VenueProps extends ScreenProps {
  readonly listings: readonly VendorListingRef[];
  readonly listingId: string | null;
  readonly onListing: (id: string) => void;
  readonly vendorCode: string;
  /** Роль в кабинете: карточку (фото и предложения) меняет только владелец */
  readonly role: VendorRole;
}

export function Venue({ t, lang, headingRef, listings, listingId, onListing, vendorCode, role }: VenueProps) {
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
      <ListingPicker listings={listings} value={listingId} onChange={onListing} t={t} />
      <p className="promise">
        <Icon name="info" size={17} />
        <span>
          {owner ? t.venueNote : t.venueNoteMember} {fill(t.vendorCode, { code: vendorCode })}
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

          <div className="venue-grid">
            {/* Ключ — площадка: галочка и ошибки загрузки другой площадки не переносятся.
              Не тот же, что у Proposal: ключи соседей в одном родителе обязаны различаться */}
            <Photos
              key={`photos-${listing.data.id}`}
              listing={listing.data}
              t={t}
              owner={owner}
              onChanged={refreshListing}
            />

            <div className="venue-side">
              {/* Цена и телефон — во всю ширину: «от 25 млн сум за мероприятие» и номер в
                половине строки телефона переносились посреди числа */}
              <dl className="facts">
                <div className="facts-wide">
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
                  <dd>
                    {listing.data.districtCode ? textOf(t, `dist_${listing.data.districtCode}`) : t.notSet}
                  </dd>
                </div>
                <div className="facts-wide">
                  <dt>{t.phoneLabel}</dt>
                  <dd className="fact-phone">
                    {listing.data.phone ? formatPhone(listing.data.phone) : t.notSet}
                  </dd>
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
            </div>
          </div>

          {/* Ключ — площадка: при смене площадки форма и предложения — заново */}
          <Proposal key={listing.data.id} listing={listing.data} t={t} lang={lang} owner={owner} />
        </article>
      ) : null}
    </section>
  );
}
