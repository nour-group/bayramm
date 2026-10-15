/* Заявки: без ответа — сверху, ближайший срок первым. Быстрые «Требуют действия» (просроченные),
   «Ждут ответа» и «Все»; остальные состояния срока (ответили, закрыта) — списком «Срок ответа».
   В строке — чья заявка (имя, которое вписал клиент; удалено по сроку хранения — «—») и одна
   плашка срока с временем («Просрочена 3 ч», «Ответ до 09:00»). Заявка: что и когда (данные и что
   нужно клиенту по форме категории — часть дня, часы, машины, вес, выбранные услуги с добавками —
   как были при подаче), клиент, телефоны вендора, ход заявки одним потоком (срок ответа,
   напоминания, статусы, заметки команды); действия — напомнить вендору, «связались». Телефоны —
   скрыты до «Показать» (в журнал). */

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
  hasDayParts,
} from "@bayramm/shared/categories";
import { Dialog, RadioGroup, type RadioOption, SearchField, Select, useToast } from "@bayramm/ui/react";
import { type FormEvent, Fragment, type ReactNode, useCallback, useId, useRef, useState } from "react";
import { type Failure, type Result, useCan, useLoad, useSession } from "../api";
import { CategoryChip, categoryName, categoryOptions, formatPrice, knownCategory } from "../categories";
import {
  formatDay,
  formatDayShort,
  formatMoment,
  formatSince,
  formatSum,
  formatUntil,
  vendorLabel,
} from "../format";
import { useLayout, usePhone } from "../layout";
import { PhonesReveal } from "../phones";
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
  PhoneSheet,
  Pill,
  ReasonPhoneReveal,
  TableWrap,
  toneOf,
  useEntityTitle,
  useListSearch,
  usePagedList,
} from "../ui";
import { useUnsaved } from "../unsaved";

/** Быстрые фильтры в строке пилюль; остальные состояния срока — списком «Срок ответа» */
type Quick = "late" | "waiting" | "all";

/** Состояния срока в списке «Срок ответа»: ответили или заявка закрыта — история, не работа */
const HISTORY_SLA: readonly SlaFilter[] = ["answered", "answered_late", "ops_contacted", "closed"];

const SLA_FILTERS: readonly SlaFilter[] = ["late", "waiting", ...HISTORY_SLA];

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

const KEYS = ["q", "sla", "status", "category", "part", "listingId", "page"] as const;

type Key = (typeof KEYS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Ждёт первого ответа вендора: срок идёт или уже вышел */
const AWAITING: ReadonlySet<SlaState> = new Set(["waiting", "overdue", "breached"]);

/** Исход, который что-то добавляет к сроку; «связался» ответ в сроке уже говорит */
const OUTCOMES: ReadonlySet<RequestStatus> = new Set(["deal", "declined", "withdrawn", "expired"]);

/**
 * Плашка срока: ждёт — «Ответ до 09:00», срок вышел (просрочена и нарушен срок — одно и то же для
 * того, кто разбирает) — «Просрочена 3 ч». Без срока (dueAt) и у разобранных — состояние словами
 */
export function SlaPill({ sla, dueAt }: { sla: SlaState; dueAt?: string }) {
  let text = t.sla[sla] ?? sla;
  if (dueAt !== undefined && sla === "waiting") text = t.slaUntil(formatUntil(dueAt));
  else if (dueAt !== undefined && (sla === "overdue" || sla === "breached"))
    text = t.slaOverdue(formatSince(dueAt));
  return <Pill tone={toneOf("sla", sla)}>{text}</Pill>;
}

/** Статус заявки плашкой: тот же цвет, что у статусов в других разделах */
export function RequestStatusPill({ status }: { status: RequestStatus }) {
  return <Pill tone={toneOf("request", status)}>{t.requestStatus[status]}</Pill>;
}

/** Статус словами — только если он что-то добавляет: пока ждём ответа, он не нужен */
function statusNote(request: Pick<StaffRequestItem, "sla" | "status">): string | null {
  if (AWAITING.has(request.sla) || !OUTCOMES.has(request.status)) return null;
  return t.requestStatus[request.status] ?? null;
}

function occasionName(dictionaries: StaffDictionaries | null, code: string): string {
  return dictionaries?.occasions.find((o) => o.code === code)?.nameRu ?? code;
}

/** «Ответ с опозданием» и так далее — подпись состояния срока в списке и под фильтром */
const slaLabel = (filter: SlaFilter): string => (filter === "late" ? t.slaLate : (t.sla[filter] ?? filter));

/** «Требуют действия · 3»; ноль — без числа */
const withCount = (label: string, count: number): string => (count > 0 ? `${label} · ${count}` : label);

/**
 * Части дня заявки: «Утро, вечер»; без частей — «Весь день»; у категории без календаря (срок
 * заказа) — пусто
 */
export function partsName(categoryCode: string, parts: readonly DayPart[]): string {
  const config = categoryConfig(categoryCode);
  if (config !== undefined && !hasDayParts(config)) return "";
  if (parts.length === 0) return t.wholeDay;
  return parts
    .map((part, i) => {
      const name = t.dayParts[part] ?? part;
      return i === 0 ? name : name.toLowerCase();
    })
    .join(", ");
}

/** Фильтр «Время»: заявки на часть дня или на весь день */
type PartFilter = DayPart | "whole";
const PART_FILTERS: readonly PartFilter[] = ["morning", "day", "evening", "whole"];
const partOf = (value: string | undefined): PartFilter | null =>
  PART_FILTERS.find((part) => part === value) ?? null;
const partLabel = (part: PartFilter) => (part === "whole" ? t.wholeDay : (t.dayParts[part] ?? part));
const PART_OPTIONS = [
  { value: "", label: t.allParts },
  ...PART_FILTERS.map((value) => ({ value, label: partLabel(value) })),
];

/** Просрочена и нарушен срок — одна очередь «Требуют действия»; старые ссылки на них ведут туда */
const slaOf = (value: string | undefined): SlaFilter | null => {
  if (value === "overdue" || value === "breached") return "late";
  return SLA_FILTERS.find((filter) => filter === value) ?? null;
};
const statusOf = (value: string | undefined): RequestStatus | null =>
  STATUSES.find((status) => status === value) ?? null;

const STATUS_OPTIONS = [
  { value: "", label: t.allStatuses },
  ...STATUSES.map((value) => ({ value, label: t.requestStatus[value] ?? value })),
];

const HISTORY_OPTIONS = HISTORY_SLA.map((value) => ({ value, label: slaLabel(value) }));

/**
 * Заявки: поиск (номер, витрина, вендор) — как только перестали печатать; срок, статус и категория,
 * страница и одна витрина (?listingId= — ссылка «Заявки витрины») — в адресе: «назад» из заявки
 * возвращает тот же список, а ссылки ведут сразу на отфильтрованный (/requests?sla=late — «Требуют
 * действия», ?q=V101 — «Заявки вендора»)
 */
export function RequestsPage({ dictionaries }: { dictionaries: StaffDictionaries | null }) {
  const phone = usePhone();
  // Таблица — только на компьютере: уже неё колонки обрезались бы справа
  const cards = useLayout() !== "desktop";
  const [query, setQuery] = useQueryState(KEYS);
  const [q, setQ] = useListSearch(query.q ?? "", (search) => setQuery({ q: search, page: null }));
  const sla = slaOf(query.sla);
  const status = statusOf(query.status);
  const category = knownCategory(query.category);
  const part = partOf(query.part);
  const listingId = query.listingId && UUID.test(query.listingId) ? query.listingId : null;
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterId = useId();
  const offset = phone ? 0 : offsetOf(query.page, PAGE);
  const params = new URLSearchParams();
  if (sla) params.set("sla", sla);
  if (status) params.set("status", status);
  if (category) params.set("category", category);
  if (part) params.set("part", part);
  if (listingId) params.set("listingId", listingId);
  if (query.q) params.set("q", query.q);
  const list = usePagedList<StaffRequestItem, StaffRequestList>(`/staff/requests?${params}`, {
    size: PAGE,
    offset,
    append: phone,
  });
  const data = list.loaded.state === "ready" ? list.loaded.data : null;
  const filtered = Boolean(query.q || sla || status || category || part || listingId);
  // Другой фильтр — с первой страницы
  const set = (patch: Partial<Record<Key, string | null>>) => setQuery({ ...patch, page: null });
  const reset = () => {
    setQ("");
    setQuery({ q: null, sla: null, status: null, category: null, part: null, listingId: null, page: null });
  };
  const onPage = (next: number) => {
    setQuery({ page: next > 0 ? String(next / PAGE + 1) : null });
    window.scrollTo?.(0, 0);
  };
  const listingName = listingId
    ? list.items.find((r) => r.listing.id === listingId)?.listing.name
    : undefined;
  // «Срок ответа» из списка — только состояния после ответа; быстрые фильтры — пилюлями
  const history = sla !== null && HISTORY_SLA.includes(sla) ? sla : null;
  const quick: Quick | null = sla === null ? "all" : sla === "late" || sla === "waiting" ? sla : null;
  const quickOptions: RadioOption<Quick>[] = [
    { value: "late", label: withCount(t.slaLate, data ? data.counts.overdue + data.counts.breached : 0) },
    { value: "waiting", label: withCount(t.slaWaitingFilter, data ? data.counts.waiting : 0) },
    { value: "all", label: t.all },
  ];
  const onQuick = (value: Quick) => set({ sla: value === "all" ? null : value });

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
            count={(history ? 1 : 0) + (status ? 1 : 0) + (category ? 1 : 0) + (part ? 1 : 0)}
            open={filtersOpen}
            onOpen={() => setFiltersOpen(true)}
          />
        ) : (
          <>
            <Select<SlaFilter>
              size="compact"
              label={t.colDue}
              placeholder={t.colDue}
              value={history}
              onChange={(value) => set({ sla: value })}
              options={HISTORY_OPTIONS}
            />
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
            <Select
              size="compact"
              label={t.partFilter}
              value={part ?? ""}
              onChange={(value) => set({ part: value === "" ? null : value })}
              options={PART_OPTIONS}
            />
          </>
        )}
      </div>
      <RadioGroup<Quick>
        variant="pill"
        label={t.colDue}
        name="requests-sla"
        value={quick}
        onChange={onQuick}
        options={quickOptions}
      />
      {listingId ? (
        <ActiveFilter
          label={listingName ? t.requestsOfListing(listingName) : t.requestsOfListingUnknown}
          onClear={() => set({ listingId: null })}
        />
      ) : null}
      {phone && history ? (
        <ActiveFilter label={slaLabel(history)} onClear={() => set({ sla: null })} />
      ) : null}
      {phone && status ? (
        <ActiveFilter label={t.requestStatus[status] ?? status} onClear={() => set({ status: null })} />
      ) : null}
      {phone && category ? (
        <ActiveFilter label={categoryName(category)} onClear={() => set({ category: null })} />
      ) : null}
      {phone && part ? <ActiveFilter label={partLabel(part)} onClear={() => set({ part: null })} /> : null}
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
                onClick={() => set({ sla: null, status: null, category: null, part: null })}
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
          <RadioGroup<SlaFilter>
            variant="row"
            aria-labelledby={`${filterId}-sla`}
            value={history}
            onChange={(value) => set({ sla: value })}
            options={HISTORY_OPTIONS}
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
          <p className="sheet-group" id={`${filterId}-part`}>
            {t.partFilter}
          </p>
          <RadioGroup<string>
            variant="row"
            aria-labelledby={`${filterId}-part`}
            value={part ?? ""}
            onChange={(value) => set({ part: value === "" ? null : value })}
            options={PART_OPTIONS}
          />
        </Dialog>
      ) : null}
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
              {cards ? (
                <RequestCards items={list.items} dictionaries={dictionaries} category={category} />
              ) : (
                <RequestTable items={list.items} dictionaries={dictionaries} category={category} />
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
  /** Фильтр категории: выбрана одна — подпись категории в строке ни к чему */
  category: string | null;
}

/** «24 окт. · Утро · Свадьба · 180 гостей» — когда и что за событие */
function eventLine(request: StaffRequestItem, dictionaries: StaffDictionaries | null): string {
  return [
    formatDayShort(request.eventDate),
    partsName(request.listing.categoryCode, request.dayParts),
    occasionName(dictionaries, request.occasionCode),
    request.guests !== null ? t.guests(request.guests) : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Карточка телефона — три строки: № и имя с плашкой срока, витрина, событие */
function RequestCards({ items, dictionaries, category }: RowsProps) {
  return (
    <ul className="rcards">
      {items.map((request) => {
        const note = statusNote(request);
        return (
          <li key={request.id} className="rcard rcard-tap">
            <div className="rcard-head">
              <Link to={{ name: "request", id: request.id }} className="rcard-link">
                {t.requestNo(request.publicNo)}
                {request.contactName ? ` · ${request.contactName}` : ""}
              </Link>
              <SlaPill sla={request.sla} dueAt={request.slaDueAt} />
            </div>
            <p className="rcard-meta">
              {request.listing.name}
              {category === null ? ` · ${categoryName(request.listing.categoryCode)}` : ""}
            </p>
            <p className="rcard-meta">
              {eventLine(request, dictionaries)}
              {note ? ` · ${note}` : ""}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

function RequestTable({ items, dictionaries, category }: RowsProps) {
  return (
    <TableWrap label={t.requests}>
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
          {items.map((request) => {
            const note = statusNote(request);
            return (
              <tr key={request.id}>
                <td>
                  <Link to={{ name: "request", id: request.id }} className="row-link">
                    {t.requestNo(request.publicNo)}
                  </Link>
                  <span className="sub">{request.contactName ?? t.none}</span>
                </td>
                <td>
                  <Link to={{ name: "listing", id: request.listing.id }}>{request.listing.name}</Link>
                  <span className="sub">
                    {category === null ? <CategoryChip code={request.listing.categoryCode} /> : null}{" "}
                    {vendorLabel(request.vendor)}
                  </span>
                </td>
                <td>
                  {formatDay(request.eventDate)}
                  {partsName(request.listing.categoryCode, request.dayParts)
                    ? ` · ${partsName(request.listing.categoryCode, request.dayParts)}`
                    : ""}
                  <span className="sub">
                    {occasionName(dictionaries, request.occasionCode)}
                    {request.guests !== null ? ` · ${t.guests(request.guests)}` : ""}
                  </span>
                </td>
                <td>
                  <SlaPill sla={request.sla} dueAt={request.slaDueAt} />
                  {note ? <span className="sub">{note}</span> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableWrap>
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
  // Путь над заголовком — только «Заявки»: витрина и вендор — ссылками в «Что и когда»
  useEntityTitle(`${t.views.request} ${t.requestNo(request.publicNo)}`);
  const { api } = useSession();
  const can = useCan();
  // Одно чтение открывает все номера вендора — в журнал одна запись
  const loadVendorPhones = useCallback(
    () => api.post<RequestVendorPhones>(`/staff/requests/${request.id}/vendor-phone`, {}),
    [api, request.id],
  );
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
  const hasBudget = request.budgetMinUzs !== null || request.budgetMaxUzs !== null;
  const note = statusNote(request);

  const facts = (
    <section className="panel" aria-labelledby="facts-title">
      <h2 id="facts-title">{t.requestWhatWhen}</h2>
      <dl className="dl">
        <dt>{t.colListing}</dt>
        <dd>
          <Link to={{ name: "listing", id: request.listing.id }}>{request.listing.name}</Link>
        </dd>
        <dt>{t.colVendor}</dt>
        <dd>
          <Link to={{ name: "vendor", id: request.vendor.id }}>{vendorLabel(request.vendor)}</Link>
        </dd>
        <dt>{t.colEvent}</dt>
        <dd>
          {formatDay(request.eventDate)} · {occasionName(dictionaries, request.occasionCode)}
          {request.guests !== null ? ` · ${t.guests(request.guests)}` : ""}
        </dd>
        {partsName(request.listing.categoryCode, request.dayParts) ? (
          <>
            <dt>{t.dayPart}</dt>
            <dd>{partsName(request.listing.categoryCode, request.dayParts)}</dd>
          </>
        ) : null}
        {hasBudget ? (
          <>
            <dt>{t.requestBudget}</dt>
            <dd>{budgetText(request.budgetMinUzs, request.budgetMaxUzs)}</dd>
          </>
        ) : null}
        {request.firstResponseAt ? (
          <>
            <dt>{t.firstResponse}</dt>
            <dd>
              {formatMoment(request.firstResponseAt)}
              {request.firstResponseBy ? ` · ${t.historyBy[request.firstResponseBy]}` : ""}
            </dd>
          </>
        ) : null}
        {request.declineReason && (
          <>
            <dt>{t.requestStatus.declined}</dt>
            <dd>
              {t.declineReasons[request.declineReason]}
              {request.declineNote ? ` · ${request.declineNote}` : ""}
            </dd>
          </>
        )}
        <RequestDetailRows category={category} request={request} district={district} />
      </dl>
      <ChosenServices category={category} request={request} />
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
            {/* Карточка клиента — по коду C-…: заявки, согласия, блокировка. Телефона в ссылке нет */}
            {request.client && can("clients.read") ? (
              <>
                {" · "}
                <Link to={{ name: "client", id: request.client.id }}>
                  {t.requestClientOpen(request.client.ref)}
                </Link>
              </>
            ) : null}
          </p>
          {request.comment && (
            <p>
              <span className="sub">{t.requestComment}</span>
              {request.comment}
            </p>
          )}
          {can("client_phones.read") && (
            <ReasonPhoneReveal
              presets={t.reasons.clientPhone}
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
      <PhonesReveal
        rows={[
          { key: "listingPhone", label: t.listingPhone },
          { key: "phone", label: t.phoneMain },
          { key: "phoneAlt", label: t.phoneAlternative },
        ]}
        load={loadVendorPhones}
      />
    </section>
  );
  const course = <Course request={request} onChange={onChange} />;

  return (
    <div className="stack">
      <div className="request-head">
        <p className="pills">
          <SlaPill sla={request.sla} dueAt={request.slaDueAt} />
          {note ? <RequestStatusPill status={request.status} /> : null}
        </p>
        {can("requests.write") && <RequestActions request={request} onChange={onChange} />}
      </div>
      {stacked ? (
        // Телефон и планшет: сначала главное — что и когда, клиент, как дозвониться вендору
        <>
          {facts}
          {client}
          {phones}
          {course}
        </>
      ) : (
        <div className="columns">
          <div className="stack">
            {facts}
            {course}
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

/**
 * Действия — в строке заголовка (компьютер) или в панели над нижней навигацией (телефон);
 * пояснение — только когда действия нет (никто не привязал Telegram, пауза между напоминаниями,
 * ответ уже есть)
 */
function RequestActions({
  request,
  onChange,
}: {
  request: StaffRequestDetail;
  onChange: (request: StaffRequestDetail) => void;
}) {
  const { api } = useSession();
  const toast = useToast();
  const contactButton = useRef<HTMLButtonElement>(null);
  const [contacting, setContacting] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);

  if (!request.awaiting) return <p className="muted small request-hint">{t.notAwaiting}</p>;

  const remind = async () => {
    setBusy(true);
    const result = await api.post<StaffRequestDetail>(`/staff/requests/${request.id}/remind`);
    setBusy(false);
    setFailure(result.ok ? null : result);
    if (result.ok) {
      toast(t.remindSent, { tone: "success" });
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
    <>
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
      {unreachable || paused ? (
        <p className="muted small request-hint">
          {unreachable ? t.remindUnreachable : t.remindAgainAt(formatMoment(request.nextReminderAt))}
        </p>
      ) : null}
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
    </>
  );
}

// ── ход заявки ─────────────────────────────────────────────────────────────

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

/** Ответ вендора в журнале статусов: по нему шаг «Первый ответ» срока уже виден */
const RESPONSES: ReadonlySet<RequestStatus> = new Set(["contacted", "deal", "declined"]);
/** Время ответа в сроке и в журнале статусов — одно, но записаны они раздельно */
const SAME_MOMENT_MS = 60_000;

export interface Step {
  readonly key: string;
  readonly at: string;
  readonly kind: "event" | "status" | "note";
  readonly text: string;
  /** Кто: исполнитель статуса, автор заметки */
  readonly by?: string;
  /** Подпись мелким: доставка напоминания */
  readonly detail?: string;
  /** Причина или текст заметки */
  readonly body?: string;
}

/**
 * Ход заявки одним потоком по времени: шаги срока (создана, открыта, напоминания, срок), смены
 * статуса и заметки команды. То, что срок и журнал статусов говорят вдвоём — создание, просмотр,
 * первый ответ, — показано один раз
 */
export function courseOf(request: StaffRequestDetail): Step[] {
  const hasViewed = request.timeline.some((event) => event.kind === "viewed");
  // Кто открыл заявку, знает только журнал статусов: имя — к шагу «Вендор открыл заявку»
  const viewedBy = request.history.find((entry) => entry.to === "viewed" && entry.from !== null);
  const answered = request.history.filter((entry) => RESPONSES.has(entry.to));
  const steps: Step[] = [];
  for (const event of request.timeline) {
    if (
      event.kind === "response" &&
      answered.some((entry) => Math.abs(Date.parse(entry.at) - Date.parse(event.at)) < SAME_MOMENT_MS)
    )
      continue;
    steps.push({
      key: `${event.kind}-${event.at}`,
      at: event.at,
      kind: "event",
      text: eventText(event),
      ...(event.kind === "viewed" && viewedBy ? { by: actorOf(viewedBy) } : {}),
      ...(event.kind === "reminder"
        ? { detail: t.reminderDelivery(event.recipients, event.delivered, event.failed) }
        : {}),
    });
  }
  for (const entry of request.history) {
    // Создание и первый просмотр — шаги срока выше
    if (entry.from === null || (entry.to === "viewed" && hasViewed)) continue;
    steps.push({
      key: `status-${entry.at}-${entry.to}`,
      at: entry.at,
      kind: "status",
      text: t.requestStatus[entry.to] ?? entry.to,
      by: actorOf(entry),
      ...(entry.reason ? { body: entry.reason } : {}),
    });
  }
  for (const note of request.notes) {
    steps.push({
      key: `note-${note.id}`,
      at: note.at,
      kind: "note",
      text: t.note,
      ...(note.authorName ? { by: note.authorName } : {}),
      body: note.text,
    });
  }
  // Сортировка устойчивая: на одно время шаг срока идёт раньше смены статуса и заметки
  return steps.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

function Course({
  request,
  onChange,
}: {
  request: StaffRequestDetail;
  onChange: (request: StaffRequestDetail) => void;
}) {
  const can = useCan();
  const [adding, setAdding] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const steps = courseOf(request);
  return (
    <section className="panel" aria-labelledby="course-title">
      <div className="panel-head">
        <h2 id="course-title">{t.requestCourse}</h2>
        {can("requests.write") && !adding && (
          <button
            ref={addButton}
            type="button"
            className="btn btn-sm"
            aria-expanded={adding}
            onClick={() => setAdding(true)}
          >
            {t.noteAdd}
          </button>
        )}
      </div>
      <PhoneSheet open={adding} title={t.noteAdd} onClose={() => setAdding(false)} returnFocus={addButton}>
        <NoteForm request={request} onChange={onChange} onClose={() => setAdding(false)} />
      </PhoneSheet>
      <ol className="history timeline">
        {steps.map((step) => (
          <li key={step.key} className={`timeline-${step.kind}`}>
            <span className="sub">
              {formatMoment(step.at)}
              {step.by ? ` · ${step.by}` : ""}
            </span>
            <strong>{step.text}</strong>
            {step.detail ? <span className="sub">{step.detail}</span> : null}
            {step.body ? <p className="reason">{step.body}</p> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Новая заметка: видна только команде; добавить можно, изменить и удалить — нет */
function NoteForm({
  request,
  onChange,
  onClose,
}: {
  request: StaffRequestDetail;
  onChange: (request: StaffRequestDetail) => void;
  onClose: () => void;
}) {
  const { api } = useSession();
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
      onClose();
      onChange(result.data);
    }
  };

  return (
    <form className="note-form" onSubmit={add} noValidate>
      <label htmlFor={id}>{t.noteText}</label>
      <textarea
        id={id}
        className="input"
        rows={3}
        maxLength={1000}
        placeholder={t.noteHint}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="acts">
        <button
          type="submit"
          className="btn btn-primary"
          aria-busy={busy || undefined}
          disabled={busy || text.trim() === ""}
        >
          {busyLabel(t.addNote, busy)}
        </button>
        <button type="button" className="btn" onClick={onClose}>
          {t.cancel}
        </button>
      </div>
      {failure && <ErrorText failure={failure} />}
    </form>
  );
}

interface DetailProps {
  category: CategoryConfig | undefined;
  request: StaffRequestDetail;
}

/** Что нужно клиенту — поля формы заявки категории (часы, машины, вес, цвета…): строки «Что и когда» */
function RequestDetailRows({
  category,
  request,
  district,
}: DetailProps & { district: (code: string) => string | undefined }): ReactNode {
  const rows = detailRows("ru", category, request.details, district);
  return rows.map((row) => (
    <Fragment key={row.key}>
      <dt>{row.label}</dt>
      <dd>{row.value ?? t.yes}</dd>
    </Fragment>
  ));
}

/** Выбранные услуги с количеством и добавками: названия и цены — как были при подаче заявки */
function ChosenServices({ category, request }: DetailProps) {
  const services = chosenServices(category, request.details);
  if (services.length === 0) return null;
  return (
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
  );
}
