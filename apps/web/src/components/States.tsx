import type { ReactNode } from "react";
import { useLang } from "../context";

/** Загрузка: текст для диктора, на экране — полоса-скелет */
export function Loading({ label }: { label?: string }) {
  const { t } = useLang();
  return (
    <div className="state state-loading" role="status">
      <span className="skeleton" aria-hidden="true" />
      <span className="skeleton short" aria-hidden="true" />
      <span className="sr-only">{label ?? t.loading}</span>
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
