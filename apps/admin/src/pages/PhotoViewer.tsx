/* Просмотр фото во весь экран — общий у очереди «Новые фото» (Moderation.tsx) и блока «Фото»
   страницы витрины (Photos.tsx): снимок целиком (не обрезан плиткой), что отметил загрузивший
   и правило фото категории, листать — кнопками, стрелками ← → и смахиванием, решить — здесь же
   (отказ — причиной прямо в просмотре). Увеличить — двойным касанием или щелчком, двумя
   пальцами или кнопкой «Увеличить»: тогда грузится самый крупный вариант (1920), лицо в углу
   кадра видно. Под снимком страница витрины кладёт своё: причину отказа и действия с фото
   (обложка, в начало, удалить). */

import type { PhotoAck } from "@bayramm/shared/api/staff";
import type { PhotoPolicy } from "@bayramm/shared/categories";
import { Dialog } from "@bayramm/ui/react";
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
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
  /**
   * Снимок этого фото показан (загрузился): только теперь фото считается открытым — для «Одобрить
   * все» без вопроса и для публикации
   */
  readonly onShown?: (id: string) => void;
  /** Причина отказа открытого фото — форма прямо в просмотре */
  readonly declining: boolean;
  readonly declineForm: ReactNode;
  readonly failure: Failure | null;
  readonly onClose: () => void;
  /** Под снимком: состояние, причина отказа, другие действия */
  readonly children?: ReactNode;
}

/** Увеличение снимка: во сколько раз и сдвиг от середины рамки, px */
interface View {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

const WHOLE: View = { scale: 1, x: 0, y: 0 };
/** Двойное касание и кнопка «Увеличить» */
const TAP_ZOOM = 2.5;
const MAX_ZOOM = 4;
/** Смахнули дальше — листаем; меньше — это касание или дрожь пальца */
const SWIPE_PX = 48;
const MOVE_PX = 8;
const DOUBLE_TAP_MS = 320;
/** Второе нажатие решения раньше этого — повтор, а не новое решение */
export const REPEAT_MS = 500;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Gesture {
  readonly x: number;
  readonly y: number;
  readonly view: View;
  /** Два пальца: расстояние между ними и середина в начале */
  readonly distance: number;
  readonly mid: Point;
  moved: boolean;
}

/**
 * Увеличение и смахивание одним набором указателей (палец, мышь, перо): два пальца — масштаб
 * вокруг середины между ними; один при увеличении — сдвиг, без увеличения — смахнуть к соседнему
 * фото; двойное касание (щелчок) — увеличить в этой точке или вернуть целиком. Сдвиг не уводит
 * снимок за край рамки. Другое фото — снова целиком
 */
function useZoom(photoId: string | undefined, onSwipe: (step: number) => void) {
  const frame = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const view = useRef<View>(WHOLE);
  const [zoomed, setZoomed] = useState(false);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const lastTap = useRef<{ at: number; x: number; y: number } | null>(null);

  const apply = (next: View) => {
    const box = frame.current?.getBoundingClientRect();
    const scale = clamp(next.scale, 1, MAX_ZOOM);
    const limitX = box ? (box.width * (scale - 1)) / 2 : 0;
    const limitY = box ? (box.height * (scale - 1)) / 2 : 0;
    view.current =
      scale === 1 ? WHOLE : { scale, x: clamp(next.x, -limitX, limitX), y: clamp(next.y, -limitY, limitY) };
    const { x, y } = view.current;
    if (image.current)
      image.current.style.transform = scale === 1 ? "" : `translate(${x}px, ${y}px) scale(${scale})`;
    setZoomed(scale > 1);
  };

  /** Точка относительно середины рамки */
  const local = (clientX: number, clientY: number): Point => {
    const box = frame.current?.getBoundingClientRect();
    return box
      ? { x: clientX - (box.left + box.width / 2), y: clientY - (box.top + box.height / 2) }
      : { x: 0, y: 0 };
  };

  /** Новый масштаб вокруг точки: она остаётся под пальцем */
  const zoomAt = (from: View, scale: number, at: Point): View => {
    const ratio = scale / from.scale;
    return { scale, x: at.x - (at.x - from.x) * ratio, y: at.y - (at.y - from.y) * ratio };
  };

  const toggle = (at: Point = { x: 0, y: 0 }) =>
    apply(view.current.scale > 1 ? WHOLE : zoomAt(WHOLE, TAP_ZOOM, at));

  // biome-ignore lint/correctness/useExhaustiveDependencies: сброс — именно по смене фото
  useEffect(() => {
    view.current = WHOLE;
    pointers.current.clear();
    gesture.current = null;
    lastTap.current = null;
    if (image.current) image.current.style.transform = "";
    setZoomed(false);
  }, [photoId]);

  /** Начало жеста от тех пальцев, что сейчас на экране */
  const begin = (continued: boolean) => {
    const [a, b] = [...pointers.current.values()];
    if (!a) {
      gesture.current = null;
      return;
    }
    gesture.current = {
      x: a.x,
      y: a.y,
      view: view.current,
      distance: b ? Math.hypot(b.x - a.x, b.y - a.y) : 0,
      mid: b ? local((a.x + b.x) / 2, (a.y + b.y) / 2) : local(a.x, a.y),
      // Палец, оставшийся после двух, — уже не касание и не смахивание
      moved: continued,
    };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size <= 2) begin(pointers.current.size === 2);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const g = gesture.current;
    const [a, b] = [...pointers.current.values()];
    if (!g || !a) return;
    if (b && g.distance > 0) {
      g.moved = true;
      apply(
        zoomAt(
          g.view,
          clamp((g.view.scale * Math.hypot(b.x - a.x, b.y - a.y)) / g.distance, 1, MAX_ZOOM),
          g.mid,
        ),
      );
      return;
    }
    const dx = a.x - g.x;
    const dy = a.y - g.y;
    if (Math.abs(dx) + Math.abs(dy) > MOVE_PX) g.moved = true;
    if (g.view.scale > 1) apply({ ...g.view, x: g.view.x + dx, y: g.view.y + dy });
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId)) return;
    const g = gesture.current;
    if (pointers.current.size > 0) {
      // Убрали один палец из двух — оставшийся продолжает с текущего вида
      begin(true);
      return;
    }
    gesture.current = null;
    if (!g) return;
    if (!g.moved) {
      const now = Date.now();
      const tap = lastTap.current;
      const near = tap && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) < 32;
      if (tap && near && now - tap.at < DOUBLE_TAP_MS) {
        lastTap.current = null;
        toggle(local(event.clientX, event.clientY));
      } else lastTap.current = { at: now, x: event.clientX, y: event.clientY };
      return;
    }
    const dx = event.clientX - g.x;
    const dy = event.clientY - g.y;
    const whole = g.view.scale === 1 && view.current.scale === 1;
    if (whole && Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) onSwipe(dx < 0 ? 1 : -1);
  };

  const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size === 0) gesture.current = null;
  };

  return {
    frame,
    image,
    zoomed,
    toggle,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
  };
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
  onShown,
  declining,
  declineForm,
  failure,
  onClose,
  children,
}: PhotoViewerProps<P>) {
  const photo = photos[at];
  const total = photos.length;
  // Решать — только по показанному снимку: после «Одобрить» открывается следующее, и двойной
  // щелчок или зажатый Enter не должны одобрить его, пока его не видно
  const [shown, setShown] = useState<string | null>(null);
  const loaded = photo !== undefined && shown === photo.id;
  const lastApprove = useRef(0);
  /**
   * Повтор нажатия (второй щелчок, автоповтор клавиши) сразу после «Одобрить» — уже по следующему
   * фото: не решение. Отказ только открывает форму причины — его не запоминаем
   */
  const decide = (event: { detail: number }, run: () => void, approve: boolean) => {
    const now = Date.now();
    if (event.detail > 1 || now - lastApprove.current < REPEAT_MS) return;
    if (approve) lastApprove.current = now;
    run();
  };
  const go = (step: number) => {
    const next = photos[(at + step + total) % total];
    if (next) onGo(next.id);
  };
  // Стрелки листают, пока не вписывают причину отказа (в поле стрелки двигают курсор)
  const goRef = useRef(go);
  goRef.current = go;
  const zoom = useZoom(photo?.id, (step) => {
    if (total > 1 && !declining) goRef.current(step);
  });
  const zoomed = zoom.zoomed;
  useEffect(() => {
    if (declining || total < 2 || zoomed) return;
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
  }, [declining, total, zoomed]);
  // Решили, перелистнули или закрыли форму причины: кнопка «Одобрить» была недоступна, пока шёл
  // запрос (или форма ушла вместе с фокусом), — возвращаем его в просмотр (на «Одобрить», без
  // него — на сам диалог), иначе Esc и Tab не дошли бы до просмотра
  const approveRef = useRef<HTMLButtonElement>(null);
  const shownId = photo?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: loaded — снимок показан, «Одобрить» стало доступно
  useEffect(() => {
    if (working || shownId === undefined) return;
    const viewer = document.querySelector<HTMLElement>(".photo-viewer");
    // «Отклонить» (и с клавиатуры) — кнопка стала недоступной, фокус ушёл бы в body: сразу в
    // поле причины, иначе Esc, стрелки и Tab до формы не дошли бы
    if (declining) {
      viewer?.querySelector<HTMLElement>("form textarea, form input:not([type=hidden])")?.focus();
      return;
    }
    // Фокус на самом просмотре, пока снимок грузился, — на «Одобрить», когда оно стало доступно
    if (viewer?.contains(document.activeElement) && document.activeElement !== viewer) return;
    const approve = approveRef.current;
    (approve && !approve.disabled ? approve : viewer)?.focus({ preventScroll: true });
  }, [working, shownId, declining, loaded]);
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
                disabled={working || !approvable || !loaded}
                onClick={(event) => decide(event, () => onApprove(photo, at), true)}
              >
                {approvable ? t.photoApprove : doneLabel(photo)}
              </button>
              {/* Отказ — рамкой: рядом с залитым «Одобрить» его не спутать */}
              <button
                type="button"
                className="btn btn-danger viewer-decline"
                disabled={working || !canDecline(photo) || declining || !loaded}
                onClick={(event) => decide(event, () => onDecline(photo, at), false)}
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
        <div ref={zoom.frame} className={`viewer-frame${zoomed ? " is-zoomed" : ""}`} {...zoom.handlers}>
          {/* Увеличили — самый крупный вариант: мелкое лицо в углу кадра должно быть видно */}
          <img
            key={photo.id}
            ref={zoom.image}
            className="viewer-image"
            src={photoSrc(photo.key, zoomed ? 1920 : 1280)}
            srcSet={zoomed ? undefined : photoSrcSet(photo.key, true)}
            sizes="100vw"
            width={photo.width > 0 ? photo.width : undefined}
            height={photo.height > 0 ? photo.height : undefined}
            alt=""
            decoding="async"
            draggable={false}
            onLoad={() => {
              setShown(photo.id);
              onShown?.(photo.id);
            }}
          />
        </div>
        <figcaption className="viewer-claim">
          <span className="photo-claim">{t.photoAckClaim[photo.ack]}</span>
          {policy ? <span className="photo-rule">{t.photoRule[policy]}</span> : null}
          <button
            type="button"
            className="btn btn-sm viewer-zoom"
            aria-pressed={zoomed}
            onClick={() => zoom.toggle()}
          >
            {zoomed ? t.photoZoomOut : t.photoZoomIn}
          </button>
          {/* Подсказка про клавиши — только где есть мышь (hover); на касаниях — про жесты */}
          <span className="muted small viewer-keys">
            {total > 1 ? t.photoViewerKeys : t.photoViewerZoomKeys}
          </span>
          <span className="muted small viewer-gestures">
            {total > 1 ? t.photoViewerGestures : t.photoViewerZoomGestures}
          </span>
        </figcaption>
      </figure>
      {children}
      {declining ? declineForm : null}
      {failure ? <ErrorText failure={failure} /> : null}
    </Dialog>
  );
}
