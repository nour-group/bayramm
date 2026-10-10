/* Заявки: без ответа — сверху, ближайший срок первым; «Требуют действия» — очередь
   просроченных; фильтр по категории витрины; в списке — чья заявка (имя, которое вписал клиент;
   удалено по сроку хранения — «—»). Заявка: данные, что нужно клиенту по форме
   категории (часть дня, часы, машины, вес, выбранные услуги с добавками — как были при
   подаче), срок ответа по шагам, работа с заявкой (напомнить вендору, «связались»), заметки
   команды, история; телефоны — скрыты до «Показать» (в журнал). */

import type {
  RequestStatus,
  RequestVendorPhones,
  RevealedPhone,
  SlaEvent,
  SlaFilter,
  SlaState,
  StaffDictionaries,
  StaffRequestDetail,
  StaffRequestItem,
  StaffRequestList,
} from "@bayramm/shared/api/staff";
import {
  type CategoryConfig,
  categoryConfig,
  chosenServices,
  type DayPart,
  detailRows,
} from "@bayramm/shared/categories";
import { Dialog, RadioGroup, type RadioOption, SearchField, Select } from "@bayramm/ui/react";
import { type FormEvent, Fragment, useCallback, useId, useRef, useState } from "react";
import { type Failure, type Result, useCan, useLoad, useSession } from "../api";
import {
  CategoryChip,
  categoryName,
  categoryOptions,
  formatPrice,
  knownCategory,
  partWindow,
} from "../categories";
import { formatDay, formatMoment, formatSum, vendorLabel } from "../format";
import { useLayout, usePhone } from "../layout";
import { useQueryState } from "../router";
import { t } from "../texts";
import {
  ActionBar,
  ActiveFilter,
  busyLabel,
  ConfirmForm,
  EmptyList,
  ErrorText,
  FilterButton,
  Link,
  ListFooter,
  LoadedView,
  offsetOf,
  PhoneReveal,
  PhoneSheet,
  Pill,
  ReasonPhoneReveal,
  toneOf,
  useBreadcrumbs,
  useEntityTitle,
  useListSearch,
  usePagedList,
} from "../ui";
import { useUnsaved } from "../unsaved";

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

const STATUSES: readonly RequestStatus[] = [
  "new",
  "viewed",
  "contacted",
  "deal",
  "declined",
  "withdrawn",
  "expired",
];

/** Заявок на странице */
const PAGE = 50;

const KEYS = ["q", "sla", "status", "category", "listingId", "page"] as const;

type Key = (typeof KEYS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function SlaPill({ sla }: { sla: SlaState }) {
  return <Pill tone={toneOf("sla", sla)}>{t.sla[sla]}</Pill>;
}

/** Статус заявки плашкой: тот же цвет, что у статусов в других разделах */
export function RequestStatusPill({ status }: { status: RequestStatus }) {
  return <Pill tone={toneOf("request", status)}>{t.requestStatus[status]}</Pill>;
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

/** «Утро» — часть дня заявки; у категории без частей дня — пусто */
function partName(part: DayPart | null): string {
  return part === null ? "" : (t.dayParts[part] ?? part);
}

const slaOf = (value: string | undefined): SlaFilter | null =>
  SLA_FILTERS.find((filter) => filter !== null && filter === value) ?? null;
const statusOf = (value: string | undefined): RequestStatus | null =>
  STATUSES.find((status) => status === value) ?? null;

const STATUS_OPTIONS = [
  { value: "", label: t.allStatuses },
  ...STATUSES.map((value) => ({ value, label: t.requestStatus[value] ?? value })),
];

/**
 * Заявки: поиск (номер, витрина, вендор) — как только перестали печатать; фильтры срока,
 * статуса и категории, страница и одна витрина (?listingId= — ссылка «Заявки витрины») — в
 * адресе: «назад» из заявки возвращает тот же список, а ссылки ведут сразу на отфильтрованный
 * (/requests?sla=late — плитка метрик, ?q=V101 — «Заявки вендора»)
 */
export function RequestsPage({ dictionaries }: { dictionaries: StaffDictionaries | null }) {
  const phone = usePhone();
  const [query, setQuery] = useQueryState(KEYS);
  const [q, setQ] = useListSearch(query.q ?? "", (search) => setQuery({ q: search, page: null }));
  const sla = slaOf(query.sla);
  const status = statusOf(query.status);
  const category = knownCategory(query.category);
  const listingId = query.listingId && UUID.test(query.listingId) ? query.listingId : null;
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterId = useId();
  const offset = phone ? 0 : offsetOf(query.page, PAGE);
  const params = new URLSearchParams();
  if (sla) params.set("sla", sla);
  if (status) params.set("status", status);
  if (category) params.set("category", category);
  if (listingId) params.set("listingId", listingId);
  if (query.q) params.set("q", query.q);
  const list = usePagedList<StaffRequestItem, StaffRequestList>(`/staff/requests?${params}`, {
    size: PAGE,
    offset,
    append: phone,
  });
  const data = list.loaded.state === "ready" ? list.loaded.data : null;
  const filtered = Boolean(query.q || sla || status || category || listingId);
  // Другой фильтр — с первой страницы
  const set = (patch: Partial<Record<Key, string | null>>) => setQuery({ ...patch, page: null });
  const reset = () => {
    setQ("");
    setQuery({ q: null, sla: null, status: null, category: null, listingId: null, page: null });
  };
  const onPage = (next: number) => {
    setQuery({ page: next > 0 ? String(next / PAGE + 1) : null });
    window.scrollTo?.(0, 0);
  };
  const listingName = listingId
    ? list.items.find((r) => r.listing.id === listingId)?.listing.name
    : undefined;
  // Сколько заявок в каждом состоянии срока: на компьютере — в подписи пилюли, в шторке — второй строкой
  const slaOptions = (inLabel: boolean): RadioOption<SlaFilter | "all">[] =>
    SLA_FILTERS.map((filter) => {
      const count = filter && data ? filterCount(data, filter) : null;
      if (count === null) return { value: filter ?? "all", label: filterLabel(filter) };
      return inLabel
        ? { value: filter ?? "all", label: `${filterLabel(filter)} · ${count}` }
        : { value: filter ?? "all", label: filterLabel(filter), hint: t.requestsCount(count) };
    });

  return (
    <div className="stack">
      <div className="toolbar">
        <SearchField
          className="search"
          value={q}
          onChange={setQ}
          placeholder={t.requestsSearch}
          aria-label={t.search}
          maxLength={100}
        />
        {phone ? (
          <FilterButton
            count={(sla ? 1 : 0) + (status ? 1 : 0) + (category ? 1 : 0)}
            open={filtersOpen}
            onOpen={() => setFiltersOpen(true)}
          />
        ) : (
          <>
            <Select
              size="compact"
              label={t.requestStatusFilter}
              value={status ?? ""}
              onChange={(value) => set({ status: value === "" ? null : value })}
              options={STATUS_OPTIONS}
            />
            <Select
              size="compact"
              label={t.colCategory}
              value={category ?? ""}
              onChange={(code) => set({ category: code === "" ? null : code })}
              options={[{ value: "", label: t.allCategories }, ...categoryOptions()]}
            />
          </>
        )}
      </div>
      {listingId ? (
        <ActiveFilter
          label={listingName ? t.requestsOfListing(listingName) : t.requestsOfListingUnknown}
          onClear={() => set({ listingId: null })}
        />
      ) : null}
      {phone && sla ? <ActiveFilter label={filterLabel(sla)} onClear={() => set({ sla: null })} /> : null}
      {phone && status ? (
        <ActiveFilter label={t.requestStatus[status] ?? status} onClear={() => set({ status: null })} />
      ) : null}
      {phone && category ? (
        <ActiveFilter label={categoryName(category)} onClear={() => set({ category: null })} />
      ) : null}
      {phone ? (
        <Dialog
          open={filtersOpen}
          title={t.filters}
          onClose={() => setFiltersOpen(false)}
          actions={
            <>
              <button
                type="button"
                className="ui-btn ui-btn-secondary"
                onClick={() => set({ sla: null, status: null, category: null })}
              >
                {t.reset}
              </button>
              <button type="button" className="ui-btn ui-btn-primary" onClick={() => setFiltersOpen(false)}>
                {t.done}
              </button>
            </>
          }
        >
          <p className="sheet-group" id={`${filterId}-sla`}>
            {t.colDue}
          </p>
          <RadioGroup<SlaFilter | "all">
            variant="row"
            aria-labelledby={`${filterId}-sla`}
            value={sla ?? "all"}
            onChange={(value) => set({ sla: value === "all" ? null : value })}
            options={slaOptions(false)}
          />
          <p className="sheet-group" id={`${filterId}-status`}>
            {t.requestStatusFilter}
          </p>
          <RadioGroup<string>
            variant="row"
            aria-labelledby={`${filterId}-status`}
            value={status ?? ""}
            onChange={(value) => set({ status: value === "" ? null : value })}
            options={STATUS_OPTIONS}
          />
          <p className="sheet-group" id={`${filterId}-category`}>
            {t.colCategory}
          </p>
          <RadioGroup<string>
            variant="row"
            aria-labelledby={`${filterId}-category`}
            value={category ?? "all"}
            onChange={(value) => set({ category: value === "all" ? null : value })}
            options={[{ value: "all", label: t.allCategories }, ...categoryOptions()]}
          />
        </Dialog>
      ) : (
        <RadioGroup<SlaFilter | "all">
          variant="pill"
          label={t.colDue}
          name="requests-sla"
          value={sla ?? "all"}
          onChange={(value) => set({ sla: value === "all" ? null : value })}
          options={slaOptions(true)}
        />
      )}
      <LoadedView loaded={list.loaded} onRetry={list.reload}>
        {() =>
          list.items.length === 0 ? (
            filtered ? (
              <EmptyList text={t.requestsFilteredEmpty} onReset={reset} />
            ) : (
              <EmptyList text={t.requestsEmpty} />
            )
          ) : (
            <>
              {phone ? (
                <RequestCards items={list.items} dictionaries={dictionaries} />
              ) : (
                <RequestTable items={list.items} dictionaries={dictionaries} />
              )}
              <ListFooter list={list} offset={offset} size={PAGE} onPage={onPage} />
            </>
          )
        }
      </LoadedView>
    </div>
  );
}

interface RowsProps {
  items: readonly StaffRequestItem[];
  dictionaries: StaffDictionaries | null;
}

function RequestCards({ items, dictionaries }: RowsProps) {
  return (
    <ul className="rcards">
      {items.map((request) => (
        <li key={request.id} className="rcard rcard-tap">
          <div className="rcard-head">
            <Link to={{ name: "request", id: request.id }} className="rcard-link">
              {t.requestNo(request.publicNo)}
            </Link>
            <SlaPill sla={request.sla} />
          </div>
          <p className="rcard-meta">
            {t.requestStatus[request.status]} · {t.createdAt(formatMoment(request.createdAt))}
          </p>
          <dl className="rcard-facts">
            <dt>{t.colClient}</dt>
            <dd>{request.contactName ?? t.none}</dd>
            <dt>{t.colListing}</dt>
            <dd>
              <CategoryChip code={request.listing.categoryCode} /> {request.listing.name} ·{" "}
              {vendorLabel(request.vendor)}
            </dd>
            <dt>{t.colEvent}</dt>
            <dd>
              {formatDay(request.eventDate)}
              {request.dayPart ? ` · ${partName(request.dayPart)}` : ""} ·{" "}
              {occasionName(dictionaries, request.occasionCode)}
              {request.guests !== null ? ` · ${t.guests(request.guests)}` : ""}
            </dd>
            <dt>{t.colDue}</dt>
            <dd>
              {formatMoment(request.slaDueAt)}
              {request.reminders > 0 ? ` · ${t.reminders(request.reminders)}` : ""}
            </dd>
          </dl>
        </li>
      ))}
    </ul>
  );
}

function RequestTable({ items, dictionaries }: RowsProps) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">{t.colRequest}</th>
            <th scope="col">{t.colClient}</th>
            <th scope="col">{t.colListing}</th>
            <th scope="col">{t.colEvent}</th>
            <th scope="col">{t.colDue}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((request) => (
            <tr key={request.id}>
              <td>
                <Link to={{ name: "request", id: request.id }} className="row-link">
                  {t.requestNo(request.publicNo)}
                </Link>
                <span className="sub">
                  {t.requestStatus[request.status]} · {t.createdAt(formatMoment(request.createdAt))}
                </span>
              </td>
              <td>{request.contactName ?? t.none}</td>
              <td>
                <Link to={{ name: "listing", id: request.listing.id }}>{request.listing.name}</Link>
                <span className="sub">
                  <CategoryChip code={request.listing.categoryCode} /> {vendorLabel(request.vendor)}
                </span>
              </td>
              <td>
                {formatDay(request.eventDate)}
                {request.dayPart ? ` · ${partName(request.dayPart)}` : ""}
                <span className="sub">
                  {occasionName(dictionaries, request.occasionCode)}
                  {request.guests !== null ? ` · ${t.guests(request.guests)}` : ""}
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
  );
}

export function RequestPage({ id, dictionaries }: { id: string; dictionaries: StaffDictionaries | null }) {
  const { loaded, reload, set } = useLoad<StaffRequestDetail>(`/staff/requests/${id}`);
  return (
    <LoadedView loaded={loaded} onRetry={reload} skeleton="detail">
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
  // Путь на компьютере: заявки → вендор → витрина
  useBreadcrumbs([
    { label: vendorLabel(request.vendor), to: { name: "vendor", id: request.vendor.id } },
    { label: request.listing.name, to: { name: "listing", id: request.listing.id } },
  ]);
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
  // Две колонки — только на компьютере: уже них клиент и телефоны вендора не должны уезжать вниз
  const stacked = useLayout() !== "desktop";
  const category = categoryConfig(request.listing.categoryCode);
  const district = (code: string) => dictionaries?.districts.find((d) => d.code === code)?.nameRu;
  const details = <RequestDetails category={category} request={request} district={district} />;
  const budget = budgetText(request.budgetMinUzs, request.budgetMaxUzs);

  const facts = (
    <section className="panel" aria-label={t.views.request}>
      <dl className="dl">
        <dt>{t.colListing}</dt>
        <dd>
          <Link to={{ name: "listing", id: request.listing.id }}>{request.listing.name}</Link>
        </dd>
        <dt>{t.colVendor}</dt>
        <dd>
          <Link to={{ name: "vendor", id: request.vendor.id }}>{vendorLabel(request.vendor)}</Link>
        </dd>
        <dt>{t.colCategory}</dt>
        <dd>
          <CategoryChip code={request.listing.categoryCode} />
        </dd>
        <dt>{t.colEvent}</dt>
        <dd>
          {formatDay(request.eventDate)} · {occasionName(dictionaries, request.occasionCode)}
          {request.guests !== null ? ` · ${t.guests(request.guests)}` : ""}
        </dd>
        {request.dayPart && category ? (
          <>
            <dt>{t.dayPart}</dt>
            <dd>
              {partName(request.dayPart)} · {partWindow(category, request.dayPart)}
            </dd>
          </>
        ) : null}
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
        <dd>{t.sources[request.source] ?? request.source}</dd>
      </dl>
    </section>
  );
  const history = (
    <section className="panel" aria-labelledby="history-title">
      <h2 id="history-title">{t.history}</h2>
      <ol className="history">
        {request.history.map((entry) => (
          <li key={`${entry.at}-${entry.to}`}>
            <span className="sub">
              {formatMoment(entry.at)} · {actorOf(entry)}
            </span>
            {entry.from ? `${t.requestStatus[entry.from]} → ` : ""}
            <strong>{t.requestStatus[entry.to]}</strong>
            {entry.reason && <p className="reason">{entry.reason}</p>}
          </li>
        ))}
      </ol>
    </section>
  );
  const client = (
    <section className="panel" aria-labelledby="client-title">
      <h2 id="client-title">{t.requestClient}</h2>
      {/* Карточка клиента — по коду C-…: заявки, согласия, блокировка. Телефона в ссылке нет */}
      {request.client && can("clients.read") ? (
        <p>
          <Link to={{ name: "client", id: request.client.id }}>
            {t.requestClientOpen(request.client.ref)}
          </Link>
        </p>
      ) : null}
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
  );
  const phones = (
    <section className="panel" aria-labelledby="vendor-phones-title">
      <h2 id="vendor-phones-title">{t.vendorPhones}</h2>
      <PhoneReveal label={t.listingPhone} load={pick("listingPhone")} />
      <PhoneReveal label={t.phoneMain} load={pick("phone")} />
      <PhoneReveal label={t.phoneAlternative} load={pick("phoneAlt")} />
    </section>
  );

  return (
    <div className="stack">
      <p className="pills">
        <SlaPill sla={request.sla} /> <RequestStatusPill status={request.status} />
      </p>
      {can("requests.write") && <RequestActions request={request} onChange={onChange} />}
      {stacked ? (
        // Телефон и планшет: сначала главное — данные заявки, клиент, как дозвониться вендору
        <>
          {facts}
          {details}
          {client}
          {phones}
          <Timeline events={request.timeline} />
          <Notes request={request} onChange={onChange} />
          {history}
        </>
      ) : (
        <div className="columns">
          <div className="stack">
            {facts}
            {details}
            <Timeline events={request.timeline} />
            <Notes request={request} onChange={onChange} />
            {history}
          </div>
          <div className="stack">
            {client}
            {phones}
          </div>
        </div>
      )}
    </div>
  );
}

/** Бюджет одной строкой: «от … до …», «от …» или «до …» — без прочерка на месте пустой границы */
export function budgetText(min: number | null, max: number | null): string {
  if (min !== null && max !== null) return t.budgetRange(formatSum(min), formatSum(max));
  if (min !== null) return t.budgetFrom(formatSum(min));
  if (max !== null) return t.budgetTo(formatSum(max));
  return t.none;
}

/** Кто сменил статус: имя сотрудника или пользователя кабинета, код клиента; иначе — вид */
function actorOf(entry: StaffRequestDetail["history"][number]): string {
  const kind = t.historyBy[entry.actorKind] ?? entry.actorKind;
  if (!entry.actorName) return kind;
  return entry.actorKind === "staff" ? entry.actorName : `${entry.actorName} · ${kind}`;
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
  const contactButton = useRef<HTMLButtonElement>(null);
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
      <ActionBar label={t.requestActions}>
        <button
          type="button"
          className="btn btn-primary"
          aria-busy={busy || undefined}
          onClick={remind}
          disabled={busy || unreachable || paused}
        >
          {busyLabel(t.remindVendor, busy)}
        </button>
        <button
          ref={contactButton}
          type="button"
          className="btn"
          aria-expanded={contacting}
          onClick={() => setContacting(!contacting)}
        >
          {t.markContacted}
        </button>
      </ActionBar>
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
      <PhoneSheet
        open={contacting}
        title={t.markContacted}
        onClose={() => setContacting(false)}
        returnFocus={contactButton}
      >
        <ConfirmForm
          hint={t.markContactedHint}
          label={t.comment}
          submitLabel={t.markContacted}
          onSubmit={contacted}
          onCancel={() => setContacting(false)}
        />
      </PhoneSheet>
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
  // Вписанная и не добавленная заметка — несохранённое
  useUnsaved(text.trim() !== "");

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
            <button
              type="submit"
              className="btn"
              aria-busy={busy || undefined}
              disabled={busy || text.trim() === ""}
            >
              {busyLabel(t.addNote, busy)}
            </button>
          </div>
          {failure && <ErrorText failure={failure} />}
        </form>
      )}
    </section>
  );
}

/**
 * Что нужно клиенту — поля формы заявки категории (часы, машины, вес, цвета…) и выбранные
 * услуги с количеством и добавками: названия и цены — как были при подаче заявки
 */
function RequestDetails({
  category,
  request,
  district,
}: {
  category: CategoryConfig | undefined;
  request: StaffRequestDetail;
  district: (code: string) => string | undefined;
}) {
  const rows = detailRows("ru", category, request.details, district);
  const services = chosenServices(category, request.details);
  if (rows.length === 0 && services.length === 0) return null;
  return (
    <section className="panel" aria-labelledby="details-title">
      <h2 id="details-title">{t.requestDetails}</h2>
      {rows.length > 0 ? (
        <dl className="dl">
          {rows.map((row) => (
            <Fragment key={row.key}>
              <dt>{row.label}</dt>
              <dd>{row.value ?? t.yes}</dd>
            </Fragment>
          ))}
        </dl>
      ) : null}
      {services.length > 0 ? (
        <>
          <h3 className="sub-title">{t.requestServices}</h3>
          <ul className="chosen">
            {services.map((service) => (
              <li key={service.id}>
                <strong>{service.name.ru}</strong>
                {service.qty !== null ? ` × ${service.qty}` : ""}
                <span className="sub">{formatPrice(service.priceUzs, service.priceUnit)}</span>
                {service.options.length > 0 ? (
                  <ul className="plain">
                    {service.options.map((option) => (
                      <li key={option.id}>
                        + {option.name.ru} — {formatPrice(option.priceUzs, option.priceUnit)}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
