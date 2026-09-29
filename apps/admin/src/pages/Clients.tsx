/* Клиенты: список — только псевдонимы (C-…), поиск по номеру заявки или коду клиента;
   по имени и телефону не ищем, выгрузки нет. Клиент: имя из Telegram, заявки, журнал
   согласий, блокировка с причиной; телефон — только администратору и с причиной. */

import type { ClientDetail, ClientList, RevealedPhone } from "@bayramm/shared/api/staff";
import { useCallback, useState } from "react";
import { type Failure, type Result, useCan, useLoad, useSession } from "../api";
import { formatDay, formatMoment } from "../format";
import { t } from "../texts";
import { ConfirmForm, Link, LoadedView, Pill, ReasonPhoneReveal, useEntityTitle } from "../ui";
import { SlaPill } from "./Requests";

function ClientState({ client }: { client: { blocked: boolean; deleted: boolean } }) {
  if (client.blocked) return <Pill tone="warn">{t.clientBlocked}</Pill>;
  if (client.deleted) return <Pill tone="muted">{t.clientDeleted}</Pill>;
  return <Pill tone="outline">{t.clientActive}</Pill>;
}

export function ClientsPage() {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [blocked, setBlocked] = useState(false);
  const params = new URLSearchParams({ limit: "50" });
  if (query) params.set("q", query);
  if (blocked) params.set("blocked", "1");
  const { loaded, reload } = useLoad<ClientList>(`/staff/clients?${params}`);

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
          placeholder={t.clientsSearch}
          aria-label={t.search}
          aria-describedby="clients-search-hint"
          maxLength={100}
        />
        <button type="submit" className="btn">
          {t.search}
        </button>
        <button type="button" className="chip" aria-pressed={blocked} onClick={() => setBlocked(!blocked)}>
          {t.onlyBlocked}
        </button>
      </form>
      <p id="clients-search-hint" className="muted small">
        {t.clientsSearchHint}
      </p>
      <LoadedView loaded={loaded} onRetry={reload}>
        {(list) =>
          list.items.length === 0 ? (
            <p className="empty">{t.clientsEmpty}</p>
          ) : (
            <>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">{t.colClient}</th>
                      <th scope="col">{t.colSince}</th>
                      <th scope="col">{t.colLastSeen}</th>
                      <th scope="col">{t.colRequests}</th>
                      <th scope="col">{t.colState}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.items.map((client) => (
                      <tr key={client.id}>
                        <td>
                          <Link to={{ name: "client", id: client.id }} className="row-link">
                            {client.ref}
                          </Link>
                        </td>
                        <td>{formatMoment(client.createdAt)}</td>
                        <td>{formatMoment(client.lastSeenAt)}</td>
                        <td>
                          {client.requests}
                          {client.lastRequestAt && (
                            <span className="sub">{formatMoment(client.lastRequestAt)}</span>
                          )}
                        </td>
                        <td>
                          <ClientState client={client} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted small">{t.total(list.total)}</p>
            </>
          )
        }
      </LoadedView>
    </div>
  );
}

export function ClientPage({ id }: { id: string }) {
  const { loaded, reload, set } = useLoad<ClientDetail>(`/staff/clients/${id}`);
  return (
    <LoadedView loaded={loaded} onRetry={reload}>
      {(client) => <ClientView client={client} onChange={set} />}
    </LoadedView>
  );
}

function ClientView({ client, onChange }: { client: ClientDetail; onChange: (c: ClientDetail) => void }) {
  useEntityTitle(`${t.views.client} ${client.ref}`);
  const { api } = useSession();
  const can = useCan();
  const loadPhone = useCallback(
    async (reason: string): Promise<Result<string | null>> => {
      const result = await api.post<RevealedPhone>(`/staff/clients/${client.id}/phone`, { reason });
      return result.ok ? { ok: true, data: result.data.phone } : result;
    },
    [api, client.id],
  );
  const name = client.profile
    ? [client.profile.firstName, client.profile.lastName].filter(Boolean).join(" ") || t.none
    : null;

  return (
    <div className="stack">
      <p>
        <ClientState client={client} />
      </p>
      <div className="columns">
        <div className="stack">
          <section className="panel" aria-labelledby="profile-title">
            <h2 id="profile-title">{t.clientProfile}</h2>
            {client.profile === null && <p className="muted">{t.clientDeletedNote}</p>}
            <dl className="dl">
              {name !== null && (
                <>
                  <dt>{t.clientName}</dt>
                  <dd>{name}</dd>
                  <dt>{t.clientUsername}</dt>
                  <dd>{client.profile?.username ? `@${client.profile.username}` : t.none}</dd>
                </>
              )}
              <dt>{t.colSince}</dt>
              <dd>{formatMoment(client.createdAt)}</dd>
              <dt>{t.colLastSeen}</dt>
              <dd>{formatMoment(client.lastSeenAt)}</dd>
              <dt>{t.clientLocale}</dt>
              <dd>{t.locales[client.locale] ?? client.locale}</dd>
              <dt>{t.clientCanMessage}</dt>
              <dd>{client.canMessage ? t.yes : t.no}</dd>
            </dl>
            {client.profile !== null && can("client_phones.read") && (
              <ReasonPhoneReveal
                label={t.clientPhoneProfile}
                hint={t.clientPhoneHint}
                reasonLabel={t.clientPhoneReason}
                load={loadPhone}
              />
            )}
          </section>
          {can("clients.block") && <Blocking client={client} onChange={onChange} />}
        </div>
        <div className="stack">
          <section className="panel" aria-labelledby="client-requests-title">
            <h2 id="client-requests-title">
              {t.clientRequests} <span className="count">{client.requestList.length}</span>
            </h2>
            {client.requestList.length === 0 ? (
              <p className="muted">{t.requestsEmpty}</p>
            ) : (
              <ul className="cards">
                {client.requestList.map((request) => (
                  <li key={request.id} className="card-row">
                    <div>
                      <Link to={{ name: "request", id: request.id }} className="row-link">
                        {t.requestNo(request.publicNo)}
                      </Link>{" "}
                      <SlaPill sla={request.sla} />
                      <span className="sub">
                        {request.listing.name} · {formatDay(request.eventDate)} ·{" "}
                        {t.requestStatus[request.status]}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="panel" aria-labelledby="consents-title">
            <h2 id="consents-title">{t.clientConsents}</h2>
            {client.consents.length === 0 ? (
              <p className="muted">{t.consentsEmpty}</p>
            ) : (
              <ol className="history">
                {client.consents.map((consent) => (
                  <li key={`${consent.at}-${consent.purpose}-${consent.listing?.id ?? ""}`}>
                    <span className="sub">{formatMoment(consent.at)}</span>{" "}
                    <strong>{t.consentActions[consent.action]}</strong> ·{" "}
                    {t.consentPurposes[consent.purpose] ?? consent.purpose}
                    <span className="sub">
                      {t.consentVersion(consent.textVersion)} · {consent.source}
                      {consent.listing ? ` · ${consent.listing.name}` : ""}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function Blocking({ client, onChange }: { client: ClientDetail; onChange: (c: ClientDetail) => void }) {
  const { api } = useSession();
  const [open, setOpen] = useState(false);

  const act = async (reason: string): Promise<Failure | null> => {
    const result = client.blockedInfo
      ? await api.post<ClientDetail>(`/staff/clients/${client.id}/unblock`)
      : await api.post<ClientDetail>(`/staff/clients/${client.id}/block`, { reason });
    if (!result.ok) return result;
    setOpen(false);
    onChange(result.data);
    return null;
  };

  return (
    <section className="panel" aria-labelledby="block-title">
      <h2 id="block-title">{t.blockTitle}</h2>
      {client.blockedInfo ? (
        <>
          <p>{t.blockedSince(formatMoment(client.blockedInfo.at), client.blockedInfo.by)}</p>
          <p className="reason">
            {t.reason}: {client.blockedInfo.reason}
          </p>
        </>
      ) : (
        <p className="muted small">{t.blockHint}</p>
      )}
      {open ? (
        <ConfirmForm
          hint={client.blockedInfo ? t.unblock : t.blockHint}
          submitLabel={client.blockedInfo ? t.unblock : t.block}
          {...(client.blockedInfo ? {} : { label: t.reason, required: true, maxLength: 500 })}
          danger={!client.blockedInfo}
          onSubmit={act}
          onCancel={() => setOpen(false)}
        />
      ) : (
        <div>
          <button
            type="button"
            className={`btn${client.blockedInfo ? "" : " btn-danger"}`}
            aria-expanded={open}
            onClick={() => setOpen(true)}
          >
            {client.blockedInfo ? t.unblock : t.block}
          </button>
        </div>
      )}
    </section>
  );
}
