/* Общие детали экранов панели: ссылки без перезагрузки, плашки статусов, поля форм,
   сообщения об ошибках, «показать телефон». Цвета — только токены (styles.css). */

import { formatUzPhone } from "@bayramm/shared";
import type { ListingStatus, PublishBlocker } from "@bayramm/shared/api/staff";
import {
  createContext,
  type FormEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useState,
} from "react";
import type { Failure, Loaded, Result } from "./api";
import { type Navigate, pathOf, type View } from "./router";
import { apiErrorText, t } from "./texts";

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
}

/** Ссылка на экран панели: обычный <a> (новая вкладка работает), переход — без перезагрузки */
export function Link({ to, className, children, current }: LinkProps) {
  const navigate = useNavigate();
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
  };
  return (
    <a href={pathOf(to)} className={className} aria-current={current ? "page" : undefined} onClick={onClick}>
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

export function ErrorText({ failure }: { failure: Pick<Failure, "code"> }) {
  return (
    <p className="notice notice-error" role="alert">
      {apiErrorText(failure.code)}
    </p>
  );
}

interface LoadedViewProps<T> {
  loaded: Loaded<T>;
  onRetry: () => void;
  children: (data: T) => ReactNode;
}

/** Пока грузится — статус, ошибка — текст и «Повторить», данные — children */
export function LoadedView<T>({ loaded, onRetry, children }: LoadedViewProps<T>) {
  if (loaded.state === "loading")
    return (
      <p className="muted" role="status">
        {t.loading}
      </p>
    );
  if (loaded.state === "error")
    return (
      <div className="stack">
        <ErrorText failure={loaded.failure} />
        <div>
          <button type="button" className="btn" onClick={onRetry}>
            {t.retry}
          </button>
        </div>
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
    <form className="confirm" onSubmit={reveal} noValidate>
      <p className="muted small">{hint}</p>
      <label htmlFor={reasonId}>{reasonLabel}</label>
      <input
        id={reasonId}
        className="input"
        value={reason}
        maxLength={500}
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
