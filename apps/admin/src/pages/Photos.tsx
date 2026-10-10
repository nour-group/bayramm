/* Фото карточки: загрузка (сжатие в браузере, без метаданных), порядок, обложка,
   решение модератора (отказ — только с причиной: её видит партнёр, она подписана у отклонённого
   фото), удаление (через подтверждение). Подтверждение — по правилу фото
   категории: «без людей» (площадка, кортеж, цветы, торты, подарки, декор) — на фото нет лиц
   (X-No-Faces); портфолио (фото и видео, студия) — люди на фото согласны на публикацию
   (X-Photo-Consent) или лиц нет. Предупреждение всегда на виду, без подтверждения файлы не
   выбрать; ничего не отмечено заранее. Выбор файлов —
   FileDrop: на телефоне — камера или галерея, на компьютере — ещё и перетаскивание.
   Порядок — кнопками «раньше / позже», не перетаскиванием: так и пальцем, и с клавиатуры.
   На телефоне — две колонки; у фото «раньше», «позже» и «Ещё» (обложка, решение, удаление).
   Стрелки — одни и те же значки на телефоне и компьютере. Выбрали больше, чем помещается до
   предела, — загружаются первые, а строка говорит, сколько из выбранных и почему не все.
   Обложка и одобрение — без перезагрузки экрана: о сделанном — всплывающей строкой. */

import { isImageError } from "@bayramm/media";
import { compressForUpload } from "@bayramm/media/browser";
import type { StaffPhoto } from "@bayramm/shared/api/staff";
import { NO_FACES_HEADER, PHOTO_CONSENT_HEADER } from "@bayramm/shared/api/vendor";
import type { PhotoPolicy } from "@bayramm/shared/categories";
import { Checkbox, ConfirmSheet, FileDrop, RadioGroup, useToast } from "@bayramm/ui/react";
import { useEffect, useRef, useState } from "react";
import { type Failure, type Result, useCan, useSession } from "../api";
import { photoSrc, photoSrcSet } from "../format";
import { Icon } from "../icons";
import { usePhone } from "../layout";
import { apiErrorText, t } from "../texts";
import { ConfirmForm, ErrorText, type MenuAction, OverflowMenu, PhoneSheet, Pill, toneOf } from "../ui";

/** Форматы фото; на телефоне — любое фото: так точно предлагают и камеру, и галерею (HEIC — по расширению) */
const ACCEPT = "image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif";
const ACCEPT_PHONE = "image/*,.heic,.heif";

/** Причина отказа по фото — не длиннее, чем принимает сервер */
const REASON_MAX = 500;

/** Что подтвердил сотрудник о выбранных фото (портфолио) */
type PhotoAck = "consent" | "no_faces";

interface PhotosProps {
  listingId: string;
  /** Правило фото категории витрины */
  photoPolicy: PhotoPolicy;
  photos: readonly StaffPhoto[];
  minPhotos: number;
  maxPhotos: number;
  /** После любого изменения — перечитать карточку: меняются и фото, и блокеры */
  onChanged: () => void;
}

export function Photos({ listingId, photoPolicy, photos, minPhotos, maxPhotos, onChanged }: PhotosProps) {
  const { api } = useSession();
  const can = useCan();
  const portfolio = photoPolicy === "portfolio";
  const [ack, setAck] = useState(false);
  const [portfolioAck, setPortfolioAck] = useState<PhotoAck | null>(null);
  const acknowledged = portfolio ? portfolioAck !== null : ack;
  // Заголовок подтверждения: согласие людей на фото или «лиц нет»
  const ackHeader: Record<string, string> =
    portfolio && portfolioAck === "consent" ? { [PHOTO_CONSENT_HEADER]: "1" } : { [NO_FACES_HEADER]: "1" };
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  // Выбрали больше, чем помещается до предела: сколько загрузили из выбранных
  const [overLimit, setOverLimit] = useState<{ uploaded: number; picked: number } | null>(null);
  const toast = useToast();
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<StaffPhoto | null>(null);
  // Фото, которое отклоняют, и его номер в ряду; форма причины — шторка на телефоне, на месте шире
  const [declining, setDeclining] = useState<{ photo: StaffPhoto; n: number } | null>(null);
  const declineReturn = useRef<HTMLElement | null>(null);
  const declineTitle = useRef<HTMLHeadingElement>(null);
  const phone = usePhone();
  const editable = can("listings.write");
  const moderates = can("photos.moderate");
  const base = `/staff/listings/${listingId}/photos`;
  // Обложка — отмеченное фото, а пока отметки нет — первое
  const hasCover = photos.some((photo) => photo.isCover);
  const isCover = (photo: StaffPhoto, index: number) => photo.isCover || (!hasCover && index === 0);

  const upload = async (picked: readonly File[]) => {
    const files = picked.slice(0, Math.max(0, maxPhotos - photos.length));
    setOverLimit(null);
    if (files.length === 0) return;
    setProblems([]);
    setFailure(null);
    const found: string[] = [];
    for (const [index, file] of files.entries()) {
      setProgress({ done: index, total: files.length });
      try {
        // Перекодирование всегда: так EXIF и геопозиция не уходят дальше браузера
        const photo = await compressForUpload(file);
        const result = await api.upload<StaffPhoto>(base, photo.blob, ackHeader);
        if (!result.ok) {
          const why =
            result.code === "invalid_image"
              ? (t.imageErrors[result.details[0] ?? ""] ?? apiErrorText(result.code))
              : apiErrorText(result.code);
          found.push(t.photoFailed(file.name, why));
        }
      } catch (err) {
        found.push(
          t.photoFailed(
            file.name,
            isImageError(err) ? (t.imageErrors[err.code] ?? err.code) : (t.api.unknown ?? ""),
          ),
        );
      }
    }
    setProgress(null);
    setProblems(found);
    // Лишние не загружались вовсе — сказать, сколько из выбранных и какой предел
    if (picked.length > files.length)
      setOverLimit({ uploaded: files.length - found.length, picked: picked.length });
    onChanged();
  };

  const act = async (run: () => Promise<Result<unknown>>, done?: string) => {
    setBusy(true);
    const result = await run();
    setBusy(false);
    setFailure(result.ok ? null : result);
    if (result.ok && done) toast(done, { tone: "success" });
    onChanged();
  };

  const move = (index: number, delta: number) => {
    const ids = photos.map((p) => p.id);
    const [moved] = ids.splice(index, 1);
    if (moved === undefined) return;
    ids.splice(index + delta, 0, moved);
    void act(() => api.put(`${base}/order`, { ids }));
  };

  const cover = (photo: StaffPhoto, index: number) =>
    void act(() => api.post(`${base}/${photo.id}/cover`), t.toastCover(index + 1));
  const approve = (photo: StaffPhoto, index: number) =>
    void act(
      () => api.post(`${base}/${photo.id}/moderation`, { decision: "approved" }),
      t.toastPhotoApproved(index + 1),
    );
  // Отказ без причины сервер не примет (422): сначала спрашиваем её, а фокус вернётся на ту
  // кнопку, с которой начали («Отклонить» у фото — она у нажатия; «Ещё» — где фокус после меню)
  const startDecline = (photo: StaffPhoto, index: number, opener?: HTMLElement) => {
    const focused = document.activeElement;
    declineReturn.current = opener ?? (focused instanceof HTMLElement ? focused : null);
    setFailure(null);
    setDeclining({ photo, n: index + 1 });
  };
  const decline = async (reason: string): Promise<Failure | null> => {
    if (!declining) return null;
    const result = await api.post(`${base}/${declining.photo.id}/moderation`, {
      decision: "declined",
      reason,
    });
    if (!result.ok) return result;
    // Фото решено — кнопки «Отклонить» у него больше нет: на компьютере фокус — на заголовок блока
    // (на телефоне шторка вернёт его на «Ещё», она остаётся)
    if (!phone) declineReturn.current = null;
    setDeclining(null);
    onChanged();
    return null;
  };
  // На компьютере форма — под рядом фото, далеко от кнопки: фокус — на её заголовок, а когда форма
  // закрылась, — обратно на кнопку «Отклонить» (после решения — на заголовок «Фото»)
  const wasDeclining = useRef(false);
  useEffect(() => {
    if (phone) return;
    if (declining) {
      wasDeclining.current = true;
      declineTitle.current?.focus();
    } else if (wasDeclining.current) {
      wasDeclining.current = false;
      const back = declineReturn.current;
      (back?.isConnected ? back : document.getElementById("photos-title"))?.focus();
    }
  }, [declining, phone]);

  const remove = async () => {
    if (!removing) return;
    const photo = removing;
    setRemoving(null);
    await act(() => api.del(`${base}/${photo.id}`));
  };

  /** Шторка «Ещё» у фото на телефоне: обложка, решение модератора, удаление */
  const menuOf = (photo: StaffPhoto, index: number): MenuAction[] => [
    ...(editable && !isCover(photo, index)
      ? [
          {
            key: "cover",
            label: t.makeCover,
            icon: "star" as const,
            disabled: busy,
            run: () => cover(photo, index),
          },
        ]
      : []),
    ...(moderates && photo.moderation !== "approved"
      ? [{ key: "approve", label: t.approve, disabled: busy, run: () => approve(photo, index) }]
      : []),
    ...(moderates && photo.moderation !== "declined"
      ? [{ key: "decline", label: t.decline, disabled: busy, run: () => startDecline(photo, index) }]
      : []),
    ...(editable
      ? [
          {
            key: "delete",
            label: t.deletePhoto,
            icon: "trash" as const,
            danger: true,
            disabled: busy,
            run: () => setRemoving(photo),
          },
        ]
      : []),
  ];

  return (
    <section className="panel" aria-labelledby="photos-title">
      <h2 id="photos-title" tabIndex={-1}>
        {t.photos} <span className="count">{photos.length}</span>
      </h2>
      <p className="muted small">{t.photosHint(minPhotos, maxPhotos)}</p>
      <p className="notice notice-warn">{portfolio ? t.portfolioWarning : t.noFacesWarning}</p>

      {photos.length === 0 ? (
        <p className="muted">{t.photosEmpty}</p>
      ) : (
        <ol className="photos">
          {photos.map((photo, index) => (
            <li key={photo.id} className="photo">
              <img
                src={photoSrc(photo.key)}
                srcSet={photoSrcSet(photo.key)}
                sizes="(max-width: 719px) 50vw, 200px"
                width={photo.width}
                height={photo.height}
                alt=""
                loading="lazy"
                decoding="async"
              />
              <div className="photo-tags">
                {isCover(photo, index) && <Pill tone="strong">{t.cover}</Pill>}
                <Pill tone={toneOf("photo", photo.moderation)}>{t.moderationStates[photo.moderation]}</Pill>
              </div>
              {photo.moderation === "declined" && photo.declineReason && (
                <p className="muted small photo-reason">{t.photoDeclineReason(photo.declineReason)}</p>
              )}
              {phone ? (
                <div className="photo-actions">
                  {editable && (
                    <>
                      <button
                        type="button"
                        className="btn btn-icon"
                        disabled={busy || index === 0}
                        onClick={() => move(index, -1)}
                        aria-label={t.moveEarlier(index + 1)}
                      >
                        <Icon name="back" size={20} />
                      </button>
                      <button
                        type="button"
                        className="btn btn-icon btn-flip"
                        disabled={busy || index === photos.length - 1}
                        onClick={() => move(index, 1)}
                        aria-label={t.moveLater(index + 1)}
                      >
                        <Icon name="back" size={20} />
                      </button>
                    </>
                  )}
                  <OverflowMenu
                    title={t.photoN(index + 1)}
                    label={t.more}
                    context={t.photoN(index + 1)}
                    className="btn btn-icon"
                    actions={menuOf(photo, index)}
                  />
                </div>
              ) : (
                <div className="photo-actions">
                  {editable && (
                    <>
                      <button
                        type="button"
                        className="btn btn-icon"
                        disabled={busy || index === 0}
                        onClick={() => move(index, -1)}
                        aria-label={t.moveEarlier(index + 1)}
                      >
                        <Icon name="back" size={20} />
                      </button>
                      <button
                        type="button"
                        className="btn btn-icon btn-flip"
                        disabled={busy || index === photos.length - 1}
                        onClick={() => move(index, 1)}
                        aria-label={t.moveLater(index + 1)}
                      >
                        <Icon name="back" size={20} />
                      </button>
                      {!isCover(photo, index) && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={busy}
                          onClick={() => cover(photo, index)}
                        >
                          {t.makeCover}
                        </button>
                      )}
                    </>
                  )}
                  {moderates && photo.moderation !== "approved" && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy}
                      onClick={() => approve(photo, index)}
                    >
                      {t.approve}
                    </button>
                  )}
                  {moderates && photo.moderation !== "declined" && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy}
                      onClick={(event) => startDecline(photo, index, event.currentTarget)}
                    >
                      {t.decline}
                    </button>
                  )}
                  {editable && (
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      disabled={busy}
                      onClick={() => setRemoving(photo)}
                    >
                      {t.deletePhoto}
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}

      <PhoneSheet
        open={declining !== null}
        title={t.declinePhotoTitle(declining?.n ?? 0)}
        onClose={() => setDeclining(null)}
        returnFocus={declineReturn}
      >
        {declining && (
          <div className="decline-photo">
            {!phone && (
              <h3 ref={declineTitle} tabIndex={-1} className="sub-title">
                {t.declinePhotoTitle(declining.n)}
              </h3>
            )}
            <ConfirmForm
              key={declining.photo.id}
              hint={t.declinePhotoHint(declining.n)}
              label={t.reason}
              required
              danger
              maxLength={REASON_MAX}
              submitLabel={t.declinePhoto}
              onSubmit={decline}
              onCancel={() => setDeclining(null)}
            />
          </div>
        )}
      </PhoneSheet>

      {editable && photos.length < maxPhotos && (
        <div className="upload">
          {portfolio ? (
            <RadioGroup<PhotoAck>
              variant="row"
              label={t.photoAckLabel}
              value={portfolioAck}
              onChange={setPortfolioAck}
              options={[
                { value: "consent", label: t.photoAckConsent },
                { value: "no_faces", label: t.photoAckNoFaces },
              ]}
            />
          ) : (
            <Checkbox checked={ack} onChange={setAck}>
              {t.noFacesAck}
            </Checkbox>
          )}
          <FileDrop
            title={phone ? t.addPhotosPhone : t.addPhotos}
            hint={phone ? t.photosPick : t.photosDrop}
            accept={phone ? ACCEPT_PHONE : ACCEPT}
            multiple
            disabled={!acknowledged || progress !== null}
            onFiles={(files) => void upload(files)}
          />
          {progress && (
            <p role="status" className="muted">
              {t.uploading(progress.done + 1, progress.total)}
            </p>
          )}
        </div>
      )}
      {overLimit ? (
        <p className="notice notice-warn" role="status">
          {t.photosOverLimit(overLimit.uploaded, overLimit.picked, maxPhotos)}
        </p>
      ) : null}
      {problems.length > 0 && (
        <ul className="notice notice-error" role="alert">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      {failure && <ErrorText failure={failure} />}
      <ConfirmSheet
        open={removing !== null}
        title={t.deletePhotoTitle}
        text={t.deletePhotoHint}
        confirmLabel={t.deletePhoto}
        cancelLabel={t.cancel}
        tone="danger"
        onConfirm={() => void remove()}
        onCancel={() => setRemoving(null)}
      />
    </section>
  );
}
