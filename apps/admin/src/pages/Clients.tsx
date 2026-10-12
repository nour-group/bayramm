/* Клиенты: список — человек, а не код: имя из Telegram («Азиза К.»; нет имени — «Без имени» или
   «Аккаунт удалён»), чем входит, язык, заявки и когда был; код клиента (C-…) — мелко вторым
   текстом: по нему и по номеру заявки ищут (по имени и телефону не ищем, выгрузки нет — об этом
   говорит подсказка в поле поиска).
   Клиент: заявки, профиль (имя пользователя, вход, телефон), журнал согласий; блокировка с
   причиной — в «…» заголовка, а пока клиент заблокирован — строка с причиной под плашками.
   Телефон — только администратору и с причиной. Поиск, «только заблокированные» и страница — в
   адресе (?q=&blocked=1&page=): «назад» из клиента возвращает тот же список. */

import type { ClientDetail, ClientList, ClientListItem, RevealedPhone } from "@bayramm/shared/api/staff";
import { SearchField, Switch } from "@bayramm/ui/react";
import { useCallback, useRef, useState } from "react";
import { type Failure, type Result, useCan, useLoad, useSession } from "../api";
import { formatDay, formatMoment, formatSince } from "../format";
import { useLayout, usePhone } from "../layout";
import { useQueryState } from "../router";
import { t } from "../texts";
import {
  ConfirmForm,
  EmptyList,
  Link,
  ListFooter,
  LoadedView,
  type MenuAction,
  OverflowMenu,
  offsetOf,
  PhoneSheet,
  Pill,
  ReasonPhoneReveal,
  toneOf,
  useEntityTitle,
  useListSearch,
  usePagedList,
} from "../ui";
import { RequestStatusPill, SlaPill } from "./Requests";

function ClientState({ client }: { client: { blocked: boolean; deleted: boolean } }) {
  if (client.blocked) return <Pill tone={toneOf("client", "blocked")}>{t.clientBlocked}</Pill>;
  if (client.deleted) return <Pill tone={toneOf("client", "deleted")}>{t.clientDeleted}</Pill>;
  return <Pill tone={toneOf("client", "active")}>{t.clientActive}</Pill>;
}

/** В списке «Активен» — норма: плашка только у заблокированного и удалившего аккаунт */
function ClientFlag({ client }: { client: { blocked: boolean; deleted: boolean } }) {
  return client.blocked || client.deleted ? <ClientState client={client} /> : null;
}

/** «был 3 ч назад»; не заходил — прочерк */
const seenText = (iso: string | null): string => (iso ? t.seenAgo(formatSince(iso)) : t.seenNever);

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
      {t.requestNo(last.publicNo)} · {last.listingName} <RequestStatusPill status={last.status} />
    </>
  );
}

/** Клиентов на странице: не больше, чем отдаёт API (список — не выгрузка базы) */
const PAGE = 50;

const KEYS = ["q", "blocked", "page"] as const;

export function ClientsPage() {
  const phone = usePhone();
  // Таблица — только на компьютере: на планшете колонки обрезались бы справа
  const cards = useLayout() !== "desktop";
  const [query, setQuery] = useQueryState(KEYS);
  // Поиск — как только перестали печатать, без кнопки «Найти» (как у вендоров и заявок)
  const [q, setQ] = useListSearch(query.q ?? "", (search) => setQuery({ q: search, page: null }));
  const blocked = query.blocked === "1";
  const offset = phone ? 0 : offsetOf(query.page, PAGE);
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (blocked) params.set("blocked", "1");
  const list = usePagedList<ClientListItem, ClientList>(`/staff/clients?${params}`, {
    size: PAGE,
    offset,
    append: phone,
  });
  const filtered = Boolean(query.q || blocked);
  const reset = () => {
    setQ("");
    setQuery({ q: null, blocked: null, page: null });
  };
  const onPage = (next: number) => {
    setQuery({ page: next > 0 ? String(next / PAGE + 1) : null });
    window.scrollTo?.(0, 0);
  };

  return (
    <div className="stack">
      <div className="toolbar">
        <SearchField
          className="search search-full"
          value={q}
          onChange={setQ}
          placeholder={t.clientsSearch}
          aria-label={t.search}
          maxLength={100}
        />
        {/* Один фильтр — одним переключателем и на телефоне, и на компьютере: шторка ради него не нужна */}
        <Switch checked={blocked} onChange={(on) => setQuery({ blocked: on ? "1" : null, page: null })}>
          {t.onlyBlocked}
        </Switch>
      </div>
      <LoadedView loaded={list.loaded} onRetry={list.reload}>
        {() =>
          list.items.length === 0 ? (
            filtered ? (
              <EmptyList text={t.clientsFilteredEmpty} onReset={reset} />
            ) : (
              <EmptyList text={t.clientsEmpty} />
            )
          ) : (
            <>
              {cards ? <ClientCards items={list.items} /> : <ClientTable items={list.items} />}
              <ListFooter list={list} offset={offset} size={PAGE} onPage={onPage} />
            </>
          )
        }
      </LoadedView>
    </div>
  );
}

/** Карточка телефона — три строки: имя (и плашка, если не активен), код · вход · язык, заявки · был */
function ClientCards({ items }: { items: readonly ClientListItem[] }) {
  return (
    <ul className="rcards">
      {items.map((client) => (
        <li key={client.id} className="rcard rcard-tap">
          <div className="rcard-head">
            <Link to={{ name: "client", id: client.id }} className="rcard-link">
              {clientName(client)}
            </Link>
            <ClientFlag client={client} />
          </div>
          <p className="rcard-meta">
            {client.ref} · {signInText(client.signIn)} · {t.locales[client.locale] ?? client.locale}
          </p>
          <p className="rcard-meta">
            {client.requests > 0 ? t.requestsOf(client.requests) : t.clientNoRequests} ·{" "}
            {seenText(client.lastSeenAt)}
          </p>
        </li>
      ))}
    </ul>
  );
}

function ClientTable({ items }: { items: readonly ClientListItem[] }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">{t.colClient}</th>
            <th scope="col">{t.colSignIn}</th>
            <th scope="col">{t.colRequests}</th>
            <th scope="col">{t.colSeen}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((client) => (
            <tr key={client.id}>
              <td>
                <Link to={{ name: "client", id: client.id }} className="row-link">
                  {clientName(client)}
                </Link>{" "}
                <ClientFlag client={client} />
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
              <td>{seenText(client.lastSeenAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ClientPage({ id }: { id: string }) {
  const { loaded, reload, set } = useLoad<ClientDetail>(`/staff/clients/${id}`);
  return (
    <LoadedView loaded={loaded} onRetry={reload} skeleton="detail">
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
  const stacked = useLayout() !== "desktop";
  const loadPhone = useCallback(
    async (reason: string): Promise<Result<string | null>> => {
      const result = await api.post<RevealedPhone>(`/staff/clients/${client.id}/phone`, { reason });
      return result.ok ? { ok: true, data: result.data.phone } : result;
    },
    [api, client.id],
  );

  const requests = (
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
                {request.listing.name} · {formatDay(request.eventDate)} · {t.requestStatus[request.status]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
  // Имя — заголовок страницы, второй раз его нет: имя пользователя, вход и язык одной строкой, телефон
  const profile = (
    <section className="panel" aria-labelledby="profile-title">
      <h2 id="profile-title">{t.clientProfile}</h2>
      {client.profile === null && <p className="muted">{t.clientDeletedNote}</p>}
      <dl className="dl">
        {client.profile !== null && (
          <>
            <dt>{t.clientUsername}</dt>
            <dd>{client.profile.username ? `@${client.profile.username}` : t.none}</dd>
          </>
        )}
        <dt>{t.clientSignInLocale}</dt>
        <dd>
          {signInText(client.signIn)} · {t.locales[client.locale] ?? client.locale}
        </dd>
        {client.canMessage ? null : (
          <>
            <dt>{t.clientCanMessage}</dt>
            <dd>{t.no}</dd>
          </>
        )}
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
  );
  const consents = (
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
  );

  return (
    <div className="stack">
      <Blocking client={client} onChange={onChange} canBlock={can("clients.block")} />
      {stacked ? (
        // Телефон и планшет: заявки — первыми, это то, за чем приходят
        <>
          {requests}
          {profile}
          {consents}
        </>
      ) : (
        <div className="columns columns-wide-first">
          <div className="stack">
            {requests}
            {consents}
          </div>
          <div className="stack">{profile}</div>
        </div>
      )}
    </div>
  );
}

/**
 * Плашки состояния и «…» с блокировкой (пока можно блокировать). Заблокирован — строкой ниже: с
 * какого времени, кем и почему; причину пишет тот, кто блокирует, и она в журнале
 */
function Blocking({
  client,
  onChange,
  canBlock,
}: {
  client: ClientDetail;
  onChange: (c: ClientDetail) => void;
  canBlock: boolean;
}) {
  const { api } = useSession();
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
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
  const actions: MenuAction[] = canBlock
    ? [{ key: "block", label, danger: !client.blockedInfo, run: () => setOpen(true) }]
    : [];

  return (
    <>
      <div className="entity-head">
        <p className="pills">
          <ClientState client={client} />
          <span className="client-ref">{client.ref}</span>
        </p>
        <OverflowMenu title={t.actionsTitle} actions={actions} buttonRef={more} />
      </div>
      {client.blockedInfo ? (
        <p className="notice notice-warn">
          {t.blockedSince(formatMoment(client.blockedInfo.at), client.blockedInfo.by)}
          {" · "}
          {t.reason}: {client.blockedInfo.reason}
        </p>
      ) : null}
      <PhoneSheet open={open} title={label} onClose={() => setOpen(false)} returnFocus={more}>
        {/* В шторке рамка ни к чему; на компьютере форма встаёт на месте — в своей панели */}
        <div className={phone ? undefined : "panel"}>
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
        </div>
      </PhoneSheet>
    </>
  );
}
