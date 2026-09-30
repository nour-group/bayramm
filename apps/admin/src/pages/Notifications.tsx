/* Уведомления: здоровье очереди бота — сколько ждёт, сколько не доставлено и почему.
   Получатель — только вид и начало id; повторить недоставленное — администратор. */

import type { OutboxDeadItem, OutboxHealth, OutboxStatus } from "@bayramm/shared/api/staff";
import { useState } from "react";
import { type Failure, useCan, useLoad, useSession } from "../api";
import { formatMoment } from "../format";
import { usePhone } from "../layout";
import { t } from "../texts";
import { ErrorText, Link, LoadedView } from "../ui";

const COUNTS: readonly OutboxStatus[] = ["pending", "sending", "failed", "dead", "sent"];

export function NotificationsPage() {
  const { loaded, reload, set } = useLoad<OutboxHealth>("/staff/outbox");
  return (
    <LoadedView loaded={loaded} onRetry={reload} skeleton="stats">
      {(health) => <HealthView health={health} onChange={set} />}
    </LoadedView>
  );
}

function HealthView({ health, onChange }: { health: OutboxHealth; onChange: (h: OutboxHealth) => void }) {
  return (
    <div className="stack">
      <ul className="stats">
        {COUNTS.map((status) => (
          <li
            key={status}
            className={`stat${status === "dead" && health.counts.dead > 0 ? " stat-warn" : ""}`}
          >
            <span className="stat-value">{health.counts[status]}</span>
            <span className="stat-label">{t.outboxCounts[status]}</span>
          </li>
        ))}
      </ul>
      {health.oldestPendingAt && (
        <p className="muted small">{t.outboxOldest(formatMoment(health.oldestPendingAt))}</p>
      )}
      <section className="panel" aria-labelledby="dead-title">
        <h2 id="dead-title">
          {t.outboxDead} <span className="count">{health.deadTotal}</span>
        </h2>
        <p className="muted small">{t.outboxDeadHint}</p>
        {health.dead.length === 0 ? (
          <p className="empty">{t.outboxDeadEmpty}</p>
        ) : (
          <DeadTable items={health.dead} onChange={onChange} />
        )}
        {health.deadTotal > health.dead.length && (
          <p className="muted small">{t.outboxShown(health.dead.length, health.deadTotal)}</p>
        )}
      </section>
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
  const phone = usePhone();
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  const retry = async (id: string) => {
    setBusy(id);
    const result = await api.post<OutboxHealth>(`/staff/outbox/${id}/retry`);
    setBusy(null);
    setFailure(result.ok ? null : result);
    if (result.ok) onChange(result.data);
  };

  if (phone)
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
                <dd>
                  {t.recipientKinds[item.recipientKind] ?? item.recipientKind}
                  {item.recipientRef ? ` · ${item.recipientRef}…` : ""}
                </dd>
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
      <div className="table-wrap">
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
                  {t.recipientKinds[item.recipientKind] ?? item.recipientKind}
                  {item.recipientRef && <span className="sub">{item.recipientRef}…</span>}
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
                    >
                      {t.retry}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
