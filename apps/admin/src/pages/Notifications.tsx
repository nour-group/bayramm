/* Уведомления: здоровье очереди бота. Всё доставлено — одна строка; иначе — плитки только тех
   состояний, где что-то есть (и «Не доставлены» всегда), и таблица недоставленного: получатель —
   подпись (имя пользователя кабинета или вендор, имя сотрудника, код клиента), вид и начало id;
   телефонов нет. Повторить недоставленное — администратор. */

import type { OutboxDeadItem, OutboxHealth, OutboxStatus } from "@bayramm/shared/api/staff";
import { useState } from "react";
import { type Failure, useCan, useLoad, useSession } from "../api";
import { formatMoment } from "../format";
import { useLayout } from "../layout";
import { t } from "../texts";
import { ErrorText, Link, LoadedView, TableWrap } from "../ui";

const COUNTS: readonly OutboxStatus[] = ["pending", "sending", "failed", "dead", "sent"];

/** Получатель: главное — кто («Иван П.»), под ним — вид и начало id; без подписи главное — вид */
function recipientOf(item: OutboxDeadItem): { main: string; sub: string } {
  const kind = t.recipientKinds[item.recipientKind] ?? item.recipientKind;
  const ref = item.recipientRef ? `${item.recipientRef}…` : "";
  return item.recipientLabel
    ? { main: item.recipientLabel, sub: [kind, ref].filter(Boolean).join(" · ") }
    : { main: kind, sub: ref };
}

/** В одну строку — карточка на телефоне */
function recipientLine(item: OutboxDeadItem): string {
  const { main, sub } = recipientOf(item);
  return sub ? `${main} · ${sub}` : main;
}

/** Ячейка таблицы: кто — и под ним вид и начало id */
function RecipientCell({ item }: { item: OutboxDeadItem }) {
  const { main, sub } = recipientOf(item);
  return (
    <>
      {main}
      {sub && <span className="sub">{sub}</span>}
    </>
  );
}

export function NotificationsPage() {
  const { loaded, reload, set } = useLoad<OutboxHealth>("/staff/outbox");
  return (
    <LoadedView loaded={loaded} onRetry={reload} skeleton="stats">
      {(health) => <HealthView health={health} onChange={set} />}
    </LoadedView>
  );
}

/** Очередь пуста и ничего не застряло: тревожиться не о чем, числа — одной строкой */
const healthy = (health: OutboxHealth) =>
  health.counts.dead === 0 &&
  health.counts.failed === 0 &&
  health.counts.pending === 0 &&
  health.counts.sending === 0;

function HealthView({ health, onChange }: { health: OutboxHealth; onChange: (h: OutboxHealth) => void }) {
  if (healthy(health)) return <p className="notice notice-good">{t.outboxHealthy(health.counts.sent)}</p>;
  return (
    <div className="stack">
      <ul className="stats">
        {COUNTS.filter((status) => status === "dead" || health.counts[status] > 0).map((status) => (
          <li
            key={status}
            className={`stat${status === "dead" && health.counts.dead > 0 ? " stat-warn" : ""}`}
          >
            <span className="stat-value">{health.counts[status]}</span>
            <span className="stat-label">{t.outboxCounts[status]}</span>
          </li>
        ))}
      </ul>
      {health.counts.pending > 0 && health.oldestPendingAt && (
        <p className="muted small">{t.outboxOldest(formatMoment(health.oldestPendingAt))}</p>
      )}
      {health.dead.length > 0 && (
        <section className="stack" aria-label={t.outboxDead}>
          <DeadTable items={health.dead} onChange={onChange} />
          {health.deadTotal > health.dead.length && (
            <p className="muted small">{t.outboxShown(health.dead.length, health.deadTotal)}</p>
          )}
        </section>
      )}
    </div>
  );
}

function DeadTable({
  items,
  onChange,
}: {
  items: readonly OutboxDeadItem[];
  onChange: (h: OutboxHealth) => void;
}) {
  const { api } = useSession();
  const can = useCan();
  // Таблица — только на компьютере: шесть колонок на планшете обрезались бы справа
  const cards = useLayout() !== "desktop";
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  const retry = async (id: string) => {
    setBusy(id);
    const result = await api.post<OutboxHealth>(`/staff/outbox/${id}/retry`);
    setBusy(null);
    setFailure(result.ok ? null : result);
    if (result.ok) onChange(result.data);
  };

  if (cards)
    return (
      <div className="stack">
        {failure && <ErrorText failure={failure} />}
        <ul className="rcards">
          {items.map((item) => (
            <li key={item.id} className="rcard">
              <p className="rcard-title">{t.noticeKinds[item.kind] ?? item.kind}</p>
              {item.request ? (
                <p className="rcard-meta">
                  <Link to={{ name: "request", id: item.request.id }}>
                    {t.requestNo(item.request.publicNo)}
                  </Link>
                </p>
              ) : (
                <p className="rcard-meta">{item.kind}</p>
              )}
              <dl className="rcard-facts">
                <dt>{t.colRecipient}</dt>
                <dd>{recipientLine(item)}</dd>
                <dt>{t.colAttempts}</dt>
                <dd>{item.attempts}</dd>
                <dt>{t.colWhen}</dt>
                <dd>
                  {formatMoment(item.createdAt)}
                  {item.lastAttemptAt ? ` · ${formatMoment(item.lastAttemptAt)}` : ""}
                </dd>
              </dl>
              <p className="rcard-error">{item.error ?? t.none}</p>
              {can("outbox.retry") && (
                <div className="rcard-actions">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => retry(item.id)}
                    disabled={busy !== null}
                    aria-label={t.retryNotice(t.noticeKinds[item.kind] ?? item.kind)}
                  >
                    {t.retry}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    );

  return (
    <div className="stack">
      {failure && <ErrorText failure={failure} />}
      <TableWrap label={t.notifications}>
        <table className="table">
          <thead>
            <tr>
              <th scope="col">{t.colKind}</th>
              <th scope="col">{t.colRecipient}</th>
              <th scope="col">{t.colAttempts}</th>
              <th scope="col">{t.colError}</th>
              <th scope="col">{t.colWhen}</th>
              {can("outbox.retry") && (
                <th scope="col">
                  <span className="visually-hidden">{t.retry}</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>
                  {t.noticeKinds[item.kind] ?? item.kind}
                  <span className="sub">
                    {item.request ? (
                      <Link to={{ name: "request", id: item.request.id }}>
                        {t.requestNo(item.request.publicNo)}
                      </Link>
                    ) : (
                      item.kind
                    )}
                  </span>
                </td>
                <td>
                  <RecipientCell item={item} />
                </td>
                <td>{item.attempts}</td>
                <td className="error-cell">{item.error ?? t.none}</td>
                <td>
                  {formatMoment(item.createdAt)}
                  {item.lastAttemptAt && <span className="sub">{formatMoment(item.lastAttemptAt)}</span>}
                </td>
                {can("outbox.retry") && (
                  <td>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => retry(item.id)}
                      disabled={busy !== null}
                      aria-label={t.retryNotice(t.noticeKinds[item.kind] ?? item.kind)}
                    >
                      {t.retry}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </div>
  );
}
