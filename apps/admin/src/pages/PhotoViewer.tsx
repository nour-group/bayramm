/* Просмотр фото во весь экран — общий у очереди «Новые фото» (Moderation.tsx) и блока «Фото»
   страницы витрины (Photos.tsx): снимок целиком (не обрезан плиткой), что отметил загрузивший
   и правило фото категории, листать — кнопками и стрелками ← →, решить — здесь же (отказ —
   причиной прямо в просмотре). Под снимком страница витрины кладёт своё: причину отказа и
   действия с фото (обложка, в начало, удалить). */

import type { PhotoAck } from "@bayramm/shared/api/staff";
import type { PhotoPolicy } from "@bayramm/shared/categories";
import { Dialog } from "@bayramm/ui/react";
import { type ReactNode, type RefObject, useEffect, useRef } from "react";
import type { Failure } from "../api";
import { photoSrc, photoSrcSet } from "../format";
import { Icon } from "../icons";
import { t } from "../texts";
import { ErrorText } from "../ui";

/** Что нужно просмотру от фото: адреса вариантов — по key, отметка загрузившего */
export interface ViewerPhoto {
  readonly id: string;
  readonly key: string;
  readonly width: number;
  readonly height: number;
  readonly ack: PhotoAck;
}

export interface PhotoViewerProps<P extends ViewerPhoto> {
  readonly photos: readonly P[];
  /** Какое по счёту открыто */
  readonly at: number;
  /** Название витрины — в заголовке */
  readonly name: string;
  /** Правило фото категории витрины */
  readonly policy: PhotoPolicy | undefined;
  /** Решает по фото (photos.moderate): кнопки «Одобрить» и «Отклонить» */
  readonly decides: boolean;
  /** Идёт запрос: кнопки решения недоступны */
  readonly working: boolean;
  /** Это фото можно одобрить; нельзя — вместо «Одобрить» подпись doneLabel */
  readonly canApprove: (photo: P) => boolean;
  readonly canDecline: (photo: P) => boolean;
  readonly doneLabel: (photo: P) => string;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onGo: (id: string) => void;
  readonly onApprove: (photo: P, at: number) => void;
  readonly onDecline: (photo: P, at: number) => void;
  /** Причина отказа открытого фото — форма прямо в просмотре */
  readonly declining: boolean;
  readonly declineForm: ReactNode;
  readonly failure: Failure | null;
  readonly onClose: () => void;
  /** Под снимком: состояние, причина отказа, другие действия */
  readonly children?: ReactNode;
}

/**
 * Фото во весь экран. Диалог набора: Esc и крестик закрывают, Tab ходит внутри, фокус после
 * закрытия — на returnFocus
 */
export function PhotoViewer<P extends ViewerPhoto>({
  photos,
  at,
  name,
  policy,
  decides,
  working,
  canApprove,
  canDecline,
  doneLabel,
  returnFocus,
  onGo,
  onApprove,
  onDecline,
  declining,
  declineForm,
  failure,
  onClose,
  children,
}: PhotoViewerProps<P>) {
  const photo = photos[at];
  const total = photos.length;
  const go = (step: number) => {
    const next = photos[(at + step + total) % total];
    if (next) onGo(next.id);
  };
  // Стрелки листают, пока не вписывают причину отказа (в поле стрелки двигают курсор)
  const goRef = useRef(go);
  goRef.current = go;
  useEffect(() => {
    if (declining || total < 2) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, [role='radiogroup']")) return;
      if (event.key === "ArrowLeft") goRef.current(-1);
      else if (event.key === "ArrowRight") goRef.current(1);
      else return;
      event.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [declining, total]);
  // Решили, перелистнули или закрыли форму причины: кнопка «Одобрить» была недоступна, пока шёл
  // запрос (или форма ушла вместе с фокусом), — возвращаем его в просмотр (на «Одобрить», без
  // него — на сам диалог), иначе Esc и Tab не дошли бы до просмотра
  const approveRef = useRef<HTMLButtonElement>(null);
  const shownId = photo?.id;
  useEffect(() => {
    if (working || shownId === undefined) return;
    const viewer = document.querySelector<HTMLElement>(".photo-viewer");
    // «Отклонить» (и с клавиатуры) — кнопка стала недоступной, фокус ушёл бы в body: сразу в
    // поле причины, иначе Esc, стрелки и Tab до формы не дошли бы
    if (declining) {
      viewer?.querySelector<HTMLElement>("form textarea, form input:not([type=hidden])")?.focus();
      return;
    }
    if (viewer?.contains(document.activeElement)) return;
    const approve = approveRef.current;
    (approve && !approve.disabled ? approve : viewer)?.focus({ preventScroll: true });
  }, [working, shownId, declining]);
  if (!photo) return null;
  const approvable = canApprove(photo);
  return (
    <Dialog
      open
      title={t.photoViewerTitle(at + 1, total, name)}
      onClose={onClose}
      returnFocus={returnFocus}
      className="photo-viewer"
      actions={
        <div className="viewer-actions">
          <button
            type="button"
            className="btn btn-icon viewer-step"
            disabled={total < 2}
            onClick={() => go(-1)}
          >
            <Icon name="back" size={20} />
            <span className="visually-hidden">{t.photoPrev}</span>
          </button>
          {decides ? (
            <>
              <button
                ref={approveRef}
                type="button"
                className="btn btn-primary viewer-approve"
                disabled={working || !approvable}
                onClick={() => onApprove(photo, at)}
              >
                {approvable ? t.photoApprove : doneLabel(photo)}
              </button>
              <button
                type="button"
                className="btn btn-danger-fill viewer-decline"
                disabled={working || !canDecline(photo) || declining}
                onClick={() => onDecline(photo, at)}
              >
                {t.photoDecline}
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="btn btn-icon viewer-step"
            disabled={total < 2}
            onClick={() => go(1)}
          >
            <Icon name="forward" size={20} />
            <span className="visually-hidden">{t.photoNext}</span>
          </button>
        </div>
      }
    >
      <figure className="viewer-figure">
        <img
          key={photo.id}
          className="viewer-image"
          src={photoSrc(photo.key, 1280)}
          srcSet={photoSrcSet(photo.key, true)}
          sizes="100vw"
          width={photo.width > 0 ? photo.width : undefined}
          height={photo.height > 0 ? photo.height : undefined}
          alt=""
          decoding="async"
        />
        <figcaption className="viewer-claim">
          <span className="photo-claim">{t.photoAckClaim[photo.ack]}</span>
          {policy ? <span className="photo-rule">{t.photoRule[policy]}</span> : null}
          {total > 1 ? <span className="muted small viewer-keys">{t.photoViewerKeys}</span> : null}
        </figcaption>
      </figure>
      {children}
      {declining ? declineForm : null}
      {failure ? <ErrorText failure={failure} /> : null}
    </Dialog>
  );
}
