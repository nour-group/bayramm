/* Карточка заявки. Открытие новой отмечает её просмотренной (это делает API).
   Телефон клиента — сразу, без «разблокировки»; нажатие на него пишется в журнал.
   Действия — ровно те переходы, что разрешает база:
     new/viewed → «Я связался» | «Отказать»;  contacted → «Договорились» | «Не подошло»;
     deal/declined → «Вернуть в активные». Отказ — с причиной; «занято» занимает дату. */

import {
  DECLINE_NOTE_MAX,
  DECLINE_REASONS,
  type DeclineReason,
  type VendorRequestDetail,
  type VendorRequestPatch,
} from "@bayramm/shared/api/vendor";
import { RadioGroup } from "@bayramm/ui/react";
import { type FormEvent, type MouseEvent, useCallback, useId, useState } from "react";
import { ApiFailure, api } from "./api";
import { formatBudget, formatDate, formatGuests, formatMoment, formatPhone, slaView } from "./format";
import { fill, textOf, type VendorDict } from "./i18n";
import { Icon } from "./icons";
import { awaitsAnswer, SlaTimer } from "./Requests";
import type { Navigate } from "./router";
import { useBackButton } from "./telegram";
import { Heading, LoadError, Loading, type ScreenProps, StatusChip } from "./ui";
import { useLoad } from "./useLoad";
import { useNow } from "./useNow";

interface DeclineFormProps {
  readonly t: VendorDict;
  readonly busy: boolean;
  readonly onSubmit: (reason: DeclineReason, note: string) => void;
  readonly onCancel: () => void;
}

function DeclineForm({ t, busy, onSubmit, onCancel }: DeclineFormProps) {
  const [reason, setReason] = useState<DeclineReason | null>(null);
  const [note, setNote] = useState("");
  const noteId = useId();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (reason) onSubmit(reason, note);
  };
  return (
    <form className="panel decline" onSubmit={submit}>
      <fieldset className="choices">
        <legend className="panel-title">{t.declineTitle}</legend>
        <p className="note">{t.declineSub}</p>
        <RadioGroup
          variant="row"
          name="decline-reason"
          value={reason}
          options={DECLINE_REASONS.map((code) => ({ value: code, label: textOf(t, `reason_${code}`) }))}
          onChange={setReason}
        />
      </fieldset>
      {reason === "busy" ? <p className="note">{t.declineBusyNote}</p> : null}
      <label className="field-label" htmlFor={noteId}>
        {t.declineNoteLabel}
      </label>
      <textarea
        id={noteId}
        className="field"
        rows={2}
        maxLength={DECLINE_NOTE_MAX}
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
      <div className="actions">
        <button type="submit" className="btn btn-danger" disabled={reason === null || busy}>
          {t.declineConfirm}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
          {t.cancel}
        </button>
      </div>
    </form>
  );
}

interface RequestDetailProps extends ScreenProps {
  readonly id: string;
  readonly navigate: Navigate;
}

type Notice = "failed" | "stale" | null;

export function RequestDetail({ id, t, lang, headingRef, navigate }: RequestDetailProps) {
  const now = useNow();
  const [detail, reload, setDetail] = useLoad<VendorRequestDetail>(id, (key) => api.request(key));
  const [pending, setPending] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const back = useCallback(() => navigate({ route: "requests" }), [navigate]);
  const nativeBack = useBackButton(back);
  // Ссылка «Назад» — для браузера и старых клиентов без кнопки Telegram
  const backLink = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    back();
  };

  const act = async (patch: VendorRequestPatch) => {
    setPending(true);
    setNotice(null);
    try {
      const item = await api.updateRequest(id, patch);
      // Без повторного GET: он заново прочёл бы телефон клиента (и записал бы это в журнал)
      setDetail((current) => ({
        ...current,
        ...item,
        declineNote: patch.declineNote ?? null,
        history:
          item.status === current.status
            ? current.history
            : [...current.history, { status: item.status, at: new Date().toISOString(), by: "vendor_user" }],
      }));
      setDeclining(false);
    } catch (err) {
      if (err instanceof ApiFailure && err.code === "illegal_transition") {
        setNotice("stale");
        setDeclining(false);
        reload();
      } else {
        setNotice("failed");
      }
    } finally {
      setPending(false);
    }
  };

  if (detail.state === "loading") return <Loading t={t} />;
  if (detail.state === "error") {
    const missing = detail.error instanceof ApiFailure && detail.error.status === 404;
    return (
      <section className="page" aria-labelledby="page-title">
        {nativeBack ? null : (
          <a className="back-link" href="/requests" onClick={backLink}>
            <Icon name="back" size={14} />
            {t.back}
          </a>
        )}
        {missing ? (
          <>
            <Heading headingRef={headingRef}>{t.requestNotFound}</Heading>
            <p className="lead">{t.requestNotFoundText}</p>
          </>
        ) : (
          <LoadError t={t} onRetry={reload} />
        )}
      </section>
    );
  }

  const request = detail.data;
  const budget = formatBudget(request.budgetMinUzs, request.budgetMaxUzs, t, lang);
  const late = awaitsAnswer(request) && slaView(request.sla, now).kind === "late";
  const status = request.status;

  return (
    <section className="page" aria-labelledby="page-title">
      {nativeBack ? null : (
        <a className="back-link" href="/requests" onClick={backLink}>
          <Icon name="back" size={14} />
          {t.back}
        </a>
      )}
      <div className="detail-top">
        <Heading headingRef={headingRef}>{fill(t.requestNo, { n: request.publicNo })}</Heading>
        <StatusChip status={status} late={late} t={t} />
      </div>
      {awaitsAnswer(request) ? <SlaTimer item={request} t={t} now={now} /> : null}

      <dl className="facts">
        <div>
          <dt>{t.eventDate}</dt>
          <dd>{formatDate(request.eventDate, t, true)}</dd>
        </div>
        <div>
          <dt>{t.guestsLabel}</dt>
          <dd>{formatGuests(request.guests, t)}</dd>
        </div>
        <div>
          <dt>{t.budgetLabel}</dt>
          <dd>{budget ?? t.budgetNone}</dd>
        </div>
        <div>
          <dt>{t.occasionLabel}</dt>
          <dd>{textOf(t, `occ_${request.occasionCode}`)}</dd>
        </div>
        <div className="facts-wide">
          <dt>{t.card}</dt>
          <dd>{request.listing.name}</dd>
        </div>
      </dl>

      {request.contact ? (
        <div className="panel client">
          <p className="panel-title">{t.clientLabel}</p>
          <p className="client-name">{request.contact.name}</p>
          {request.contact.phone ? (
            <a
              className="btn btn-primary btn-wide btn-phone"
              href={`tel:${request.contact.phone}`}
              aria-label={`${t.call} ${formatPhone(request.contact.phone)}`}
              onClick={() => void api.callAttempt(id).catch(() => {})}
            >
              <Icon name="phone" size={20} />
              {formatPhone(request.contact.phone)}
            </a>
          ) : null}
          {request.contact.comment ? (
            <div className="comment">
              <p className="field-label">{t.commentLabel}</p>
              <p>{request.contact.comment}</p>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="notice">{t.contactHidden}</p>
      )}

      {notice ? (
        <p className="form-error" role="alert">
          {notice === "stale" ? t.staleStatus : t.actionFailed}
        </p>
      ) : null}

      {declining ? (
        <DeclineForm
          t={t}
          busy={pending}
          onCancel={() => setDeclining(false)}
          onSubmit={(reason, note) =>
            void act({
              status: "declined",
              declineReason: reason,
              ...(note.trim() ? { declineNote: note } : {}),
            })
          }
        />
      ) : (
        <div className="panel">
          {status === "new" || status === "viewed" ? (
            <>
              <p className="note">{t.callFirst}</p>
              <div className="actions">
                <button
                  type="button"
                  className="btn btn-dark"
                  disabled={pending}
                  onClick={() => void act({ status: "contacted" })}
                >
                  <Icon name="check" size={17} />
                  {t.actContacted}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={pending}
                  onClick={() => setDeclining(true)}
                >
                  {t.actDecline}
                </button>
              </div>
            </>
          ) : null}
          {status === "contacted" ? (
            <>
              <p className="panel-title">{t.askOutcome}</p>
              <div className="actions">
                <button
                  type="button"
                  className="btn btn-dark"
                  disabled={pending}
                  onClick={() => void act({ status: "deal" })}
                >
                  <Icon name="check" size={17} />
                  {t.actDeal}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={pending}
                  onClick={() => setDeclining(true)}
                >
                  {t.actNoDeal}
                </button>
              </div>
            </>
          ) : null}
          {status === "deal" || status === "declined" ? (
            <>
              {status === "declined" && request.declineReason ? (
                <p className="note">
                  {fill(t.reasonLine, { reason: textOf(t, `reason_${request.declineReason}`) })}
                  {request.declineNote ? ` — ${request.declineNote}` : ""}
                </p>
              ) : null}
              <button
                type="button"
                className="btn btn-ghost"
                disabled={pending}
                onClick={() => void act({ status: "contacted" })}
              >
                {t.actReopen}
              </button>
            </>
          ) : null}
          {status === "withdrawn" || status === "expired" ? (
            <p className="note">{textOf(t, `st_${status}`)}</p>
          ) : null}
        </div>
      )}

      <p className="note">{t.consentNote}</p>

      {request.history.length > 0 ? (
        <div className="history">
          <h2 className="section-title">{t.history}</h2>
          <ol>
            {request.history.map((entry) => (
              <li key={`${entry.at}-${entry.status}`}>
                <span className="history-status">{textOf(t, `st_${entry.status}`)}</span>
                <span className="history-meta">
                  {formatMoment(entry.at, t, now)} · {textOf(t, `by_${entry.by}`)}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}
