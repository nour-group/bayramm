/* Общие детали экранов панели: ссылки без перезагрузки, плашки статусов, поля форм,
   сообщения об ошибках, «показать телефон». Цвета — только токены (styles.css). */

import { formatUzPhone } from "@bayramm/shared";
import type { ListingStatus, PublishBlocker, RevealedListingContacts } from "@bayramm/shared/api/staff";
import { Dialog } from "@bayramm/ui/react";
import {
  createContext,
  type FormEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { Failure, Loaded, Result } from "./api";
import { Icon, type IconName } from "./icons";
import { usePhone } from "./layout";
import { type Navigate, pathOf, type View } from "./router";
import { apiErrorText, t } from "./texts";
import { useUnsaved } from "./unsaved";

// ── переходы ───────────────────────────────────────────────────────────────

export const NavigateContext = createContext<Navigate>(() => {});

export function useNavigate(): Navigate {
  return useContext(NavigateContext);
}

/** Заголовок страницы объекта: название вендора, карточки, номер заявки — когда загрузились */
export const TitleContext = createContext<(title: string | null) => void>(() => {});

export function useEntityTitle(title: string): void {
  const setTitle = useContext(TitleContext);
  useEffect(() => setTitle(title), [setTitle, title]);
}

interface LinkProps {
  to: View;
  className?: string;
  children: ReactNode;
  current?: boolean;
  /** После перехода внутри панели (закрыть шторку «Ещё») */
  onNavigate?: () => void;
  /** Заранее подгрузить экран: палец коснулся ссылки, на неё навели или перешли Tab */
  onPrefetch?: () => void;
}

/** Ссылка на экран панели: обычный <a> (новая вкладка работает), переход — без перезагрузки */
export function Link({ to, className, children, current, onNavigate, onPrefetch }: LinkProps) {
  const navigate = useNavigate();
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
    onNavigate?.();
  };
  return (
    <a
      href={pathOf(to)}
      className={className}
      aria-current={current ? "page" : undefined}
      onClick={onClick}
      onTouchStart={onPrefetch}
      onMouseEnter={onPrefetch}
      onFocus={onPrefetch}
    >
      {children}
    </a>
  );
}

// ── плашки ─────────────────────────────────────────────────────────────────

export type Tone = "strong" | "outline" | "muted" | "warn" | "good";

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

const STATUS_TONE: Record<ListingStatus, Tone> = {
  lead: "muted",
  draft: "muted",
  review: "outline",
  active: "strong",
  suspended: "warn",
  rejected: "warn",
};

export function StatusPill({ status }: { status: ListingStatus }) {
  return <Pill tone={STATUS_TONE[status]}>{t.status[status]}</Pill>;
}

// ── состояния загрузки и ошибки ────────────────────────────────────────────

/**
 * Ошибка API словами. Не хватает данных для проверки или публикации (publish_blocked) — и
 * пункты, которых не хватает, из ответа сервера: он знает о карточке больше, чем экран
 */
export function ErrorText({
  failure,
}: {
  failure: Pick<Failure, "code"> & { readonly details?: readonly string[] };
}) {
  const missing = failure.code === "publish_blocked" ? (failure.details ?? []) : [];
  if (missing.length === 0)
    return (
      <p className="notice notice-error" role="alert">
        {apiErrorText(failure.code)}
      </p>
    );
  return (
    <div className="notice notice-error" role="alert">
      <p className="notice-title">{apiErrorText(failure.code)}</p>
      <ul className="blockers">
        {missing.map((code) => (
          <li key={code}>{t.blockers[code] ?? code}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Отказ удалить (listing_in_use, vendor_in_use): у причины кодом (details) — свои слова и что
 * сделать вместо; иначе — текст ошибки по коду
 */
export function deleteFailureText(
  failure: Pick<Failure, "code" | "details">,
  reasons: Readonly<Record<string, string>>,
): string {
  const reason = failure.details[0];
  return (reason === undefined ? undefined : reasons[reason]) ?? apiErrorText(failure.code);
}

/** Повтор может помочь: нет связи, сбой сервера, лимит частоты. 403 и 404 повтор не исправит */
export function isRetryable(failure: Pick<Failure, "status">): boolean {
  return failure.status === 0 || failure.status === 429 || failure.status >= 500;
}

export type SkeletonKind = "list" | "detail" | "stats" | "block";

const SKELETON_ROWS: Record<SkeletonKind, number> = { list: 4, detail: 3, stats: 0, block: 1 };

/**
 * Заготовка экрана, пока грузятся данные: полосы той же формы, что и содержимое, —
 * страница не прыгает, когда оно придёт. Диктору — «Загружаем…» (role="status")
 */
export function Skeleton({ kind = "list" }: { kind?: SkeletonKind | undefined }) {
  return (
    <div className={`skeleton skeleton-${kind}`} role="status" aria-busy="true">
      <span className="visually-hidden">{t.loading}</span>
      {kind === "stats" ? (
        <span className="sk-tiles" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className="sk-tile" />
          ))}
        </span>
      ) : null}
      {Array.from({ length: SKELETON_ROWS[kind] }, (_, i) => i).map((i) => (
        <span key={i} className="sk-card" aria-hidden="true">
          <span className="sk-line sk-line-title" />
          <span className="sk-line" />
          <span className="sk-line sk-line-short" />
        </span>
      ))}
    </div>
  );
}

interface LoadedViewProps<T> {
  loaded: Loaded<T>;
  onRetry: () => void;
  children: (data: T) => ReactNode;
  /** Какую заготовку показать, пока грузится */
  skeleton?: SkeletonKind;
}

/**
 * Пока грузится — заготовка, ошибка — текст и «Повторить» (только где повтор поможет: без
 * мёртвой кнопки на «нет прав» и «не найдено»), данные — children
 */
export function LoadedView<T>({ loaded, onRetry, children, skeleton }: LoadedViewProps<T>) {
  if (loaded.state === "loading") return <Skeleton kind={skeleton} />;
  if (loaded.state === "error")
    return (
      <div className="stack">
        <ErrorText failure={loaded.failure} />
        {isRetryable(loaded.failure) ? (
          <div>
            <button type="button" className="btn" onClick={onRetry}>
              {t.retry}
            </button>
          </div>
        ) : null}
      </div>
    );
  return <>{children(loaded.data)}</>;
}

// ── поля формы ─────────────────────────────────────────────────────────────

interface FieldProps {
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
  full?: boolean;
  children: (props: { id: string; "aria-invalid": boolean; "aria-describedby"?: string }) => ReactNode;
}

/** Поле с подписью, подсказкой и ошибкой; id и aria-* связывает само */
export function Field({ label, error, hint, full, children }: FieldProps) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error ?? hint;
  return (
    <div className={`field${full ? " field-full" : ""}${error ? " field-bad" : ""}`}>
      <label htmlFor={id}>{label}</label>
      {children({ id, "aria-invalid": Boolean(error), ...(note ? { "aria-describedby": noteId } : {}) })}
      {note && (
        <span id={noteId} className={error ? "field-error" : "field-hint"}>
          {note}
        </span>
      )}
    </div>
  );
}

/** Ошибки полей из ответа 422: имя поля → текст (или общий «проверьте поле») */
export function fieldErrors(failure: Failure | null, texts: Record<string, string>): Record<string, string> {
  if (failure?.code !== "invalid_input") return {};
  const errors: Record<string, string> = {};
  for (const field of failure.details) {
    const key = field.split(".")[0] ?? field;
    errors[key] = texts[key] ?? t.api.invalid_input ?? "";
  }
  return errors;
}

// ── чего не хватает ────────────────────────────────────────────────────────

/**
 * Блокеры публикации глазами модератора: «Опубликовать» само одобряет готовые фото,
 * ждущие решения, — поэтому фото не мешают, если не отклонённых хватает до минимума
 */
export function publishBlockers(
  codes: readonly PublishBlocker[],
  approvablePhotos: number,
  minPhotos: number,
): PublishBlocker[] {
  return codes.filter((code) => code !== "photos" || approvablePhotos < minPhotos);
}

export function Blockers({ title, codes }: { title: string; codes: readonly (PublishBlocker | string)[] }) {
  if (codes.length === 0) return null;
  return (
    <div className="notice notice-warn">
      <p className="notice-title">{title}</p>
      <ul className="blockers">
        {codes.map((code) => (
          <li key={code}>{t.blockers[code] ?? code}</li>
        ))}
      </ul>
    </div>
  );
}

// ── подтверждение действия ─────────────────────────────────────────────────

interface ConfirmFormProps {
  /** Что произойдёт — над полем */
  hint: string;
  submitLabel: string;
  /** Подпись поля причины или комментария; нет — подтверждение без текста */
  label?: string;
  /** Без текста не отправить (причина обязательна) */
  required?: boolean;
  maxLength?: number;
  danger?: boolean;
  /** Ответ сервера: null — готово (форма закрывается), иначе ошибка под формой */
  onSubmit: (text: string) => Promise<Failure | null>;
  onCancel: () => void;
}

/**
 * Подтверждение в самой панели (не window.confirm): пояснение, необязательное поле причины,
 * «выполнить» и «отмена». Причина обязательна — кнопка неактивна, пока поле пустое
 */
export function ConfirmForm({
  hint,
  submitLabel,
  label,
  required = false,
  maxLength = 1000,
  danger = false,
  onSubmit,
  onCancel,
}: ConfirmFormProps) {
  const id = useId();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  // Вписанная причина или комментарий — несохранённое: уход со страницы переспросит
  useUnsaved(text.trim() !== "");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const result = await onSubmit(text.trim());
    setBusy(false);
    setFailure(result);
    if (result === null) setText("");
  };

  return (
    <form className="confirm" onSubmit={submit} noValidate>
      <p className="muted small">{hint}</p>
      {label !== undefined && (
        <>
          <label htmlFor={id}>{required ? label : `${label} (${t.optional})`}</label>
          <textarea
            id={id}
            className="input"
            rows={2}
            maxLength={maxLength}
            value={text}
            onChange={(event) => setText(event.target.value)}
            required={required}
          />
        </>
      )}
      <div className="acts">
        <button
          type="submit"
          className={`btn ${danger ? "btn-danger" : "btn-primary"}`}
          disabled={busy || (required && text.trim() === "")}
        >
          {submitLabel}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          {t.cancel}
        </button>
      </div>
      {failure &&
        (failure.code === "invalid_input" ? (
          <p className="field-error" role="alert">
            {apiErrorText("reason_required")}
          </p>
        ) : (
          <ErrorText failure={failure} />
        ))}
    </form>
  );
}

// ── показать телефон ───────────────────────────────────────────────────────

type Reveal =
  | { state: "hidden" }
  | { state: "loading" }
  | { state: "shown"; phone: string | null }
  | {
      state: "error";
      code: string;
    };

interface PhoneRevealProps {
  label: string;
  /** Запрос к API: каждое чтение сервер пишет в журнал доступа к ПДн */
  load: () => Promise<Result<string | null>>;
}

interface ReasonPhoneProps {
  label: string;
  hint: string;
  reasonLabel: string;
  /** Запрос с причиной: база отдаёт номер только администратору и пишет чтение в журнал */
  load: (reason: string) => Promise<Result<string | null>>;
}

/** Телефон клиента: скрыт; показать — только с причиной, её видно в журнале доступа к ПДн */
export function ReasonPhoneReveal({ label, hint, reasonLabel, load }: ReasonPhoneProps) {
  const reasonId = useId();
  const [reason, setReason] = useState("");
  const [phone, setPhone] = useState<string | null | undefined>(undefined);
  const [failure, setFailure] = useState<Pick<Failure, "code"> | null>(null);
  const [busy, setBusy] = useState(false);

  const reveal = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const result = await load(reason);
    setBusy(false);
    setFailure(result.ok ? null : result);
    if (result.ok) setPhone(result.data);
  };

  if (phone !== undefined)
    return (
      <p className="phone-row">
        <span className="phone-label">{label}</span>
        {phone ? (
          <a className="phone-value" href={`tel:${phone}`}>
            {formatUzPhone(phone)}
          </a>
        ) : (
          <span className="muted">{t.notSet}</span>
        )}
      </p>
    );

  return (
    <form className="confirm" onSubmit={reveal} noValidate aria-label={label}>
      {/* Чей номер — словами и до показа: иначе форма причины висит без объяснения */}
      <p className="phone-label">{label}</p>
      <p className="muted small">{hint}</p>
      <label htmlFor={reasonId}>{reasonLabel}</label>
      <input
        id={reasonId}
        className="input"
        value={reason}
        maxLength={500}
        autoComplete="off"
        enterKeyHint="go"
        onChange={(event) => setReason(event.target.value)}
        required
      />
      <div>
        <button type="submit" className="btn" disabled={busy || reason.trim() === ""}>
          {t.show}
        </button>
      </div>
      {failure &&
        (failure.code === "invalid_input" ? (
          <p className="field-error">{apiErrorText("reason_required")}</p>
        ) : (
          <ErrorText failure={failure} />
        ))}
    </form>
  );
}

/** Номер скрыт, пока не нажата «Показать»; показанный — ссылка tel: */
export function PhoneReveal({ label, load }: PhoneRevealProps) {
  const [reveal, setReveal] = useState<Reveal>({ state: "hidden" });
  const onShow = useCallback(async () => {
    setReveal({ state: "loading" });
    const result = await load();
    setReveal(result.ok ? { state: "shown", phone: result.data } : { state: "error", code: result.code });
  }, [load]);

  return (
    <div className="phone-row">
      <span className="phone-label">{label}</span>
      {reveal.state === "shown" ? (
        reveal.phone ? (
          <a className="phone-value" href={`tel:${reveal.phone}`}>
            {formatUzPhone(reveal.phone)}
          </a>
        ) : (
          <span className="muted">{t.notSet}</span>
        )
      ) : (
        <>
          <span className="phone-mask">
            <span aria-hidden="true">+998 •• ••• •• ••</span>
            <span className="visually-hidden">{t.hidden}</span>
          </span>
          <button type="button" className="btn btn-sm" onClick={onShow} disabled={reveal.state === "loading"}>
            {t.show}
          </button>
        </>
      )}
      {reveal.state === "error" && (
        <span className="field-error" role="alert">
          {apiErrorText(reveal.code)}
        </span>
      )}
    </div>
  );
}

type ContactsReveal =
  | { state: "hidden" }
  | { state: "loading" }
  | { state: "shown"; contacts: RevealedListingContacts }
  | { state: "error"; code: string };

interface ContactsRevealProps {
  hasPhone: boolean;
  hasTelegram: boolean;
  /** Одно чтение открывает оба значения: в журнал доступа к ПДн — одна запись */
  load: () => Promise<Result<RevealedListingContacts>>;
}

/**
 * Контакты витрины для клиентов — телефон и Telegram: скрыты, пока не нажали «Показать»
 * (одной кнопкой — оба); телефон — ссылка tel:, Telegram — ссылка на t.me
 */
export function ContactsReveal({ hasPhone, hasTelegram, load }: ContactsRevealProps) {
  const [reveal, setReveal] = useState<ContactsReveal>({ state: "hidden" });
  const onShow = useCallback(async () => {
    setReveal({ state: "loading" });
    const result = await load();
    setReveal(result.ok ? { state: "shown", contacts: result.data } : { state: "error", code: result.code });
  }, [load]);
  const shown = reveal.state === "shown" ? reveal.contacts : null;

  return (
    <div className="contacts-reveal">
      <div className="phone-row">
        <span className="phone-label">{t.listingFields.phone}</span>
        {shown ? (
          shown.phone ? (
            <a className="phone-value" href={`tel:${shown.phone}`}>
              {formatUzPhone(shown.phone)}
            </a>
          ) : (
            <span className="muted">{t.notSet}</span>
          )
        ) : hasPhone ? (
          <span className="phone-mask">
            <span aria-hidden="true">+998 •• ••• •• ••</span>
            <span className="visually-hidden">{t.hidden}</span>
          </span>
        ) : (
          <span className="muted">{t.phoneMissing}</span>
        )}
      </div>
      <div className="phone-row">
        <span className="phone-label">{t.telegramLabel}</span>
        {shown ? (
          shown.telegram ? (
            <a
              className="phone-value"
              href={`https://t.me/${shown.telegram}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              @{shown.telegram}
            </a>
          ) : (
            <span className="muted">{t.notSet}</span>
          )
        ) : hasTelegram ? (
          <span className="phone-mask">
            <span aria-hidden="true">@••••••••</span>
            <span className="visually-hidden">{t.hidden}</span>
          </span>
        ) : (
          <span className="muted">{t.telegramMissing}</span>
        )}
      </div>
      {shown === null && (hasPhone || hasTelegram) ? (
        <div>
          <button type="button" className="btn btn-sm" onClick={onShow} disabled={reveal.state === "loading"}>
            {t.contactsShow}
          </button>
        </div>
      ) : null}
      {reveal.state === "error" && (
        <span className="field-error" role="alert">
          {apiErrorText(reveal.code)}
        </span>
      )}
    </div>
  );
}

// ── телефон: панель действий, шторки, фильтры ─────────────────────────────

/**
 * Место внизу страницы под панель действий: оболочка кладёт его последним в страницу —
 * панель прилипает к низу, пока видна страница, а в конце встаёт на своё место и
 * содержимое не закрывает
 */
export const ActionSlotContext = createContext<HTMLElement | null>(null);

/**
 * Главные действия экрана. На телефоне — панель, прилипшая к низу над нижней навигацией и
 * безопасной зоной; шире — кнопки на месте, как были
 */
export function ActionBar({ label, children }: { label: string; children: ReactNode }) {
  const slot = useContext(ActionSlotContext);
  const phone = usePhone();
  if (phone && slot)
    return createPortal(
      // biome-ignore lint/a11y/useSemanticElements: группа кнопок, а не полей формы
      <div className="actionbar" role="group" aria-label={label}>
        {children}
      </div>,
      slot,
    );
  return <div className="acts">{children}</div>;
}

/**
 * «Сохранить» формы. Шире телефона — полоса, прилипшая к низу формы (как было). На телефоне
 * кнопка — в панели действий внизу экрана (связана с формой атрибутом form), и только когда
 * есть что сохранять (show); «Сохранено» и прочие итоги — строкой в конце формы
 */
export function FormBar({
  formId,
  show,
  busy,
  submitLabel,
  note,
}: {
  formId: string;
  show: boolean;
  busy: boolean;
  submitLabel: string;
  /** Итог последней отправки: «Сохранено», «Отправлено на модерацию» (с role="status") */
  note: ReactNode;
}) {
  const phone = usePhone();
  const button = (
    <button type="submit" form={formId} className="btn btn-primary" disabled={busy}>
      {busy ? t.saving : submitLabel}
    </button>
  );
  if (phone)
    return (
      <>
        {note ? <div className="formbar-note">{note}</div> : null}
        {show || busy ? <ActionBar label={submitLabel}>{button}</ActionBar> : null}
      </>
    );
  return (
    <div className="formbar">
      {note}
      {button}
    </div>
  );
}

/**
 * Форма подтверждения или причины: на телефоне — в шторке снизу (видна целиком, страница
 * под ней inert), шире — на месте, под кнопкой, как было
 */
export function PhoneSheet({
  open,
  title,
  onClose,
  returnFocus,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  returnFocus?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const phone = usePhone();
  if (!open) return null;
  if (!phone) return <>{children}</>;
  return (
    <Dialog open title={title} onClose={onClose} returnFocus={returnFocus} className="sheet-form">
      {children}
    </Dialog>
  );
}

export interface MenuAction {
  readonly key: string;
  readonly label: string;
  readonly icon?: IconName;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly run: () => void;
}

/**
 * «Ещё» — второстепенные действия в шторке. Выбранное действие запускается, когда шторка
 * уже закрылась и вернула фокус на «Ещё»: следующая шторка (подтверждение) откроется от
 * кнопки, а не от исчезнувшего пункта
 */
export function OverflowMenu({
  title,
  actions,
  label = t.more,
  context,
  className = "btn",
  buttonRef,
}: {
  title: string;
  actions: readonly MenuAction[];
  label?: string;
  /** Чьё «Ещё» — для диктора, когда их на экране несколько (фото 2, действия карточки) */
  context?: string;
  className?: string;
  buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const own = useRef<HTMLButtonElement>(null);
  const button = buttonRef ?? own;
  if (actions.length === 0) return null;
  const pick = (action: MenuAction) => {
    setOpen(false);
    setTimeout(action.run, 0);
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`${className} btn-more`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Icon name="more" size={20} />
        <span>
          {label}
          {context ? <span className="visually-hidden">: {context}</span> : null}
        </span>
      </button>
      <Dialog
        open={open}
        title={title}
        onClose={() => setOpen(false)}
        returnFocus={button}
        actions={<SheetClose onClose={() => setOpen(false)} />}
      >
        <ul className="menu">
          {actions.map((action) => (
            <li key={action.key}>
              <button
                type="button"
                className={`menu-item${action.danger ? " menu-danger" : ""}`}
                disabled={action.disabled}
                onClick={() => pick(action)}
              >
                {action.icon ? <Icon name={action.icon} size={20} /> : null}
                <span>{action.label}</span>
              </button>
            </li>
          ))}
        </ul>
      </Dialog>
    </>
  );
}

/**
 * «Закрыть» внизу шторки со списком: закрыть можно и подложкой, и Esc, но диктору на телефоне
 * нужна кнопка
 */
export function SheetClose({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" className="ui-btn ui-btn-secondary sheet-done" onClick={onClose}>
      {t.close}
    </button>
  );
}

/** Кнопка «Фильтры (n)»: на телефоне фильтры и сортировка — в шторке */
export function FilterButton({
  count,
  open,
  onOpen,
  label = t.filters,
}: {
  count: number;
  open: boolean;
  onOpen: () => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      className={`btn btn-filter${count > 0 ? " is-active" : ""}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={onOpen}
    >
      <Icon name="filter" size={17} />
      <span>{count > 0 ? `${label} (${count})` : label}</span>
    </button>
  );
}

/** Выбранный в шторке фильтр — под поиском, нажатие снимает его */
export function ActiveFilter({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <div className="active-filters">
      <button type="button" className="chip chip-clear" aria-label={`${t.reset}: ${label}`} onClick={onClear}>
        <span>{label}</span>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

/**
 * Перейти к блоку страницы по id его заголовка (tabIndex -1): прокрутить к нему и поставить
 * фокус — диктор прочтёт, куда пришли. Фокус без прокрутки (ловушка №3), scrollIntoView есть
 * не везде (№5)
 */
export function focusSection(id: string): void {
  const heading = document.getElementById(id);
  if (!heading) return;
  heading.scrollIntoView?.({ block: "start" });
  heading.focus({ preventScroll: true });
}

/**
 * Первое поле с ошибкой — в видимую часть и в фокус: на телефоне ошибка иначе остаётся
 * за краем экрана. Фокус без прокрутки (ловушка №3), scrollIntoView есть не везде (№5)
 */
export function revealFirstError(root: HTMLElement | null): void {
  const field = root?.querySelector<HTMLElement>('[aria-invalid="true"]');
  if (!field) return;
  field.scrollIntoView?.({ block: "center" });
  field.focus({ preventScroll: true });
}

/** Ответ с ошибками полей — показать первое; ref — на форму */
export function useRevealErrors(failure: Failure | null): RefObject<HTMLFormElement | null> {
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (failure?.code === "invalid_input") revealFirstError(form.current);
  }, [failure]);
  return form;
}
