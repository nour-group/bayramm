/* Заявки: без ответа — сверху, ближайший срок первым. Фильтр по состоянию срока ответа.
   Заявка: данные, история, телефоны — скрыты до «Показать» (просмотр — в журнал). */

import { formatUzPhone } from "@bayramm/shared";
import type {
  RequestVendorPhones,
  RevealedPhone,
  SlaState,
  StaffDictionaries,
  StaffRequestDetail,
  StaffRequestList,
} from "@bayramm/shared/api/staff";
import { type FormEvent, useCallback, useId, useState } from "react";
import { type Failure, type Result, useCan, useLoad, useSession } from "../api";
import { formatDay, formatMoment, formatSum, vendorLabel } from "../format";
import { apiErrorText, t } from "../texts";
import { ErrorText, Link, LoadedView, PhoneReveal, Pill, type Tone, useEntityTitle } from "../ui";

const SLA_FILTERS: readonly (SlaState | null)[] = [
  null,
  "waiting",
  "overdue",
  "breached",
  "answered_late",
  "answered",
  "closed",
];

const SLA_TONE: Record<SlaState, Tone> = {
  waiting: "outline",
  overdue: "warn",
  breached: "warn",
  answered: "good",
  answered_late: "muted",
  closed: "muted",
};

export function SlaPill({ sla }: { sla: SlaState }) {
  return <Pill tone={SLA_TONE[sla]}>{t.sla[sla]}</Pill>;
}

function occasionName(dictionaries: StaffDictionaries | null, code: string): string {
  return dictionaries?.occasions.find((o) => o.code === code)?.nameRu ?? code;
}

export function RequestsPage({ dictionaries }: { dictionaries: StaffDictionaries | null }) {
  const [sla, setSla] = useState<SlaState | null>(null);
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
        <input
          className="input search"
          type="search"
          value={q}
          onChange={(event) => setQ(event.target.value)}
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
                  {filter ? t.sla[filter] : t.all}
                  {filter && <span className="chip-count">{list.counts[filter]}</span>}
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
  const { loaded, reload } = useLoad<StaffRequestDetail>(`/staff/requests/${id}`);
  return (
    <LoadedView loaded={loaded} onRetry={reload}>
      {(request) => <RequestView request={request} dictionaries={dictionaries} />}
    </LoadedView>
  );
}

function RequestView({
  request,
  dictionaries,
}: {
  request: StaffRequestDetail;
  dictionaries: StaffDictionaries | null;
}) {
  useEntityTitle(`${t.views.request} ${t.requestNo(request.publicNo)}`);
  const { api } = useSession();
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
  const budget =
    request.budgetMinUzs !== null || request.budgetMaxUzs !== null
      ? `${formatSum(request.budgetMinUzs)} — ${formatSum(request.budgetMaxUzs)}`
      : t.none;

  return (
    <div className="stack">
      <p>
        <SlaPill sla={request.sla} /> <Pill tone="outline">{t.requestStatus[request.status]}</Pill>
      </p>
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
                <ClientPhone requestId={request.id} />
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

/** Телефон клиента: только администратор и только с причиной — её видно в журнале */
function ClientPhone({ requestId }: { requestId: string }) {
  const { api } = useSession();
  const can = useCan();
  const reasonId = useId();
  const [reason, setReason] = useState("");
  const [phone, setPhone] = useState<string | null | undefined>(undefined);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  if (!can("client_phones.read")) return null;

  const reveal = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const result = await api.post<RevealedPhone>(`/staff/requests/${requestId}/client-phone`, { reason });
    setBusy(false);
    setFailure(result.ok ? null : result);
    if (result.ok) setPhone(result.data.phone);
  };

  if (phone !== undefined)
    return (
      <p className="phone-row">
        <span className="phone-label">{t.clientPhone}</span>
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
      <p className="muted small">{t.clientPhoneHint}</p>
      <label htmlFor={reasonId}>{t.clientPhoneReason}</label>
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
