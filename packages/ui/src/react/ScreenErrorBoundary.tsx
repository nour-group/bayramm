/* Экран, который не открылся: кусок сборки не загрузился (нет связи, после выкладки старого
   куска на сервере уже нет) или экран упал при отрисовке. Вместо пустой страницы — строка и
   «Повторить»; связь вернулась — повтор сам. Сменился экран (resetKey) — ошибка прежнего
   забыта, новый грузится как обычно.

   Куска нет на сервере (404 после выкладки) — одна перезагрузка страницы: новая сборка знает
   новые имена кусков. Отметка во вкладке (sessionStorage) не даёт перезагружаться чаще раза
   в минуту — битая выкладка не закрутит страницу; дальше «Повторить» перезагружает по
   нажатию.

   React.lazy запоминает отказ import() навсегда — повтор с ним невозможен. Поэтому экраны
   строятся на retryableLazy: после отказа, на следующей попытке границы, загрузка начинается
   заново (как part() кабинета). Слов в наборе нет: тексты — пропсами. */

import {
  Component,
  type ComponentType,
  createContext,
  createElement,
  type ErrorInfo,
  type LazyExoticComponent,
  lazy,
  type ReactNode,
  useContext,
} from "react";
import { useOnReconnect } from "./online";

export interface ScreenErrorTexts {
  /** Что случилось и что делать: «Не удалось загрузить. Проверьте интернет…» */
  readonly message: string;
  /** Кнопка повтора */
  readonly retry: string;
}

export interface ScreenErrorBoundaryProps {
  readonly texts: ScreenErrorTexts;
  /** Сменился экран (адрес, номер перехода) — ошибка прежнего забыта */
  readonly resetKey?: unknown;
  /** Перезагрузка страницы (тесты подменяют) */
  readonly reload?: () => void;
  readonly children: ReactNode;
}

interface State {
  readonly failed: boolean;
  readonly error: unknown;
  /** Номер попытки: retryableLazy начинает загрузку заново, когда он сменился */
  readonly attempt: number;
  readonly key: unknown;
  /** Куска нет на сервере (404): «Повторить» перезагружает страницу */
  readonly missing: boolean;
}

// Номер попытки границы над экраном; без границы — 0, и повтора нет (как у React.lazy).
// Номера сквозные на страницу: новая граница (оболочку смонтировали заново) — тоже новая попытка
const AttemptContext = createContext(0);
let attempts = 0;
const nextAttempt = () => ++attempts;

const RELOAD_FLAG = "bayramm:chunk-reload";
const RELOAD_PAUSE_MS = 60_000;

const CHUNK_ERROR =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|Loading (?:CSS )?chunk [\w-]+ failed/i;

/** Отказ загрузки куска сборки (import() или его CSS), а не ошибка в самом экране */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "ChunkLoadError" || CHUNK_ERROR.test(error.message);
}

/** Адрес куска из текста ошибки (Chromium и Firefox его пишут, Safari — нет) */
export function chunkUrlOf(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const found = /(https?:\/\/[^\s'"]+|\/assets\/[^\s'"]+)/.exec(error.message)?.[1];
  if (!found) return null;
  // Знаки препинания после адреса — не его часть (без регулярного выражения: строка чужая)
  let end = found.length;
  while (end > 0 && ".,;)".includes(found.charAt(end - 1))) end -= 1;
  return found.slice(0, end);
}

function online(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

/** Куска нет на сервере: ответ 404 (у /assets/* — 404 no-store, а не index.html) */
async function isMissing(url: string): Promise<boolean> {
  if (typeof fetch !== "function") return false;
  try {
    const response = await fetch(url, { method: "HEAD", cache: "no-store" });
    return response.status === 404;
  } catch {
    return false;
  }
}

function readFlag(): number {
  try {
    return Number(sessionStorage.getItem(RELOAD_FLAG)) || 0;
  } catch {
    return 0;
  }
}

/** Можно ли перезагрузить сами: не перезагружались в этой вкладке последнюю минуту */
function mayReload(now: number): boolean {
  const last = readFlag();
  if (now - last < RELOAD_PAUSE_MS) return false;
  try {
    sessionStorage.setItem(RELOAD_FLAG, String(now));
    return true;
  } catch {
    // Хранилища нет — отметку не поставить, а без неё перезагрузка может пойти по кругу
    return false;
  }
}

function defaultReload(): void {
  if (typeof location !== "undefined" && typeof location.reload === "function") location.reload();
}

/**
 * Граница экрана: ошибка загрузки куска или отрисовки — строка с «Повторить» вместо пустой
 * страницы. Ставится над Suspense экрана
 */
export class ScreenErrorBoundary extends Component<ScreenErrorBoundaryProps, State> {
  override state: State = {
    failed: false,
    error: null,
    attempt: nextAttempt(),
    key: this.props.resetKey,
    missing: false,
  };
  private alive = false;

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { failed: true, error, missing: false };
  }

  static getDerivedStateFromProps(props: ScreenErrorBoundaryProps, state: State): Partial<State> | null {
    if (Object.is(props.resetKey, state.key)) return null;
    // Новый экран — с чистого листа; номер попытки меняется, чтобы упавший раньше кусок грузился заново
    return { key: props.resetKey, failed: false, error: null, missing: false, attempt: nextAttempt() };
  }

  override componentDidMount(): void {
    this.alive = true;
  }

  override componentWillUnmount(): void {
    this.alive = false;
  }

  override componentDidCatch(error: unknown, _info: ErrorInfo): void {
    if (!isChunkLoadError(error) || !online()) return;
    const url = chunkUrlOf(error);
    // Safari адреса не пишет: при живой сети считаем, что куска нет
    void (url ? isMissing(url) : Promise.resolve(true)).then((missing) => {
      if (!missing || !this.alive || this.state.error !== error) return;
      if (mayReload(Date.now())) (this.props.reload ?? defaultReload)();
      else this.setState({ missing: true });
    });
  }

  private readonly retry = (): void => {
    if (this.state.missing) {
      (this.props.reload ?? defaultReload)();
      return;
    }
    this.setState({ failed: false, error: null, attempt: nextAttempt() });
  };

  override render(): ReactNode {
    const { failed, error, attempt } = this.state;
    if (failed)
      return <ScreenError texts={this.props.texts} onRetry={this.retry} auto={isChunkLoadError(error)} />;
    return <AttemptContext.Provider value={attempt}>{this.props.children}</AttemptContext.Provider>;
  }
}

function ScreenError({
  texts,
  onRetry,
  auto,
}: {
  texts: ScreenErrorTexts;
  onRetry: () => void;
  /** Повторить самим, когда связь вернулась (кусок не загрузился) */
  auto: boolean;
}) {
  useOnReconnect(() => {
    if (auto) onRetry();
  });
  return (
    <div className="ui-screen-error" role="alert">
      <p className="ui-screen-error-text">{texts.message}</p>
      <button type="button" className="ui-btn ui-btn-secondary" onClick={onRetry}>
        {texts.retry}
      </button>
    </div>
  );
}

/**
 * React.lazy с повтором: отказ загрузки уходит границе (ScreenErrorBoundary), а следующая
 * её попытка начинает import() заново. Без границы — как React.lazy
 */
// biome-ignore lint/suspicious/noExplicitAny: как у React.lazy — свойства экрана любые
export function retryableLazy<T extends ComponentType<any>>(load: () => Promise<{ default: T }>): T {
  let failed = false;
  // Попытка границы, на которой начата текущая загрузка (null — ещё не рисовали)
  let startedAt: number | null = null;
  const make = (): LazyExoticComponent<T> =>
    lazy(() =>
      load().catch((error: unknown) => {
        failed = true;
        throw error;
      }),
    );
  let current = make();

  function Retryable(props: object) {
    const attempt = useContext(AttemptContext);
    startedAt ??= attempt;
    // Та же попытка — отказ должен дойти до границы; новая — грузим заново
    if (failed && attempt !== startedAt) {
      failed = false;
      startedAt = attempt;
      current = make();
    }
    return createElement(current as unknown as ComponentType<object>, props);
  }
  return Retryable as unknown as T;
}
