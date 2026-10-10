/* Клиенты: список — человек, а не код: имя из Telegram («Азиза К.»; нет имени — «Без имени» или
   «Аккаунт удалён»), чем входит, язык, заявки и последняя из них; код клиента (C-…) — мелко
   вторым текстом: по нему и по номеру заявки ищут (по имени и телефону не ищем, выгрузки нет).
   Клиент: имя из Telegram, заявки, журнал согласий, блокировка с причиной; телефон — только
   администратору и с причиной. */

import type { ClientDetail, ClientList, ClientListItem, RevealedPhone } from "@bayramm/shared/api/staff";
import { Dialog, SearchField, Switch } from "@bayramm/ui/react";
import { useCallback, useRef, useState } from "react";
import { type Failure, type Result, useCan, useLoad, useSession } from "../api";
import { formatDay, formatMoment } from "../format";
import { usePhone } from "../layout";
import { t } from "../texts";
import {
  ActionBar,
  ActiveFilter,
  ConfirmForm,
  FilterButton,
  Link,
  LoadedView,
  PhoneSheet,
  Pill,
  ReasonPhoneReveal,
  useEntityTitle,
} from "../ui";
import { SlaPill } from "./Requests";

function ClientState({ client }: { client: { blocked: boolean; deleted: boolean } }) {
  if (client.blocked) return <Pill tone="warn">{t.clientBlocked}</Pill>;
  if (client.deleted) return <Pill tone="muted">{t.clientDeleted}</Pill>;
  return <Pill tone="outline">{t.clientActive}</Pill>;
}

type Person = Pick<ClientListItem, "displayName" | "deleted">;

/** Как назвать клиента: имя из Telegram; нет имени — по причине (удалил аккаунт или вошёл без Telegram) */
export function clientName(client: Person): string {
  return client.displayName ?? (client.deleted ? t.clientAccountDeleted : t.clientNoName);
}

/** «Telegram, телефон» — чем входил (без самих значений) */
export function signInText(signIn: ClientListItem["signIn"]): string {
  const kinds = signIn.map((kind) => t.signInKinds[kind] ?? kind);
  const text = kinds.join(", ");
  return text === "" ? t.signInNone : text.charAt(0).toUpperCase() + text.slice(1);
}

/** Последняя заявка клиента: № · витрина и статус плашкой; заявок нет — словами */
function LastRequest({ client }: { client: ClientListItem }) {
  const last = client.lastRequest;
  if (!last) return <span className="muted">{t.clientNoRequests}</span>;
  return (
    <>
      {t.requestNo(last.publicNo)} · {last.listingName}{" "}
      <Pill tone="outline">{t.requestStatus[last.status]}</Pill>
    </>
  );
}

export function ClientsPage() {
  const phone = usePhone();
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [blocked, setBlocked] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
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
        <SearchField
          className="search"
          value={q}
          onChange={setQ}
          placeholder={t.clientsSearch}
          aria-label={t.search}
          aria-describedby="clients-search-hint"
          maxLength={100}
        />
        {phone ? (
          <FilterButton count={blocked ? 1 : 0} open={filtersOpen} onOpen={() => setFiltersOpen(true)} />
        ) : (
          <>
            <button type="submit" className="btn">
              {t.search}
            </button>
            <button
              type="button"
              className="chip"
              aria-pressed={blocked}
              onClick={() => setBlocked(!blocked)}
            >
              {t.onlyBlocked}
            </button>
          </>
        )}
      </form>
      <p id="clients-search-hint" className="muted small">
        {t.clientsSearchHint}
      </p>
      {phone && blocked ? <ActiveFilter label={t.onlyBlocked} onClear={() => setBlocked(false)} /> : null}
      {phone ? (
        <Dialog
          open={filtersOpen}
          title={t.filters}
          onClose={() => setFiltersOpen(false)}
          actions={
            <>
              <button type="button" className="ui-btn ui-btn-secondary" onClick={() => setBlocked(false)}>
                {t.reset}
              </button>
              <button type="button" className="ui-btn ui-btn-primary" onClick={() => setFiltersOpen(false)}>
                {t.done}
              </button>
            </>
          }
        >
          <Switch checked={blocked} onChange={setBlocked}>
            {t.onlyBlocked}
          </Switch>
        </Dialog>
      ) : null}
      <LoadedView loaded={loaded} onRetry={reload}>
        {(list) =>
          list.items.length === 0 ? (
            <p className="empty">{t.clientsEmpty}</p>
          ) : phone ? (
            <>
              <ul className="rcards">
                {list.items.map((client) => (
                  <li key={client.id} className="rcard rcard-tap">
                    <div className="rcard-head">
                      <Link to={{ name: "client", id: client.id }} className="rcard-link">
                        {clientName(client)}
                      </Link>
                      <ClientState client={client} />
                    </div>
                    <p className="rcard-meta">{client.ref}</p>
                    <dl className="rcard-facts">
                      <dt>{t.clientSignIn}</dt>
                      <dd>{signInText(client.signIn)}</dd>
                      <dt>{t.clientLocale}</dt>
                      <dd>{t.locales[client.locale] ?? client.locale}</dd>
                      <dt>{t.colRequests}</dt>
                      <dd>
                        {client.requests}
                        {client.lastRequestAt ? ` · ${formatMoment(client.lastRequestAt)}` : ""}
                      </dd>
                      <dt>{t.colLastRequest}</dt>
                      <dd>
                        <LastRequest client={client} />
                      </dd>
                      <dt>{t.colSince}</dt>
                      <dd>{formatMoment(client.createdAt)}</dd>
                      <dt>{t.colLastSeen}</dt>
                      <dd>{formatMoment(client.lastSeenAt)}</dd>
                    </dl>
                  </li>
                ))}
              </ul>
              <p className="muted small">{t.total(list.total)}</p>
            </>
          ) : (
            <>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">{t.colClient}</th>
                      <th scope="col">{t.colSignIn}</th>
                      <th scope="col">{t.colRequests}</th>
                      <th scope="col">{t.colSince}</th>
                      <th scope="col">{t.colLastSeen}</th>
                      <th scope="col">{t.colState}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.items.map((client) => (
                      <tr key={client.id}>
                        <td>
                          <Link to={{ name: "client", id: client.id }} className="row-link">
                            {clientName(client)}
                          </Link>
                          <span className="sub">{client.ref}</span>
                        </td>
                        <td>
                          {signInText(client.signIn)}
                          <span className="sub">{t.locales[client.locale] ?? client.locale}</span>
                        </td>
                        <td>
                          {client.requests}
                          <span className="sub">
                            <LastRequest client={client} />
                          </span>
                        </td>
                        <td>{formatMoment(client.createdAt)}</td>
                        <td>{formatMoment(client.lastSeenAt)}</td>
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
  // Заголовок — человек; код клиента — мелко под ним (по нему ищут и переписываются)
  const profileName = client.profile
    ? [client.profile.firstName, client.profile.lastName].filter(Boolean).join(" ")
    : "";
  useEntityTitle(
    profileName || client.displayName || (client.deleted ? t.clientDeletedTitle : t.clientNoNameTitle),
  );
  const { api } = useSession();
  const can = useCan();
  const loadPhone = useCallback(
    async (reason: string): Promise<Result<string | null>> => {
      const result = await api.post<RevealedPhone>(`/staff/clients/${client.id}/phone`, { reason });
      return result.ok ? { ok: true, data: result.data.phone } : result;
    },
    [api, client.id],
  );
  const name = client.profile ? profileName || t.none : null;

  return (
    <div className="stack">
      <p className="pills">
        <ClientState client={client} />
        <span className="client-ref">{client.ref}</span>
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
              <dt>{t.clientSignIn}</dt>
              <dd>{signInText(client.signIn)}</dd>
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
                presets={t.reasons.clientPhone}
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
                  <li key={request.id} className="card-row rcard-tap">
                    <div className="rcard-head">
                      <Link to={{ name: "request", id: request.id }} className="rcard-link">
                        {t.requestNo(request.publicNo)}
                      </Link>
                      <SlaPill sla={request.sla} />
                    </div>
                    <span className="sub">
                      {request.listing.name} · {formatDay(request.eventDate)} ·{" "}
                      {t.requestStatus[request.status]}
                    </span>
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
                      {t.consentVersion(consent.textVersion)} · {t.sources[consent.source] ?? consent.source}
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
  const toggle = useRef<HTMLButtonElement>(null);
  const label = client.blockedInfo ? t.unblock : t.block;

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
      {open ? null : (
        <ActionBar label={t.blockTitle}>
          <button
            ref={toggle}
            type="button"
            className={`btn${client.blockedInfo ? "" : " btn-danger"}`}
            aria-expanded={open}
            onClick={() => setOpen(true)}
          >
            {label}
          </button>
        </ActionBar>
      )}
      <PhoneSheet open={open} title={label} onClose={() => setOpen(false)} returnFocus={toggle}>
        <ConfirmForm
          hint={client.blockedInfo ? t.unblockHint : t.blockHint}
          submitLabel={label}
          {...(client.blockedInfo
            ? {}
            : { label: t.reason, required: true, maxLength: 500, presets: t.reasons.clientBlock })}
          danger={!client.blockedInfo}
          onSubmit={act}
          onCancel={() => setOpen(false)}
        />
      </PhoneSheet>
    </section>
  );
}
