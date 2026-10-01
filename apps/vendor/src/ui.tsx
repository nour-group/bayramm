/* Общие куски экранов: заголовок, загрузка, ошибка с повтором, пустое состояние, чип статуса. */

import type { RequestStatus } from "@bayramm/shared/api/vendor";
import type { ReactNode, Ref } from "react";
import { errorText, isRetryable } from "./errors";
import { textOf, type VendorDict } from "./i18n";
import { Icon, type IconName } from "./icons";

export interface ScreenProps {
  readonly t: VendorDict;
  readonly lang: "ru" | "uz";
  /**
   * Заголовок экрана: на него переходит фокус после перехода (для диктора). Ref-функция:
   * экран, который ещё грузится, получит фокус, когда заголовок появится
   */
  readonly headingRef: Ref<HTMLHeadingElement>;
}

interface HeadingProps {
  readonly headingRef?: ScreenProps["headingRef"];
  /** Заголовок карточки заявки рядом со списком (компьютер) — h2 под h1 «Заявки» */
  readonly level?: 1 | 2;
  readonly id?: string;
  readonly children: ReactNode;
}

export function Heading({ headingRef, level = 1, id = "page-title", children }: HeadingProps) {
  const Tag = level === 1 ? "h1" : "h2";
  return (
    <Tag id={id} className="page-title" ref={headingRef} tabIndex={-1}>
      {children}
    </Tag>
  );
}

/**
 * Пока грузится: заготовка той же формы, что и содержимое (список, карточка, месяц), — экран
 * не прыгает, когда данные придут. Диктору — «Загрузка…»
 */
export function Loading({ t, kind = "line" }: { t: VendorDict; kind?: "line" | "list" | "card" | "month" }) {
  if (kind === "line") {
    return (
      <p className="status-line" role="status">
        {t.loading}
      </p>
    );
  }
  const rows = kind === "list" ? 3 : kind === "card" ? 2 : 1;
  return (
    <div className={`skeleton skeleton-${kind}`} role="status" aria-busy="true">
      <span className="sr-only">{t.loading}</span>
      {Array.from({ length: rows }, (_, i) => i).map((i) => (
        <span key={i} className="sk-block" aria-hidden="true">
          <span className="sk-line sk-line-title" />
          <span className="sk-line" />
          <span className="sk-line sk-line-short" />
        </span>
      ))}
    </div>
  );
}

/**
 * Не загрузилось. Нет связи, сбой сервера, лимит — «Повторить» (и повтор сам, когда связь
 * вернётся); нет доступа, не найдено — что случилось, без мёртвой кнопки повтора
 */
export function LoadError({ t, onRetry, error }: { t: VendorDict; onRetry: () => void; error?: unknown }) {
  const retryable = error === undefined || isRetryable(error);
  return (
    <div className="notice notice-error" role="alert">
      <p>{retryable ? t.loadFailed : errorText(error, t)}</p>
      {retryable ? (
        <button type="button" className="btn btn-ghost" onClick={onRetry}>
          {t.retry}
        </button>
      ) : null}
    </div>
  );
}

export function Empty({ icon, title, text }: { icon: IconName; title: string; text: string }) {
  return (
    <div className="empty">
      <span className="empty-art">
        <Icon name={icon} size={26} />
      </span>
      <h2 className="empty-title">{title}</h2>
      <p className="empty-text">{text}</p>
    </div>
  );
}

/** Цвет чипа по смыслу статуса: ждёт — нейтральный, сделка — успех, отказ и конец — приглушённый */
const CHIP_TONE: Readonly<Record<RequestStatus, "wait" | "work" | "done" | "off">> = {
  new: "wait",
  viewed: "wait",
  contacted: "work",
  deal: "done",
  declined: "off",
  withdrawn: "off",
  expired: "off",
};

export function StatusChip({ status, late, t }: { status: RequestStatus; late: boolean; t: VendorDict }) {
  if (late) return <span className="chip chip-late">{t.late}</span>;
  return <span className={`chip chip-${CHIP_TONE[status]}`}>{textOf(t, `st_${status}`)}</span>;
}
