/* Фото витрины в кабинете: плитки, порядок и обложка, загрузка, удаление.

   Плитка — фото; у владельца кабинета она кнопка: нажатие открывает шторку действий («Сделать
   обложкой», «Переместить в начало / раньше / позже», «Удалить»), в углу — маленький «×»
   (невидимый слой нажатия 44px) и подтверждение удаления. Порядок и обложку партнёр выбирает сам,
   сразу, без проверки — у одобренных фото (клиенты видят только их): обложка всегда первая, её
   отдельно не двигают; ждущее решения и отклонённое фото можно только удалить. Сотрудник
   площадки (member) фото только смотрит.

   Загрузка — по правилу категории (photoPolicy), подтверждение не отмечено заранее и без него
   файлы не выбрать. no_people: одна галочка «На фото нет людей и лиц» (X-No-Faces). portfolio (фото
   и видео, студия): «Что на фото» — «Лиц нет» или «Люди согласны» (X-No-Faces / X-Photo-Consent),
   ничего не выбрано заранее. Каждый файл перекодирует браузер (compressForUpload: без EXIF и
   геопозиции) и отправляет по одному; новое фото ждёт модератора. Отклонённому — причина одной
   строкой под плиткой. Удаление — через подтверждение.

   В шторке — сам снимок. У отклонённого — причина и «Заменить»: новое фото (с тем же
   подтверждением) встаёт вместо него. Перенос (раньше, позже, в начало, обложка) шторку не
   закрывает — строка в ней говорит, что сделано. На компьютере одобренные фото (кроме обложки)
   можно перетащить мышью на место другого. Загрузили, заменили, удалили — всплывающая строка. */

import { isImageError } from "@bayramm/media";
import { compressForUpload } from "@bayramm/media/browser";
import type { VendorListing, VendorPhoto } from "@bayramm/shared/api/vendor";
import { Checkbox, ConfirmSheet, Dialog, FileDrop, RadioGroup, UiIcon, useToast } from "@bayramm/ui/react";
import { type DragEvent, useRef, useState } from "react";
import { ApiFailure, api } from "./api";
import { errorText } from "./errors";
import { fill, textOf, type VendorDict } from "./i18n";

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

interface Problem {
  readonly key: string;
  readonly text: string;
}

/** Что на загружаемых фото (portfolio): «лиц нет» или «люди согласны»; не выбрано — null */
type PhotoKind = "no_faces" | "consent";

/** Что можно сделать с фото: обложкой, в начало, раньше, позже — и новый порядок id для каждого шага */
export interface PhotoMoves {
  readonly cover: boolean;
  readonly start: boolean;
  readonly earlier: boolean;
  readonly later: boolean;
  /** Порядок всех одобренных фото после шага (для PUT …/photos/order) */
  readonly order: (move: "start" | "earlier" | "later") => string[];
}

/**
 * Одобренные фото в порядке показа и что с одним из них можно сделать: обложка стоит первой и не
 * двигается; остальные — в начало (сразу после обложки), на место раньше и позже; ждущее решения
 * и отклонённое — ничего, только удалить
 */
export function photoMoves(photos: readonly VendorPhoto[], photo: VendorPhoto): PhotoMoves {
  const approved = photos.filter((p) => p.moderation === "approved");
  const ids = approved.map((p) => p.id);
  const at = ids.indexOf(photo.id);
  if (at === -1 || photo.isCover) {
    return { cover: false, start: false, earlier: false, later: false, order: () => ids };
  }
  // Первое место для не-обложки: после обложки, если она есть
  const floor = approved[0]?.isCover ? 1 : 0;
  const placed = (to: number) => {
    const next = ids.filter((id) => id !== photo.id);
    next.splice(to, 0, photo.id);
    return next;
  };
  return {
    cover: true,
    start: at > floor + 1,
    earlier: at > floor,
    later: at < ids.length - 1,
    order: (move) => placed(move === "start" ? floor : move === "earlier" ? at - 1 : at + 1),
  };
}

/**
 * Порядок одобренных фото после перетаскивания dragged на место target; null — так нельзя
 * (обложка не двигается и её место не занимают, ждущее решения и отклонённое не участвуют)
 */
export function dropOrder(photos: readonly VendorPhoto[], dragged: string, target: string): string[] | null {
  const approved = photos.filter((p) => p.moderation === "approved");
  const ids = approved.map((p) => p.id);
  const from = ids.indexOf(dragged);
  const to = ids.indexOf(target);
  if (from === -1 || to === -1 || from === to) return null;
  if (approved[from]?.isCover || approved[to]?.isCover) return null;
  const next = ids.filter((id) => id !== dragged);
  next.splice(to, 0, dragged);
  return next;
}

export interface VenuePhotosProps {
  readonly listing: VendorListing;
  /** Правило фото категории: portfolio — люди на фото с их согласия */
  readonly portfolio: boolean;
  readonly t: VendorDict;
  /** Владелец кабинета: загружает, удаляет, выбирает порядок и обложку; сотрудник площадки смотрит */
  readonly owner: boolean;
  /** После загрузки, удаления, порядка: перечитать витрину (меняются фото и блокеры) */
  readonly onChanged: () => Promise<void>;
}

export function VenuePhotos({ listing, portfolio, t, owner, onChanged }: VenuePhotosProps) {
  const { photos, photoLimits } = listing;
  const [noFaces, setNoFaces] = useState(false);
  const [kind, setKind] = useState<PhotoKind | null>(null);
  const acknowledged = portfolio ? kind !== null : noFaces;
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [problems, setProblems] = useState<readonly Problem[]>([]);
  // Фото, у которого открыта шторка действий; само фото — из свежего списка (его могли изменить)
  const [openedId, setOpenedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  // Что сделано в открытой шторке (перенос, обложка): шторка остаётся, строка — в ней
  const [moved, setMoved] = useState<string | null>(null);
  // Перетаскивание мышью: какое фото тащат и над каким
  const [dragged, setDragged] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const toast = useToast();
  const [removing, setRemoving] = useState<VendorPhoto | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const title = useRef<HTMLHeadingElement>(null);
  // Куда вернуть фокус после шторки или подтверждения: на плитку (кнопку), а если фото удалено — на заголовок
  const focusBack = useRef<HTMLElement | null>(null);
  const room = Math.max(0, photoLimits.max - photos.length);
  const uploading = progress !== null;
  const labelId = "photo-kind-label";

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
        await api.uploadPhoto(listing.id, photo.blob, {
          noFaces: portfolio ? kind === "no_faces" : noFaces,
          consent: portfolio && kind === "consent",
        });
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
    const loaded = files.length - found.filter((p) => p.key !== "skipped").length;
    if (loaded > 0) toast(fill(t.photosUploaded, { n: loaded }), { tone: "success" });
    // Подтверждение — про выбранные фото: следующие — снова с галочкой
    setNoFaces(false);
    setKind(null);
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
            : errorText(err, t),
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
    toast(t.photoDeleted, { tone: "success" });
  };

  /**
   * Порядок или обложка: сразу на сервер, потом витрина заново. Из шторки — она остаётся открытой
   * (фото на новом месте, строка «сделано» в ней); перетаскиванием — всплывающая строка
   */
  const arrange = async (run: () => Promise<unknown>, message: string, inSheet = true) => {
    setBusy(true);
    setMoveError(null);
    setMoved(null);
    try {
      await run();
      await onChanged();
      if (inSheet) setMoved(message);
      else toast(message, { tone: "success" });
    } catch (err) {
      // Набор фото уже другой (модератор решил, удалили с другого устройства) — как сейчас
      if (err instanceof ApiFailure && (err.code === "invalid_input" || err.code === "not_found")) {
        await onChanged();
        setOpenedId(null);
      }
      setMoveError(errorText(err, t));
    } finally {
      setBusy(false);
    }
  };

  /** Отклонённое фото — заменить новым: с тем же подтверждением, что у загрузки */
  const replace = async (file: File | undefined, old: VendorPhoto) => {
    if (!file) return;
    setBusy(true);
    setMoveError(null);
    const gone = (err: unknown) => {
      // Уже удалено (с другого устройства) — как удалено
      if (!(err instanceof ApiFailure && err.code === "not_found")) throw err;
    };
    try {
      // Мест нет — сначала убрать отклонённое (клиенты его и так не видят), иначе — после загрузки
      if (room === 0) await api.deletePhoto(listing.id, old.id).catch(gone);
      const photo = await compressForUpload(file);
      await api.uploadPhoto(listing.id, photo.blob, {
        noFaces: portfolio ? kind === "no_faces" : noFaces,
        consent: portfolio && kind === "consent",
      });
      if (room > 0) await api.deletePhoto(listing.id, old.id).catch(gone);
      await onChanged();
      focusBack.current = title.current;
      setOpenedId(null);
      setNoFaces(false);
      setKind(null);
      toast(t.photoReplaced, { tone: "success" });
    } catch (err) {
      setMoveError(uploadErrorText(err, t));
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  /** Подтверждение для загрузки: «лиц нет» (галочка) или «что на фото» (portfolio) */
  const acknowledgement = (labelFor: string, disabled: boolean) =>
    portfolio ? (
      <div className="upload-kind">
        <p className="field-label" id={labelFor}>
          {t.photoKindLabel}
        </p>
        {/* Ничего не выбрано заранее: без выбора файлы не выбрать. Два варианта столбиком:
          подпись «Люди согласны на публикацию» целиком и на 320px */}
        <RadioGroup<PhotoKind>
          value={kind}
          onChange={setKind}
          variant="row"
          aria-labelledby={labelFor}
          disabled={disabled}
          options={[
            { value: "no_faces", label: t.photoKindNoFaces },
            { value: "consent", label: t.photoKindConsent },
          ]}
        />
      </div>
    ) : (
      <Checkbox checked={noFaces} onChange={setNoFaces} disabled={disabled}>
        {t.noFacesAck}
      </Checkbox>
    );

  // Перетаскивание мышью (компьютер): одобренное фото, кроме обложки, — на место другого такого же
  const draggable = (photo: VendorPhoto) =>
    owner && !uploading && !busy && photo.moderation === "approved" && !photo.isCover;
  const dragProps = (photo: VendorPhoto) =>
    draggable(photo)
      ? {
          draggable: true,
          onDragStart: (event: DragEvent<HTMLLIElement>) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", photo.id);
            setDragged(photo.id);
          },
          onDragEnd: () => {
            setDragged(null);
            setDropOn(null);
          },
          onDragOver: (event: DragEvent<HTMLLIElement>) => {
            if (dragged === null || dropOrder(photos, dragged, photo.id) === null) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDropOn(photo.id);
          },
          onDragLeave: () => setDropOn((current) => (current === photo.id ? null : current)),
          onDrop: (event: DragEvent<HTMLLIElement>) => {
            event.preventDefault();
            const order = dragged === null ? null : dropOrder(photos, dragged, photo.id);
            setDragged(null);
            setDropOn(null);
            if (order) void arrange(() => api.reorderPhotos(listing.id, order), t.photoMoved, false);
          },
        }
      : {};

  const opened = photos.find((p) => p.id === openedId) ?? null;
  const moves = opened ? photoMoves(photos, opened) : null;
  const openedNo = opened ? photos.indexOf(opened) + 1 : 0;
  const move = (to: "start" | "earlier" | "later") => {
    if (moves) void arrange(() => api.reorderPhotos(listing.id, moves.order(to)), t.photoMoved);
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
          {photos.map((photo, index) => {
            const image = (
              <img
                src={photo.src}
                srcSet={photo.srcSet}
                sizes="(min-width: 1024px) 220px, (min-width: 720px) 30vw, 50vw"
                width={photo.width}
                height={photo.height}
                alt={owner ? "" : `${listing.name} — ${t.photos} ${index + 1}`}
                loading={index < 2 ? "eager" : "lazy"}
                decoding="async"
              />
            );
            return (
              <li
                key={photo.id}
                className={dropOn === photo.id ? "is-drop" : undefined}
                {...dragProps(photo)}
              >
                {owner ? (
                  <button
                    type="button"
                    className="photo-tile"
                    aria-label={fill(t.photoOpenLabel, { n: index + 1 })}
                    disabled={uploading}
                    onClick={(event) => {
                      focusBack.current = event.currentTarget;
                      setMoveError(null);
                      setMoved(null);
                      setOpenedId(photo.id);
                    }}
                  >
                    {image}
                  </button>
                ) : (
                  <div className="photo-tile">{image}</div>
                )}
                {photo.isCover || photo.moderation !== "approved" ? (
                  <span
                    className={`chip photo-chip chip-${
                      photo.moderation === "declined"
                        ? "off"
                        : photo.moderation === "pending"
                          ? "wait"
                          : "cover"
                    }`}
                  >
                    {photo.moderation === "declined"
                      ? t.photoDeclined
                      : photo.moderation === "pending"
                        ? t.photoPending
                        : t.photoCover}
                  </span>
                ) : null}
                {owner ? (
                  <button
                    type="button"
                    className="photo-x"
                    aria-label={fill(t.photoDeleteLabel, { n: index + 1 })}
                    disabled={uploading}
                    onClick={(event) => {
                      focusBack.current = event.currentTarget;
                      setRemoveError(null);
                      setRemoving(photo);
                    }}
                  >
                    <UiIcon name="close" size={12} />
                  </button>
                ) : null}
                {photo.moderation === "declined" ? (
                  // Причина модератора — одной строкой прямо под снимком
                  <p className="photo-decline">
                    {photo.declineReason
                      ? fill(t.photoDeclinedReason, { reason: photo.declineReason })
                      : t.photoDeclinedNoReason}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {/* Шторка уже закрылась (набор фото изменился) — ошибка остаётся здесь */}
      {moveError && !opened ? (
        <p className="form-error" role="alert">
          {moveError}
        </p>
      ) : null}

      {owner ? (
        <>
          {room > 0 ? (
            <div className="upload">
              {acknowledgement(labelId, uploading)}
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
          <Dialog
            open={opened !== null}
            title={fill(t.photoSheetTitle, { n: openedNo })}
            onClose={() => {
              if (!busy) setOpenedId(null);
            }}
            returnFocus={focusBack}
          >
            {opened && moves ? (
              <div className="photo-actions">
                {/* Сам снимок: что именно двигают, делают обложкой или меняют */}
                <img
                  className="photo-sheet-img"
                  src={opened.src}
                  srcSet={opened.srcSet}
                  sizes="(min-width: 720px) 480px, 100vw"
                  width={opened.width}
                  height={opened.height}
                  alt=""
                  decoding="async"
                />
                {opened.moderation === "declined" ? (
                  <>
                    <p className="photo-decline">
                      {opened.declineReason
                        ? fill(t.photoDeclinedReason, { reason: opened.declineReason })
                        : t.photoDeclinedNoReason}
                    </p>
                    <div className="upload photo-replace">
                      {acknowledgement(`${labelId}-replace`, busy)}
                      <FileDrop
                        title={t.photoReplace}
                        hint={t.photoReplaceHint}
                        accept={PHOTO_ACCEPT}
                        disabled={!acknowledged || busy}
                        onFiles={(files) => void replace(files[0], opened)}
                      />
                    </div>
                  </>
                ) : null}
                {moves.cover ? (
                  <button
                    type="button"
                    className="ui-btn ui-btn-secondary"
                    disabled={busy}
                    onClick={() =>
                      void arrange(() => api.setCoverPhoto(listing.id, opened.id), t.photoCoverSet)
                    }
                  >
                    {t.photoMakeCover}
                  </button>
                ) : null}
                {moves.start ? (
                  <button
                    type="button"
                    className="ui-btn ui-btn-secondary"
                    disabled={busy}
                    onClick={() => move("start")}
                  >
                    {t.photoToStart}
                  </button>
                ) : null}
                {moves.earlier ? (
                  <button
                    type="button"
                    className="ui-btn ui-btn-secondary"
                    disabled={busy}
                    onClick={() => move("earlier")}
                  >
                    {t.photoEarlier}
                  </button>
                ) : null}
                {moves.later ? (
                  <button
                    type="button"
                    className="ui-btn ui-btn-secondary"
                    disabled={busy}
                    onClick={() => move("later")}
                  >
                    {t.photoLater}
                  </button>
                ) : null}
                {moved ? (
                  <p className="status-line" role="status">
                    {moved}
                  </p>
                ) : null}
                {/* Удаление — рамкой: главное в шторке — порядок и обложка, а не стереть */}
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={busy}
                  onClick={() => {
                    setRemoveError(null);
                    setRemoving(opened);
                    setOpenedId(null);
                  }}
                >
                  {t.photoDelete}
                </button>
                {opened.moderation === "pending" ? <p className="note">{t.photoOnlyApproved}</p> : null}
                {moveError ? (
                  <p className="form-error" role="alert">
                    {moveError}
                  </p>
                ) : null}
              </div>
            ) : null}
          </Dialog>
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
