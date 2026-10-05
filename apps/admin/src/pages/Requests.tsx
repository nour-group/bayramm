/* Заявки: без ответа — сверху, ближайший срок первым; «Требуют действия» — очередь
   просроченных; фильтр по категории витрины. Заявка: данные, что нужно клиенту по форме
   категории (часть дня, часы, машины, вес, выбранные услуги с добавками — как были при
   подаче), срок ответа по шагам, работа с заявкой (напомнить вендору, «связались»), заметки
   команды, история; телефоны — скрыты до «Показать» (в журнал). */

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
import {
  type CategoryConfig,
  categoryConfig,
  chosenServices,
  type DayPart,
  detailRows,
} from "@bayramm/shared/categories";
import { Dialog, RadioGroup, SearchField, Select } from "@bayramm/ui/react";
import { type FormEvent, Fragment, useCallback, useId, useRef, useState } from "react";
import { type Failure, type Result, useCan, useLoad, useSession } from "../api";
import { CategoryChip, categoryName, categoryOptions, partWindow } from "../categories";
import { formatDay, formatMoment, formatPrice, formatSum, vendorLabel } from "../format";
import { useLayout, usePhone } from "../layout";
import { t } from "../texts";
import {
  ActionBar,
  ActiveFilter,
  ConfirmForm,
  ErrorText,
  FilterButton,
  Link,
  LoadedView,
  PhoneReveal,
  PhoneSheet,
  Pill,
  ReasonPhoneReveal,
  type Tone,
  useEntityTitle,
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

/** «Утро» — часть дня заявки; у категории без частей дня — пусто */
function partName(part: DayPart | null): string {
  return part === null ? "" : (t.dayParts[part] ?? part);
}

export function RequestsPage({ dictionaries }: { dictionaries: StaffDictionaries | null }) {
  const phone = usePhone();
  const [sla, setSla] = useState<SlaFilter | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterId = useId();
  const params = new URLSearchParams({ limit: "100" });
  if (sla) params.set("sla", sla);
  if (category) params.set("category", category);
  if (query) params.set("q", query);
  const { loaded, reload } = useLoad<StaffRequestList>(`/staff/requests?${params}`);
  const list = loaded.state === "ready" ? loaded.data : null;

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
        {phone ? (
          <FilterButton
            count={(sla ? 1 : 0) + (category ? 1 : 0)}
            open={filtersOpen}
            onOpen={() => setFiltersOpen(true)}
          />
        ) : (
          <>
            <Select
              size="compact"
              label={t.colCategory}
              value={category ?? ""}
              onChange={(code) => setCategory(code === "" ? null : code)}
              options={[{ value: "", label: t.allCategories }, ...categoryOptions()]}
            />
            <button type="submit" className="btn">
              {t.search}
            </button>
          </>
        )}
      </form>
      {phone && sla ? <ActiveFilter label={filterLabel(sla)} onClear={() => setSla(null)} /> : null}
      {phone && category ? (
        <ActiveFilter label={categoryName(category)} onClear={() => setCategory(null)} />
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
                onClick={() => {
                  setSla(null);
                  setCategory(null);
                }}
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
            onChange={(value) => setSla(value === "all" ? null : value)}
            options={SLA_FILTERS.map((filter) => ({
              value: filter ?? "all",
              label: filterLabel(filter),
              ...(filter && list ? { hint: t.requestsCount(filterCount(list, filter)) } : {}),
            }))}
          />
          <p className="sheet-group" id={`${filterId}-category`}>
            {t.colCategory}
          </p>
          <RadioGroup<string>
            variant="row"
            aria-labelledby={`${filterId}-category`}
            value={category ?? "all"}
            onChange={(value) => setCategory(value === "all" ? null : value)}
            options={[{ value: "all", label: t.allCategories }, ...categoryOptions()]}
          />
        </Dialog>
      ) : null}
      <LoadedView loaded={loaded} onRetry={reload}>
        {(list) => (
          <>
            {phone ? null : (
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
            )}
            {list.items.length === 0 ? (
              <p className="empty">{t.requestsEmpty}</p>
            ) : phone ? (
              <ul className="rcards">
                {list.items.map((request) => (
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
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">{t.colRequest}</th>
                      <th scope="col">{t.colListing}</th>
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
                            {t.requestStatus[request.status]} · {t.createdAt(formatMoment(request.createdAt))}
                          </span>
                        </td>
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
  // Две колонки — только на компьютере: уже них клиент и телефоны вендора не должны уезжать вниз
  const stacked = useLayout() !== "desktop";
  const category = categoryConfig(request.listing.categoryCode);
  const district = (code: string) => dictionaries?.districts.find((d) => d.code === code)?.nameRu;
  const details = <RequestDetails category={category} request={request} district={district} />;
  const budget =
    request.budgetMinUzs !== null || request.budgetMaxUzs !== null
      ? `${formatSum(request.budgetMinUzs)} — ${formatSum(request.budgetMaxUzs)}`
      : t.none;

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
              {formatMoment(entry.at)} · {t.historyBy[entry.actorKind]}
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
        <SlaPill sla={request.sla} /> <Pill tone="outline">{t.requestStatus[request.status]}</Pill>
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
          onClick={remind}
          disabled={busy || unreachable || paused}
        >
          {t.remindVendor}
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
