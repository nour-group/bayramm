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
import { type Failure, type Loaded, type Result, useLoad, useSession } from "./api";
import { Icon, type IconName } from "./icons";
import { usePhone } from "./layout";
import { hrefOf, type Navigate, type View } from "./router";
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

/** Звено пути к экрану: «Вендоры › Lola · V101 › Lola zali» */
export interface Crumb {
  readonly label: string;
  readonly to: View;
}

/** Путь страницы объекта (хлебные крошки над заголовком на компьютере) — когда загрузилась */
export const CrumbsContext = createContext<(crumbs: readonly Crumb[]) => void>(() => {});

/**
 * Страница объекта называет, где она: раздел и объекты выше (витрина → вендор, заявка →
 * витрина → вендор). Раздел оболочка добавляет сама — здесь только объекты
 */
export function useBreadcrumbs(crumbs: readonly Crumb[]): void {
  const setCrumbs = useContext(CrumbsContext);
  const key = JSON.stringify(crumbs);
  // biome-ignore lint/correctness/useExhaustiveDependencies: key — те же звенья, новый массив не повод
  useEffect(() => setCrumbs(crumbs), [setCrumbs, key]);
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
      href={hrefOf(to)}
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

/**
 * Один цвет на один смысл во всех разделах: good — на сайте, одобрено, действует; outline —
 * ждёт или на проверке; warn — отклонено, заблокировано, просрочено; muted — черновик, снято,
 * закрыто, отключено. strong — не статус, а выбор («Обложка»)
 */
const TONES = {
  listing: {
    lead: "muted",
    draft: "muted",
    review: "outline",
    active: "good",
    suspended: "muted",
    rejected: "warn",
  },
  service: { draft: "muted", review: "outline", active: "good", rejected: "warn", paused: "muted" },
  // Услуга в очереди модерации: и новая, и изменения — на проверке
  serviceQueue: { review: "outline", proposal: "outline" },
  photo: { pending: "outline", approved: "good", declined: "warn" },
  revision: { pending: "outline", approved: "good", declined: "warn", withdrawn: "muted" },
  request: {
    new: "outline",
    viewed: "outline",
    contacted: "good",
    deal: "good",
    declined: "warn",
    withdrawn: "muted",
    expired: "muted",
  },
  sla: {
    waiting: "outline",
    overdue: "warn",
    breached: "warn",
    answered: "good",
    answered_late: "muted",
    ops_contacted: "muted",
    closed: "muted",
  },
  member: { active: "good", inactive: "muted" },
  client: { active: "good", blocked: "warn", deleted: "muted" },
  vendorUser: { pending: "outline", accepted: "good", disabled: "muted" },
} as const satisfies Readonly<Record<string, Readonly<Record<string, Tone>>>>;

export type ToneDomain = keyof typeof TONES;

/** Цвет плашки статуса; неизвестный статус (новее сборки панели) — нейтральный */
export function toneOf(domain: ToneDomain, status: string): Tone {
  const tones: Readonly<Record<string, Tone>> = TONES[domain];
  // Своё свойство, а не унаследованное: статус «constructor» цветом не станет
  return (Object.hasOwn(tones, status) ? tones[status] : undefined) ?? "muted";
}

export function StatusPill({ status }: { status: ListingStatus }) {
  return <Pill tone={toneOf("listing", status)}>{t.status[status]}</Pill>;
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

// ── списки: страницы, «Показать ещё», пустой список ────────────────────────

/** Значение с задержкой: запрос к API — когда человек перестал печатать */
export function useDebounced<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/**
 * Поиск списка: поле меняется сразу, в адрес и в запрос строка уходит, когда перестали
 * печатать (write — записать; новый поиск — с первой страницы). Сброс фильтров чистит поле
 * само: запоздавшая строка поиска не возвращается в адрес
 */
export function useListSearch(initial: string, write: (search: string) => void) {
  const [q, setQ] = useState(initial);
  const search = useDebounced(q.trim());
  const written = useRef(search);
  const writer = useRef(write);
  writer.current = write;
  useEffect(() => {
    if (search === written.current) return;
    written.current = search;
    writer.current(search);
  }, [search]);
  return [q, setQ] as const;
}

/** Ответ списка API: сколько всего и страница (limit, offset) */
export interface Paged<I> {
  readonly total: number;
  readonly items: readonly I[];
}

/** Номер страницы из адреса (?page=2) → сдвиг; кривой номер — первая страница */
export function offsetOf(page: string | undefined, size: number): number {
  const n = Number(page);
  return Number.isSafeInteger(n) && n > 1 ? (n - 1) * size : 0;
}

/**
 * Список страницами, без молчаливой обрезки. Компьютер — по страницам (offset: какую
 * показать — номер страницы в адресе), телефон — «Показать ещё» дописывает следующую
 * страницу к показанным (append). Фильтры сменились или список перечитан — дописанное
 * сбрасывается. path — список с фильтрами, без limit и offset; null — не грузить
 */
export function usePagedList<I, L extends Paged<I> = Paged<I>>(
  path: string | null,
  { size, offset, append }: { readonly size: number; readonly offset: number; readonly append: boolean },
) {
  const { api } = useSession();
  // «/staff/vendors?» без фильтров — limit и offset сразу после «?»
  const join = path === null || path.endsWith("?") ? "" : path.includes("?") ? "&" : "?";
  const page = (from: number) => (path === null ? null : `${path}${join}limit=${size}&offset=${from}`);
  const first = useLoad<L>(page(append ? 0 : offset));
  const data = first.loaded.state === "ready" ? first.loaded.data : null;
  const [more, setMore] = useState<{ readonly base: L | null; readonly items: readonly I[] }>({
    base: null,
    items: [],
  });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const extra = append && data !== null && more.base === data ? more.items : [];
  const items = data === null ? [] : extra.length > 0 ? [...data.items, ...extra] : data.items;

  const loadMore = async () => {
    const next = data === null ? null : page(data.items.length + extra.length);
    if (data === null || next === null) return;
    setBusy(true);
    const result = await api.get<L>(next);
    setBusy(false);
    setFailure(result.ok ? null : result);
    // Пока грузили, фильтры сменились — дописывать не к чему (base уже другой)
    if (result.ok) setMore({ base: data, items: [...extra, ...result.data.items] });
  };

  return {
    ...first,
    /** Показанные строки: страница, а на телефоне — и дописанные */
    items,
    total: data?.total ?? 0,
    more: { busy, failure, load: loadMore },
  } as const;
}

interface PagerProps {
  readonly total: number;
  readonly offset: number;
  readonly size: number;
  readonly onPage: (offset: number) => void;
  /** Подписи кнопок: журнал листают «новее / старше» */
  readonly prevLabel?: string;
  readonly nextLabel?: string;
}

/** Страницы списка на компьютере: «предыдущие · 51–100 из 240 · следующие» */
export function Pager({
  total,
  offset,
  size,
  onPage,
  prevLabel = t.pagerPrev,
  nextLabel = t.pagerNext,
}: PagerProps) {
  if (total <= size && offset === 0) return <p className="muted small">{t.total(total)}</p>;
  return (
    <nav className="pager" aria-label={t.pagerLabel}>
      <button
        type="button"
        className="btn btn-sm"
        disabled={offset === 0}
        onClick={() => onPage(Math.max(0, offset - size))}
      >
        {prevLabel}
      </button>
      <span className="muted small" aria-live="polite">
        {t.pagerRange(Math.min(offset + 1, total), Math.min(offset + size, total), total)}
      </span>
      <button
        type="button"
        className="btn btn-sm"
        disabled={offset + size >= total}
        onClick={() => onPage(offset + size)}
      >
        {nextLabel}
      </button>
    </nav>
  );
}

/** «Показать ещё» на телефоне: следующая страница дописывается под показанными */
export function ShowMore({
  shown,
  total,
  busy,
  failure,
  onMore,
}: {
  readonly shown: number;
  readonly total: number;
  readonly busy: boolean;
  readonly failure: Failure | null;
  readonly onMore: () => void;
}) {
  if (shown >= total) return <p className="muted small">{t.total(total)}</p>;
  return (
    <div className="show-more">
      <p className="muted small" aria-live="polite">
        {t.shownOf(shown, total)}
      </p>
      <button type="button" className="btn" aria-busy={busy || undefined} disabled={busy} onClick={onMore}>
        {busyLabel(t.showMore, busy)}
      </button>
      {failure ? <ErrorText failure={failure} /> : null}
    </div>
  );
}

/**
 * Подвал списка: на телефоне — «Показать ещё», шире — страницы. list — из usePagedList;
 * onPage — сменить страницу (номер — в адресе)
 */
export function ListFooter({
  list,
  offset,
  size,
  onPage,
}: {
  readonly list: {
    readonly items: readonly unknown[];
    readonly total: number;
    readonly more: { readonly busy: boolean; readonly failure: Failure | null; readonly load: () => void };
  };
  readonly offset: number;
  readonly size: number;
  readonly onPage: (offset: number) => void;
}) {
  const phone = usePhone();
  if (phone)
    return (
      <ShowMore
        shown={list.items.length}
        total={list.total}
        busy={list.more.busy}
        failure={list.more.failure}
        onMore={() => void list.more.load()}
      />
    );
  return <Pager total={list.total} offset={offset} size={size} onPage={onPage} />;
}

/**
 * Пустой список. Сузили фильтрами — сказать об этом и дать снять их одной кнопкой: иначе
 * «ничего нет» выглядит как пустая база
 */
export function EmptyList({
  text,
  onReset,
}: {
  readonly text: string;
  readonly onReset?: (() => void) | null;
}) {
  if (!onReset) return <p className="empty">{text}</p>;
  return (
    <div className="empty empty-filtered">
      <p>{text}</p>
      <button type="button" className="btn btn-sm" onClick={onReset}>
        {t.resetFilters}
      </button>
    </div>
  );
}

/** Подпись кнопки, пока идёт запрос: «Одобрить…» — нажатие принято, ждём сервер */
export function busyLabel(label: string, busy: boolean): string {
  return busy ? `${label}…` : label;
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
          className={`btn ${danger ? "btn-danger-fill" : "btn-primary"}`}
          aria-busy={busy || undefined}
          disabled={busy || (required && text.trim() === "")}
        >
          {busyLabel(submitLabel, busy)}
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
        <button
          type="submit"
          className="btn"
          aria-busy={busy || undefined}
          disabled={busy || reason.trim() === ""}
        >
          {busyLabel(t.show, busy)}
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
  // Главной кнопка становится, когда есть что сохранять: иначе на экране два главных действия
  const button = (
    <button
      type="submit"
      form={formId}
      className={`btn${show || busy ? " btn-primary" : ""}`}
      aria-busy={busy || undefined}
      disabled={busy}
    >
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
  // Заголовок без tabIndex фокус не примет: делаем его фокусируемым программно (не по Tab)
  if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
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
