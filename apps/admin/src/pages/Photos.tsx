/* Фото карточки: загрузка (сжатие в браузере, без метаданных), порядок, обложка,
   решение модератора, удаление. На фото не должно быть лиц — предупреждение всегда на
   виду, без подтверждения файлы не выбрать. Выбор файлов — FileDrop: системный выбор
   или перетаскивание на компьютере. */

import { isImageError } from "@bayramm/media";
import { compressForUpload } from "@bayramm/media/browser";
import type { StaffPhoto } from "@bayramm/shared/api/staff";
import { Checkbox, FileDrop } from "@bayramm/ui/react";
import { useState } from "react";
import { type Failure, type Result, useCan, useSession } from "../api";
import { photoSrc, photoSrcSet } from "../format";
import { apiErrorText, t } from "../texts";
import { ErrorText, Pill } from "../ui";

interface PhotosProps {
  listingId: string;
  photos: readonly StaffPhoto[];
  minPhotos: number;
  maxPhotos: number;
  /** После любого изменения — перечитать карточку: меняются и фото, и блокеры */
  onChanged: () => void;
}

export function Photos({ listingId, photos, minPhotos, maxPhotos, onChanged }: PhotosProps) {
  const { api } = useSession();
  const can = useCan();
  const [ack, setAck] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const editable = can("listings.write");
  const base = `/staff/listings/${listingId}/photos`;
  // Обложка — отмеченное фото, а пока отметки нет — первое
  const hasCover = photos.some((photo) => photo.isCover);
  const isCover = (photo: StaffPhoto, index: number) => photo.isCover || (!hasCover && index === 0);

  const upload = async (picked: readonly File[]) => {
    const files = picked.slice(0, Math.max(0, maxPhotos - photos.length));
    if (files.length === 0) return;
    setProblems([]);
    setFailure(null);
    const found: string[] = [];
    for (const [index, file] of files.entries()) {
      setProgress({ done: index, total: files.length });
      try {
        // Перекодирование всегда: так EXIF и геопозиция не уходят дальше браузера
        const photo = await compressForUpload(file);
        const result = await api.upload<StaffPhoto>(base, photo.blob, { "X-No-Faces": "1" });
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
    onChanged();
  };

  const act = async (run: () => Promise<Result<unknown>>) => {
    setBusy(true);
    const result = await run();
    setBusy(false);
    setFailure(result.ok ? null : result);
    onChanged();
  };

  const move = (index: number, delta: number) => {
    const ids = photos.map((p) => p.id);
    const [moved] = ids.splice(index, 1);
    if (moved === undefined) return;
    ids.splice(index + delta, 0, moved);
    void act(() => api.put(`${base}/order`, { ids }));
  };

  return (
    <section className="panel" aria-labelledby="photos-title">
      <h2 id="photos-title">
        {t.photos} <span className="count">{photos.length}</span>
      </h2>
      <p className="muted small">{t.photosHint(minPhotos, maxPhotos)}</p>
      <p className="notice notice-warn">{t.noFacesWarning}</p>

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
                <Pill
                  tone={
                    photo.moderation === "approved"
                      ? "good"
                      : photo.moderation === "declined"
                        ? "warn"
                        : "muted"
                  }
                >
                  {t.moderationStates[photo.moderation]}
                </Pill>
              </div>
              <div className="photo-actions">
                {editable && (
                  <>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy || index === 0}
                      onClick={() => move(index, -1)}
                      aria-label={t.moveLeft}
                    >
                      ←
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy || index === photos.length - 1}
                      onClick={() => move(index, 1)}
                      aria-label={t.moveRight}
                    >
                      →
                    </button>
                    {!isCover(photo, index) && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busy}
                        onClick={() => void act(() => api.post(`${base}/${photo.id}/cover`))}
                      >
                        {t.makeCover}
                      </button>
                    )}
                  </>
                )}
                {can("photos.moderate") && photo.moderation !== "approved" && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() =>
                      void act(() => api.post(`${base}/${photo.id}/moderation`, { decision: "approved" }))
                    }
                  >
                    {t.approve}
                  </button>
                )}
                {can("photos.moderate") && photo.moderation !== "declined" && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() =>
                      void act(() => api.post(`${base}/${photo.id}/moderation`, { decision: "declined" }))
                    }
                  >
                    {t.decline}
                  </button>
                )}
                {editable && (
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    disabled={busy}
                    onClick={() => void act(() => api.del(`${base}/${photo.id}`))}
                  >
                    {t.deletePhoto}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}

      {editable && photos.length < maxPhotos && (
        <div className="upload">
          <Checkbox checked={ack} onChange={setAck}>
            {t.noFacesAck}
          </Checkbox>
          <FileDrop
            title={t.addPhotos}
            hint={t.photosDrop}
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
            multiple
            disabled={!ack || progress !== null}
            onFiles={(files) => void upload(files)}
          />
          {progress && (
            <p role="status" className="muted">
              {t.uploading(progress.done + 1, progress.total)}
            </p>
          )}
        </div>
      )}
      {problems.length > 0 && (
        <ul className="notice notice-error" role="alert">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      {failure && <ErrorText failure={failure} />}
    </section>
  );
}
