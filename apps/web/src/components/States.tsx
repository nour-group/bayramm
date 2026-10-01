import type { ReactNode } from "react";
import { useLang } from "../context";

/**
 * Загрузка: текст для диктора, на экране — полоса-скелет. screen — грузится весь экран:
 * заглушка на высоту окна, чтобы подвал не показался и не уехал вниз, когда придут данные
 * (сдвиг вёрстки)
 */
export function Loading({ label, screen = false }: { label?: string; screen?: boolean }) {
  const { t } = useLang();
  return (
    <div className={screen ? "state state-loading state-screen" : "state state-loading"} role="status">
      <span className="skeleton" aria-hidden="true" />
      <span className="skeleton short" aria-hidden="true" />
      <span className="sr-only">{label ?? t.loading}</span>
    </div>
  );
}

/**
 * Загрузка списка карточек: заготовки той же формы и сетки, что карточки, — на месте будущей
 * выдачи, без сдвига, когда она придёт
 */
export function CardsLoading({ count = 4 }: { count?: number }) {
  const { t } = useLang();
  return (
    <div className="state-cards" role="status">
      <ul className="cards" aria-hidden="true">
        {Array.from({ length: count }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: заготовки одинаковые, порядок постоянный
          <li key={i} className="card-skeleton">
            <span className="card-skeleton-photo" />
            <span className="card-skeleton-body" />
          </li>
        ))}
      </ul>
      <span className="sr-only">{t.loading}</span>
    </div>
  );
}

/** Ошибка загрузки с «Повторить» */
export function ErrorState({ message, onRetry }: { message?: string; onRetry: () => void }) {
  const { t } = useLang();
  return (
    <div className="state state-error" role="alert">
      <p>{message ?? t.errLoad}</p>
      <button type="button" className="btn btn-secondary" onClick={onRetry}>
        {t.retry}
      </button>
    </div>
  );
}

/** Пустое состояние: узор гириха как иллюстрация — над текстом, не за ним */
export function EmptyState({
  title,
  text,
  action,
  headingLevel = 2,
}: {
  title: string;
  text: string;
  action?: ReactNode;
  headingLevel?: 1 | 2;
}) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return (
    <div className="state state-empty">
      <span className="girih" aria-hidden="true" />
      <Heading className="state-title" tabIndex={headingLevel === 1 ? -1 : undefined}>
        {title}
      </Heading>
      <p>{text}</p>
      {action}
    </div>
  );
}
