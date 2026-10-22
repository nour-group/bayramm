/* Фото карточки: загрузка (сжатие в браузере, без метаданных), обложка, порядок, решение
   модератора (отказ — только с причиной: её видит партнёр, она подписана у отклонённого фото),
   удаление (через подтверждение). Плитка — фото и плашка состояния; нажатие открывает тот же
   просмотр во весь экран, что у очереди «Новые фото» (PhotoViewer): снимок целиком, что отметил
   загрузивший (лиц нет / люди согласны) и правило фото категории, ← → листают, «Одобрить» и
   «Отклонить» — там же, под снимком — обложка, «в начало», удалить. В шапке — сколько фото из
   предела и минимум; модератору, пока есть ждущие решения, — «Одобрить все (n)»: сразу, если
   каждое ждущее фото открывали, иначе — через подтверждение с числом неоткрытых. Какие фото
   открывали — usePhotoReview страницы витрины: публикация одобряет только их.
   Подтверждение — по правилу фото категории, и спрашивается при загрузке («Добавить фото»):
   «без людей» (площадка, кортеж, цветы, торты, подарки, декор) — на фото нет лиц (X-No-Faces);
   портфолио (фото и видео, студия) — люди на фото согласны на публикацию (X-Photo-Consent) или
   лиц нет. Правило — подписью над выбором, ничего не отмечено заранее, без подтверждения файлы не
   выбрать. Выбор файлов — FileDrop: на телефоне — камера или галерея, на компьютере — ещё и
   перетаскивание. Выбрали больше, чем помещается до предела, — загружаются первые, а строка
   говорит, сколько из выбранных и почему не все.
   Обложка и одобрение — без перезагрузки экрана: о сделанном — всплывающей строкой. */

import { isImageError } from "@bayramm/media";
import { compressForUpload } from "@bayramm/media/browser";
import type { StaffPhoto } from "@bayramm/shared/api/staff";
import { NO_FACES_HEADER, PHOTO_CONSENT_HEADER } from "@bayramm/shared/api/vendor";
import type { PhotoPolicy } from "@bayramm/shared/categories";
import { Checkbox, ConfirmSheet, FileDrop, RadioGroup, useToast } from "@bayramm/ui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Failure, type Result, useCan, useSession } from "../api";
import { photoSrc, photoSrcSet } from "../format";
import { usePhone } from "../layout";
import { apiErrorText, t } from "../texts";
import { ConfirmForm, ErrorText, PhoneSheet, Pill, toneOf } from "../ui";
import { useUndoable } from "../undo";
import { NextInQueue } from "./NextInQueue";
import { PhotoViewer } from "./PhotoViewer";

/** Форматы фото; на телефоне — любое фото: так точно предлагают и камеру, и галерею (HEIC — по расширению) */
const ACCEPT = "image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif";
const ACCEPT_PHONE = "image/*,.heic,.heif";

/** Причина отказа по фото — не длиннее, чем принимает сервер */
const REASON_MAX = 500;

/** Что подтвердил сотрудник о выбранных фото (портфолио) */
type PhotoAck = "consent" | "no_faces";

/** Какие фото витрины открывали во весь экран (за этот заход на страницу) и какое открыто сейчас */
export interface PhotoReview {
  readonly seen: ReadonlySet<string>;
  readonly viewing: string | null;
  /** Открыть фото во весь экран — и запомнить, что его видели */
  readonly view: (id: string) => void;
  readonly close: () => void;
}

/**
 * Просмотр фото страницы витрины: блок «Фото» открывает фото, публикация одобряет только
 * открытые (остальные ждут решения), шторка публикации открывает первое неоткрытое
 */
export function usePhotoReview(): PhotoReview {
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set());
  const [viewing, setViewing] = useState<string | null>(null);
  const view = useCallback((id: string) => {
    setViewing(id);
    setSeen((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);
  const close = useCallback(() => setViewing(null), []);
  return useMemo(() => ({ seen, viewing, view, close }), [seen, viewing, view, close]);
}

interface PhotosProps {
  listingId: string;
  /** Название витрины — в заголовке просмотра */
  listingName: string;
  /** Правило фото категории витрины */
  photoPolicy: PhotoPolicy;
  photos: readonly StaffPhoto[];
  minPhotos: number;
  maxPhotos: number;
  /** Просмотр во весь экран: общий со шторкой публикации */
  review: PhotoReview;
  /** После любого изменения — перечитать карточку: меняются и фото, и блокеры */
  onChanged: () => void;
}

interface SheetItem {
  readonly key: string;
  readonly label: string;
  readonly danger?: boolean;
  readonly run: () => void;
}

export function Photos({
  listingId,
  listingName,
  photoPolicy,
  photos,
  minPhotos,
  maxPhotos,
  review,
  onChanged,
}: PhotosProps) {
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
  // Загрузка: подпись правила, подтверждение и выбор файлов — по «Добавить фото»
  const [adding, setAdding] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  // Куда вернуть фокус, когда просмотр закроется: плитка, с которой открыли, иначе — заголовок блока
  const viewerReturn = useRef<HTMLElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  // Фото, которое отклоняют, и его номер в ряду: причина — прямо в просмотре
  const [declining, setDeclining] = useState<{ photo: StaffPhoto; n: number } | null>(null);
  // «Одобрить все», когда открыты не все ждущие фото, — через подтверждение
  const [confirmAll, setConfirmAll] = useState(false);
  const allButton = useRef<HTMLButtonElement>(null);
  const phone = usePhone();
  const editable = can("listings.write");
  const moderates = can("photos.moderate");
  const base = `/staff/listings/${listingId}/photos`;
  // Обложка — отмеченное фото, а пока отметки нет — первое
  const hasCover = photos.some((photo) => photo.isCover);
  const isCover = (photo: StaffPhoto, index: number) => photo.isCover || (!hasCover && index === 0);
  // Одобренные, но ещё отменяемые («Отменить» 5 секунд): для экрана — уже одобрены
  const undoable = useUndoable();
  const [approving, setApproving] = useState<ReadonlySet<string>>(new Set());
  // Решили здесь и ждущих не осталось — к следующей витрине в очереди фото
  const [decidedHere, setDecidedHere] = useState(false);
  // Перечитали витрину: что сервер уже одобрил (или решил иначе), помнить больше не нужно
  useEffect(() => {
    setApproving((prev) => {
      const next = new Set(
        [...prev].filter((id) => photos.find((photo) => photo.id === id)?.moderation === "pending"),
      );
      return next.size === prev.size ? prev : next;
    });
  }, [photos]);
  const stateOf = (photo: StaffPhoto): StaffPhoto["moderation"] =>
    approving.has(photo.id) ? "approved" : photo.moderation;
  const pending = photos.filter((photo) => stateOf(photo) === "pending");
  const unseen = pending.filter((photo) => !review.seen.has(photo.id)).length;
  const full = photos.length >= maxPhotos;
  const { viewing, view, close } = review;

  // Просмотр открыли не с плитки (шторка публикации) — фокус потом на заголовок блока
  useEffect(() => {
    if (viewing !== null && !viewerReturn.current?.isConnected) viewerReturn.current = titleRef.current;
  }, [viewing]);

  const upload = async (picked: readonly File[]) => {
    const files = picked.slice(0, Math.max(0, maxPhotos - photos.length));
    setOverLimit(null);
    if (files.length === 0) return;
    // Файлы выбраны — шторка и подтверждение свою работу сделали; ход загрузки — в блоке
    setAdding(false);
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

  /** После решения в просмотре — следующее ждущее фото; больше нет — остаётся это */
  const nextPending = (id: string): string | null => {
    const at = photos.findIndex((photo) => photo.id === id);
    const rest = photos.filter((photo) => photo.id !== id && stateOf(photo) === "pending");
    return (rest.find((photo) => photos.indexOf(photo) > at) ?? rest[0])?.id ?? null;
  };
  const goNext = (id: string) => {
    const next = nextPending(id);
    if (next && viewing === id) view(next);
  };

  const toStart = (index: number) => {
    const ids = photos.map((p) => p.id);
    const [moved] = ids.splice(index, 1);
    if (moved === undefined) return;
    ids.unshift(moved);
    void act(() => api.put(`${base}/order`, { ids }), t.toastPhotoFirst(index + 1));
  };

  const cover = (photo: StaffPhoto, index: number) =>
    void act(() => api.post(`${base}/${photo.id}/cover`), t.toastCover(index + 1));
  /**
   * Одобрить: фото сразу считается одобренным, решение уходит через 5 секунд — до того «Отменить»
   * в строке уведомления возвращает его без запроса. Сервер отказал — фото снова ждёт, причина — здесь
   */
  const approve = (photo: StaffPhoto, index: number) => {
    setFailure(null);
    setApproving((prev) => new Set(prev).add(photo.id));
    goNext(photo.id);
    const done = () =>
      setApproving((prev) => {
        const next = new Set(prev);
        next.delete(photo.id);
        return next;
      });
    undoable({
      key: photo.id,
      text: t.photoApprovedUndo(index + 1),
      undo: done,
      commit: async () => {
        const result = await api.post(`${base}/${photo.id}/moderation`, { decision: "approved" });
        // Одобрено — отметка остаётся, пока витрина не перечиталась (фото не мигнёт «ждёт»)
        if (result.ok) setDecidedHere(true);
        else {
          done();
          setFailure(result);
        }
        onChanged();
      },
    });
  };
  // Все ждущие решения — по одному (у API решение по одному фото); остановка на первой ошибке
  const approveAll = async () => {
    setConfirmAll(false);
    setBusy(true);
    let done = 0;
    let stopped: Failure | null = null;
    for (const photo of pending) {
      const result = await api.post(`${base}/${photo.id}/moderation`, { decision: "approved" });
      if (!result.ok) {
        stopped = result;
        break;
      }
      done += 1;
    }
    setBusy(false);
    setFailure(stopped);
    if (done > 0) {
      toast(t.toastPhotosApproved(done), { tone: "success" });
      setDecidedHere(true);
    }
    onChanged();
  };
  // Каждое ждущее фото открыто во весь экран — одобрить все сразу; иначе — подтвердить число
  const askAll = () => (unseen === 0 ? void approveAll() : setConfirmAll(true));
  // Отказ без причины сервер не примет (422): причину спрашивает форма прямо в просмотре
  const decline = async (reason: string): Promise<Failure | null> => {
    if (!declining) return null;
    const { photo } = declining;
    const result = await api.post(`${base}/${photo.id}/moderation`, { decision: "declined", reason });
    if (!result.ok) return result;
    setDeclining(null);
    setDecidedHere(true);
    goNext(photo.id);
    onChanged();
    return null;
  };

  const remove = async () => {
    if (!removing) return;
    const photo = removing;
    setRemoving(null);
    await act(() => api.del(`${base}/${photo.id}`));
  };

  const shownIndex = viewing === null ? -1 : photos.findIndex((photo) => photo.id === viewing);
  const shown = shownIndex >= 0 ? photos[shownIndex] : undefined;
  const closeViewer = () => {
    setDeclining(null);
    close();
  };
  /** Действия под снимком: обложка, в начало, удаление (решение — в строке просмотра) */
  const moreItems = (photo: StaffPhoto, index: number): SheetItem[] => [
    ...(editable && !isCover(photo, index)
      ? [{ key: "cover", label: t.makeCover, run: () => cover(photo, index) }]
      : []),
    ...(editable && index > 0 ? [{ key: "first", label: t.moveToStart, run: () => toStart(index) }] : []),
    ...(editable
      ? [
          {
            key: "delete",
            label: t.deletePhoto,
            danger: true,
            run: () => setRemoving(photo),
          },
        ]
      : []),
  ];
  const statesOf = (photo: StaffPhoto, index: number) => [
    ...(isCover(photo, index) ? [t.cover] : []),
    t.moderationStates[stateOf(photo)] ?? stateOf(photo),
  ];
  const more = shown ? moreItems(shown, shownIndex) : [];

  return (
    <section className="panel" aria-labelledby="photos-title">
      <div className="panel-head">
        <h2 id="photos-title" tabIndex={-1} ref={titleRef}>
          {t.photos} <span className="count">{t.photosOf(photos.length, maxPhotos)}</span>
        </h2>
        <span className={`photos-min${photos.length < minPhotos ? " is-short" : ""}`}>
          {t.photosMin(minPhotos)}
        </span>
        <div className="head-acts">
          {moderates && pending.length > 0 ? (
            <button
              ref={allButton}
              type="button"
              className="btn btn-sm"
              aria-busy={busy || undefined}
              disabled={busy}
              onClick={askAll}
            >
              {t.photosApproveAll(pending.length)}
            </button>
          ) : null}
          {editable && !full ? (
            <button
              ref={addButton}
              type="button"
              className="btn btn-sm"
              aria-expanded={adding}
              disabled={progress !== null}
              onClick={() => setAdding(!adding)}
            >
              {t.photosAdd}
            </button>
          ) : null}
        </div>
      </div>

      {photos.length > 0 ? <p className="photo-rule">{t.photoRule[photoPolicy]}</p> : null}
      {photos.length === 0 ? (
        <p className="muted">{t.photosEmpty}</p>
      ) : (
        <ol className="photos">
          {photos.map((photo, index) => {
            const states = statesOf(photo, index);
            return (
              <li key={photo.id} className="photo">
                <button
                  type="button"
                  className="photo-tile"
                  aria-haspopup="dialog"
                  aria-label={`${t.photoN(index + 1)}: ${states.join(", ")}`}
                  onClick={(event) => {
                    viewerReturn.current = event.currentTarget;
                    setFailure(null);
                    view(photo.id);
                  }}
                >
                  <img
                    src={photoSrc(photo.key)}
                    srcSet={photoSrcSet(photo.key)}
                    sizes="(max-width: 719px) 33vw, 160px"
                    width={photo.width}
                    height={photo.height}
                    alt=""
                    loading="lazy"
                    decoding="async"
                  />
                  <span className="photo-tags" aria-hidden="true">
                    {isCover(photo, index) ? <Pill tone="strong">{t.cover}</Pill> : null}
                    {stateOf(photo) === "approved" ? null : (
                      <Pill tone={toneOf("photo", stateOf(photo))}>{t.moderationStates[stateOf(photo)]}</Pill>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}

      {moderates && decidedHere && pending.length === 0 ? (
        <NextInQueue queue="photos" currentId={listingId} focus={false} />
      ) : null}

      {shown ? (
        <PhotoViewer
          photos={photos}
          at={shownIndex}
          name={listingName}
          policy={photoPolicy}
          decides={moderates}
          working={busy}
          canApprove={(photo) => stateOf(photo) !== "approved"}
          // Пока «Одобрить» можно отменить — сначала «Отменить», потом отказ
          canDecline={(photo) => !approving.has(photo.id) && stateOf(photo) !== "declined"}
          doneLabel={(photo) => t.moderationStates[stateOf(photo)] ?? stateOf(photo)}
          returnFocus={viewerReturn}
          onGo={(id) => {
            setDeclining(null);
            view(id);
          }}
          onApprove={(photo, at) => approve(photo, at)}
          onDecline={(photo, at) => {
            setFailure(null);
            setDeclining({ photo, n: at + 1 });
          }}
          declining={declining !== null && declining.photo.id === shown.id}
          declineForm={
            declining ? (
              <ConfirmForm
                key={declining.photo.id}
                hint={t.declinePhotoHint(declining.n)}
                label={t.reason}
                required
                danger
                presets={t.reasons.photoDecline}
                maxLength={REASON_MAX}
                submitLabel={t.declinePhoto}
                onSubmit={decline}
                onCancel={() => setDeclining(null)}
              />
            ) : null
          }
          failure={failure}
          onClose={closeViewer}
        >
          <p className="muted small">{statesOf(shown, shownIndex).join(" · ")}</p>
          {shown.moderation === "declined" && shown.declineReason ? (
            <p className="muted small photo-reason">{t.photoDeclineReason(shown.declineReason)}</p>
          ) : null}
          {more.length > 0 ? (
            <ul className="menu">
              {more.map((item) => (
                <li key={item.key}>
                  <button
                    type="button"
                    className={`menu-item${item.danger ? " menu-danger" : ""}`}
                    disabled={busy}
                    onClick={() => {
                      closeViewer();
                      setTimeout(item.run, 0);
                    }}
                  >
                    <span>{item.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </PhotoViewer>
      ) : null}

      {editable && !full ? (
        <PhoneSheet
          open={adding}
          title={t.photosAdd}
          onClose={() => setAdding(false)}
          returnFocus={addButton}
        >
          <div className="upload">
            {/* Правило категории — подписью к выбору: человек видит его в тот момент, когда подтверждает */}
            <p className="muted small">{portfolio ? t.portfolioWarning : t.noFacesWarning}</p>
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
            <div className="acts">
              <button type="button" className="btn" onClick={() => setAdding(false)}>
                {t.cancel}
              </button>
            </div>
          </div>
        </PhoneSheet>
      ) : null}
      {progress && (
        <p role="status" className="muted">
          {t.uploading(progress.done + 1, progress.total)}
        </p>
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
      {failure && viewing === null ? <ErrorText failure={failure} /> : null}
      <ConfirmSheet
        open={confirmAll}
        title={t.photoApproveAllQ(pending.length)}
        text={t.photoApproveAllText(pending.length, pending.length - unseen)}
        confirmLabel={t.photoApproveAllGo}
        cancelLabel={t.cancel}
        returnFocus={allButton}
        onConfirm={() => void approveAll()}
        onCancel={() => setConfirmAll(false)}
      />
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
