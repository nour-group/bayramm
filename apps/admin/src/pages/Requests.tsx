/* Заявки: без ответа — сверху, ближайший срок первым; «Требуют действия» — очередь
   просроченных. Заявка: данные, срок ответа по шагам, работа с заявкой (напомнить вендору,
   «связались»), заметки команды, история; телефоны — скрыты до «Показать» (в журнал). */

import type {
  RequestVendorPhones,
  RevealedPhone,
  SlaEvent,
  SlaFilter,
  SlaState,
  StaffDictionaries,
  StaffRequestDetail,
  StaffRequestList,
} from "@bayramm/shared/api/staff";
import { SearchField } from "@bayramm/ui/react";
import { type FormEvent, useCallback, useId, useState } from "react";
import { type Failure, type Result, useCan, useLoad, useSession } from "../api";
import { formatDay, formatMoment, formatSum, vendorLabel } from "../format";
import { t } from "../texts";
import {
  ConfirmForm,
  ErrorText,
  Link,
  LoadedView,
  PhoneReveal,
  Pill,
  ReasonPhoneReveal,
  type Tone,
  useEntityTitle,
} from "../ui";

const SLA_FILTERS: readonly (SlaFilter | null)[] = [
  null,
  "late",
  "waiting",
  "overdue",
  "breached",
  "answered_late",
  "answered",
  "ops_contacted",
  "closed",
];

const SLA_TONE: Record<SlaState, Tone> = {
  waiting: "outline",
  overdue: "warn",
  breached: "warn",
  answered: "good",
  answered_late: "muted",
  ops_contacted: "muted",
  closed: "muted",
};

export function SlaPill({ sla }: { sla: SlaState }) {
  return <Pill tone={SLA_TONE[sla]}>{t.sla[sla]}</Pill>;
}

function occasionName(dictionaries: StaffDictionaries | null, code: string): string {
  return dictionaries?.occasions.find((o) => o.code === code)?.nameRu ?? code;
}

function filterLabel(filter: SlaFilter | null): string {
  if (filter === null) return t.all;
  return filter === "late" ? t.slaLate : (t.sla[filter] ?? filter);
}

function filterCount(list: StaffRequestList, filter: SlaFilter): number {
  return filter === "late" ? list.counts.overdue + list.counts.breached : list.counts[filter];
}

export function RequestsPage({ dictionaries }: { dictionaries: StaffDictionaries | null }) {
  const [sla, setSla] = useState<SlaFilter | null>(null);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const params = new URLSearchParams({ limit: "100" });
  if (sla) params.set("sla", sla);
  if (query) params.set("q", query);
  const { loaded, reload } = useLoad<StaffRequestList>(`/staff/requests?${params}`);

  return (
    <div className="stack">
      <form
        className="toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(q.trim());
        }}
      >
        <SearchField
          className="search"
          value={q}
          onChange={setQ}
          placeholder={t.requestsSearch}
          aria-label={t.search}
          maxLength={100}
        />
        <button type="submit" className="btn">
          {t.search}
        </button>
      </form>
      <LoadedView loaded={loaded} onRetry={reload}>
        {(list) => (
          <>
            <fieldset className="chips">
              <legend className="visually-hidden">{t.colDue}</legend>
              {SLA_FILTERS.map((filter) => (
                <button
                  key={filter ?? "all"}
                  type="button"
                  className="chip"
                  aria-pressed={sla === filter}
                  onClick={() => setSla(filter)}
                >
                  {filterLabel(filter)}
                  {filter && <span className="chip-count">{filterCount(list, filter)}</span>}
                </button>
              ))}
            </fieldset>
            {list.items.length === 0 ? (
              <p className="empty">{t.requestsEmpty}</p>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">{t.colRequest}</th>
                      <th scope="col">{t.colVendor}</th>
                      <th scope="col">{t.colEvent}</th>
                      <th scope="col">{t.colDue}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.items.map((request) => (
                      <tr key={request.id}>
                        <td>
                          <Link to={{ name: "request", id: request.id }} className="row-link">
                            {t.requestNo(request.publicNo)}
                          </Link>
                          <span className="sub">
                            {t.requestStatus[request.status]} · {formatMoment(request.createdAt)}
                          </span>
                        </td>
                        <td>
                          <Link to={{ name: "listing", id: request.listing.id }}>{request.listing.name}</Link>
                          <span className="sub">{vendorLabel(request.vendor)}</span>
                        </td>
                        <td>
                          {formatDay(request.eventDate)}
                          <span className="sub">
                            {occasionName(dictionaries, request.occasionCode)} · {t.guests(request.guests)}
                          </span>
                        </td>
                        <td>
                          <SlaPill sla={request.sla} />
                          <span className="sub">
                            {t.dueIn} {formatMoment(request.slaDueAt)}
                            {request.reminders > 0 ? ` · ${t.reminders(request.reminders)}` : ""}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted small">{t.total(list.total)}</p>
          </>
        )}
      </LoadedView>
    </div>
  );
}

export function RequestPage({ id, dictionaries }: { id: string; dictionaries: StaffDictionaries | null }) {
  const { loaded, reload, set } = useLoad<StaffRequestDetail>(`/staff/requests/${id}`);
  return (
    <LoadedView loaded={loaded} onRetry={reload}>
      {(request) => <RequestView request={request} dictionaries={dictionaries} onChange={set} />}
    </LoadedView>
  );
}

function RequestView({
  request,
  dictionaries,
  onChange,
}: {
  request: StaffRequestDetail;
  dictionaries: StaffDictionaries | null;
  onChange: (request: StaffRequestDetail) => void;
}) {
  useEntityTitle(`${t.views.request} ${t.requestNo(request.publicNo)}`);
  const { api } = useSession();
  const can = useCan();
  const [vendorPhones, setVendorPhones] = useState<Promise<Result<RequestVendorPhones>> | null>(null);
  const loadVendor = useCallback(() => {
    const pending =
      vendorPhones ?? api.post<RequestVendorPhones>(`/staff/requests/${request.id}/vendor-phone`, {});
    setVendorPhones(pending);
    return pending;
  }, [api, request.id, vendorPhones]);
  const pick = (key: keyof RequestVendorPhones) => async (): Promise<Result<string | null>> => {
    const result = await loadVendor();
    return result.ok ? { ok: true, data: result.data[key] } : result;
  };
  const loadClientPhone = useCallback(
    async (reason: string): Promise<Result<string | null>> => {
      const result = await api.post<RevealedPhone>(`/staff/requests/${request.id}/client-phone`, { reason });
      return result.ok ? { ok: true, data: result.data.phone } : result;
    },
    [api, request.id],
  );
  const budget =
    request.budgetMinUzs !== null || request.budgetMaxUzs !== null
      ? `${formatSum(request.budgetMinUzs)} — ${formatSum(request.budgetMaxUzs)}`
      : t.none;

  return (
    <div className="stack">
      <p>
        <SlaPill sla={request.sla} /> <Pill tone="outline">{t.requestStatus[request.status]}</Pill>
      </p>
      {can("requests.write") && <RequestActions request={request} onChange={onChange} />}
      <div className="columns">
        <div className="stack">
          <section className="panel">
            <dl className="dl">
              <dt>{t.colVendor}</dt>
              <dd>
                <Link to={{ name: "listing", id: request.listing.id }}>{request.listing.name}</Link> ·{" "}
                <Link to={{ name: "vendor", id: request.vendor.id }}>{vendorLabel(request.vendor)}</Link>
              </dd>
              <dt>{t.colEvent}</dt>
              <dd>
                {formatDay(request.eventDate)} · {occasionName(dictionaries, request.occasionCode)} ·{" "}
                {t.guests(request.guests)}
              </dd>
              <dt>{t.requestBudget}</dt>
              <dd>{budget}</dd>
              <dt>{t.colDue}</dt>
              <dd>{formatMoment(request.slaDueAt)}</dd>
              <dt>{t.firstViewed}</dt>
              <dd>{formatMoment(request.firstViewedAt)}</dd>
              <dt>{t.firstResponse}</dt>
              <dd>
                {formatMoment(request.firstResponseAt)}
                {request.firstResponseBy ? ` · ${t.historyBy[request.firstResponseBy]}` : ""}
              </dd>
              {request.declineReason && (
                <>
                  <dt>{t.requestStatus.declined}</dt>
                  <dd>
                    {t.declineReasons[request.declineReason]}
                    {request.declineNote ? ` · ${request.declineNote}` : ""}
                  </dd>
                </>
              )}
              <dt>{t.source}</dt>
              <dd>{request.source}</dd>
            </dl>
          </section>
          <Timeline events={request.timeline} />
          <Notes request={request} onChange={onChange} />
          <section className="panel" aria-labelledby="history-title">
            <h2 id="history-title">{t.history}</h2>
            <ol className="history">
              {request.history.map((entry) => (
                <li key={`${entry.at}-${entry.to}`}>
                  <span className="sub">{formatMoment(entry.at)}</span>{" "}
                  {entry.from ? `${t.requestStatus[entry.from]} → ` : ""}
                  <strong>{t.requestStatus[entry.to]}</strong>
                  <span className="sub"> · {t.historyBy[entry.actorKind]}</span>
                  {entry.reason && <p className="reason">{entry.reason}</p>}
                </li>
              ))}
            </ol>
          </section>
        </div>
        <div className="stack">
          <section className="panel" aria-labelledby="client-title">
            <h2 id="client-title">{t.requestClient}</h2>
            {request.contactPurged ? (
              <p className="muted">{t.contactPurged}</p>
            ) : (
              <>
                <p>
                  <strong>{request.contactName ?? t.none}</strong>
                </p>
                {request.comment && (
                  <p>
                    <span className="sub">{t.requestComment}</span>
                    {request.comment}
                  </p>
                )}
                {can("client_phones.read") && (
                  <ReasonPhoneReveal
                    label={t.clientPhone}
                    hint={t.clientPhoneHint}
                    reasonLabel={t.clientPhoneReason}
                    load={loadClientPhone}
                  />
                )}
              </>
            )}
          </section>
          <section className="panel" aria-labelledby="vendor-phones-title">
            <h2 id="vendor-phones-title">{t.vendorPhones}</h2>
            <PhoneReveal label={t.listingPhone} load={pick("listingPhone")} />
            <PhoneReveal label={t.phoneMain} load={pick("phone")} />
            <PhoneReveal label={t.phoneAlternative} load={pick("phoneAlt")} />
          </section>
        </div>
      </div>
    </div>
  );
}

// ── работа с заявкой ───────────────────────────────────────────────────────

function RequestActions({
  request,
  onChange,
}: {
  request: StaffRequestDetail;
  onChange: (request: StaffRequestDetail) => void;
}) {
  const { api } = useSession();
  const [contacting, setContacting] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  if (!request.awaiting)
    return (
      <section className="panel" aria-labelledby="actions-title">
        <h2 id="actions-title">{t.requestActions}</h2>
        <p className="muted">{t.notAwaiting}</p>
      </section>
    );

  const remind = async () => {
    setBusy(true);
    setSent(false);
    const result = await api.post<StaffRequestDetail>(`/staff/requests/${request.id}/remind`);
    setBusy(false);
    setFailure(result.ok ? null : result);
    if (result.ok) {
      setSent(true);
      onChange(result.data);
    }
  };

  const contacted = async (comment: string): Promise<Failure | null> => {
    const result = await api.post<StaffRequestDetail>(
      `/staff/requests/${request.id}/contacted`,
      comment ? { comment } : {},
    );
    if (!result.ok) return result;
    setContacting(false);
    onChange(result.data);
    return null;
  };

  const unreachable = request.vendorReachable === 0;
  const paused = request.nextReminderAt !== null;
  return (
    <section className="panel" aria-labelledby="actions-title">
      <h2 id="actions-title">{t.requestActions}</h2>
      <div className="acts">
        <button
          type="button"
          className="btn btn-primary"
          onClick={remind}
          disabled={busy || unreachable || paused}
        >
          {t.remindVendor}
        </button>
        <button
          type="button"
          className="btn"
          aria-expanded={contacting}
          onClick={() => setContacting(!contacting)}
        >
          {t.markContacted}
        </button>
      </div>
      <p className="muted small">
        {unreachable
          ? t.remindUnreachable
          : paused
            ? t.remindAgainAt(formatMoment(request.nextReminderAt))
            : t.remindHint}
      </p>
      {sent && (
        <p className="saved" role="status">
          {t.remindSent}
        </p>
      )}
      {failure && <ErrorText failure={failure} />}
      {contacting && (
        <ConfirmForm
          hint={t.markContactedHint}
          label={t.comment}
          submitLabel={t.markContacted}
          onSubmit={contacted}
          onCancel={() => setContacting(false)}
        />
      )}
    </section>
  );
}

// ── срок ответа по шагам ───────────────────────────────────────────────────

function eventText(event: SlaEvent): string {
  switch (event.kind) {
    case "created":
    case "viewed":
    case "breached":
      return t.timelineEvents[event.kind];
    case "due":
      return event.passed ? t.timelineEvents.due : t.timelineEvents.dueFuture;
    case "response":
      return `${t.timelineEvents.response} · ${t.historyBy[event.by]}`;
    case "reminder":
      return event.source === "ops" ? t.reminderOps(event.by) : t.reminderAuto(event.stage);
  }
}

function Timeline({ events }: { events: readonly SlaEvent[] }) {
  return (
    <section className="panel" aria-labelledby="timeline-title">
      <h2 id="timeline-title">{t.timeline}</h2>
      <ol className="history timeline">
        {events.map((event) => (
          <li key={`${event.kind}-${event.at}`} className={`timeline-${event.kind}`}>
            <span className="sub">{formatMoment(event.at)}</span> <strong>{eventText(event)}</strong>
            {event.kind === "reminder" && (
              <span className="sub">
                {t.reminderDelivery(event.recipients, event.delivered, event.failed)}
              </span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

// ── заметки ────────────────────────────────────────────────────────────────

function Notes({
  request,
  onChange,
}: {
  request: StaffRequestDetail;
  onChange: (request: StaffRequestDetail) => void;
}) {
  const { api } = useSession();
  const can = useCan();
  const id = useId();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const result = await api.post<StaffRequestDetail>(`/staff/requests/${request.id}/notes`, { text });
    setBusy(false);
    setFailure(result.ok ? null : result);
    if (result.ok) {
      setText("");
      onChange(result.data);
    }
  };

  return (
    <section className="panel" aria-labelledby="notes-title">
      <h2 id="notes-title">{t.notes}</h2>
      {request.notes.length === 0 ? (
        <p className="muted">{t.notesEmpty}</p>
      ) : (
        <ol className="history notes">
          {request.notes.map((note) => (
            <li key={note.id}>
              <span className="sub">
                {formatMoment(note.at)}
                {note.authorName ? ` · ${note.authorName}` : ""}
              </span>
              <p className="reason">{note.text}</p>
            </li>
          ))}
        </ol>
      )}
      {can("requests.write") && (
        <form className="note-form" onSubmit={add} noValidate>
          <label htmlFor={id}>{t.noteText}</label>
          <textarea
            id={id}
            className="input"
            rows={2}
            maxLength={1000}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <p className="field-hint">{t.notesHint}</p>
          <div>
            <button type="submit" className="btn" disabled={busy || text.trim() === ""}>
              {t.addNote}
            </button>
          </div>
          {failure && <ErrorText failure={failure} />}
        </form>
      )}
    </section>
  );
}
