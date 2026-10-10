/* Диалог и подтверждение вместо window.confirm/alert и родного <dialog> (его нет в старых
   вебвью iOS, а системные окна в Telegram выглядят чужими и блокируют весь клиент).
   На телефоне — шторка снизу над безопасной зоной, шире 560px — карточка по центру.
   Модальный: страница под ним inert, Tab ходит по кругу внутри, Esc и подложка закрывают,
   фокус возвращается туда, откуда открыли, без прокрутки. */

import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { focusQuietly, surroundings, trapTab, useModal } from "./overlay";

export interface DialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  /** Текст и поля диалога */
  readonly children?: ReactNode;
  /** Кнопки внизу: две — одной ширины */
  readonly actions?: ReactNode;
  /** alertdialog — подтверждение, требующее ответа */
  readonly role?: "dialog" | "alertdialog";
  /** Что получит фокус при открытии; по умолчанию — сам диалог */
  readonly initialFocus?: RefObject<HTMLElement | null>;
  /** Куда вернуть фокус; по умолчанию — туда, где он был при открытии */
  readonly returnFocus?: RefObject<HTMLElement | null>;
  readonly className?: string;
}

export function Dialog({ open, ...props }: DialogProps) {
  return open ? <DialogLayer {...props} /> : null;
}

function DialogLayer({
  onClose,
  title,
  children,
  actions,
  role = "dialog",
  initialFocus,
  returnFocus,
  className,
}: Omit<DialogProps, "open">) {
  const layer = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const [origin] = useState(
    () =>
      returnFocus?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null),
  );
  const [around] = useState(() => surroundings(origin));
  const close = useRef(onClose);
  close.current = onClose;
  const back = useRef(returnFocus);
  back.current = returnFocus;
  const first = useRef(initialFocus);

  useModal(layer, true);
  // Снимается после inert: фокус вернётся на уже доступную кнопку
  useEffect(() => () => focusQuietly(back.current?.current ?? origin), [origin]);
  useLayoutEffect(() => {
    focusQuietly(first.current?.current ?? panel.current);
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" || event.key === "Esc") {
      event.preventDefault();
      event.stopPropagation();
      close.current();
    } else if (event.key === "Tab") trapTab(event, panel.current);
  };

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: слой только ловит всплывающие Esc и Tab диалога
    <div ref={layer} className="ui-layer" data-theme={around.theme} lang={around.lang} onKeyDown={onKeyDown}>
      {/* Подложка — для пальца и мыши; с клавиатуры закрывает Esc */}
      <div className="ui-scrim" aria-hidden="true" onClick={() => close.current()} />
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: role — dialog или alertdialog, aria-modal у обоих */}
      <div
        ref={panel}
        className={`ui-dialog ${className ?? ""}`.trim()}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={children ? bodyId : undefined}
        tabIndex={-1}
      >
        <span className="ui-sheet-grab" aria-hidden="true" />
        <h2 className="ui-dialog-title" id={titleId}>
          {title}
        </h2>
        {children ? (
          <div className="ui-dialog-body" id={bodyId}>
            {children}
          </div>
        ) : null}
        {actions ? <div className="ui-dialog-actions">{actions}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

export interface ConfirmSheetProps {
  readonly open: boolean;
  readonly title: string;
  readonly text?: ReactNode;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  /** danger — удаление, отзыв, отказ: кнопка подтверждения цвета ошибки */
  readonly tone?: "default" | "danger";
  /** Идёт запрос: кнопки недоступны, диалог не закрывается */
  readonly busy?: boolean;
  /** Подтвердить пока нельзя (не вписан код подтверждения, действие запрещено): отмена доступна */
  readonly confirmDisabled?: boolean;
  /** Ошибка запроса — под текстом, с role="alert" */
  readonly error?: ReactNode;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly returnFocus?: RefObject<HTMLElement | null>;
}

/**
 * Подтверждение вместо window.confirm. Две кнопки одной ширины и высоты (отказ не меньше
 * согласия — правило продукта), фокус сначала на отмене: Enter по привычке ничего не удалит
 */
export function ConfirmSheet({
  open,
  title,
  text,
  confirmLabel,
  cancelLabel,
  tone = "default",
  busy = false,
  confirmDisabled = false,
  error,
  onConfirm,
  onCancel,
  returnFocus,
}: ConfirmSheetProps) {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={open}
      role="alertdialog"
      title={title}
      initialFocus={cancel}
      returnFocus={returnFocus}
      onClose={() => {
        if (!busy) onCancel();
      }}
      actions={
        <>
          <button
            ref={cancel}
            type="button"
            className="ui-btn ui-btn-secondary"
            disabled={busy}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={tone === "danger" ? "ui-btn ui-btn-danger" : "ui-btn ui-btn-primary"}
            disabled={busy || confirmDisabled}
            aria-busy={busy || undefined}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      {text || error ? (
        <>
          {text ? <div className="ui-dialog-text">{text}</div> : null}
          {error ? (
            <p className="ui-dialog-error" role="alert">
              {error}
            </p>
          ) : null}
        </>
      ) : null}
    </Dialog>
  );
}
