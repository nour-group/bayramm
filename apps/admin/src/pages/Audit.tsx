/* Журнал: действия в панели и просмотры телефонов — только чтение. Записи пишет база;
   в подробностях — ключи и имена полей словами, где они известны (значений ПДн там нет), id
   (UUID) не показываются: объект — ссылкой в своей колонке, подписанной словами (название
   витрины, «№1051», код клиента, имя), а нет подписи — коротким id. Действие в фильтре — группой
   («Витрины», «Заявки»): на сервер уходит начало кода (listing.).
   Фильтры — в адресе страницы (?type=&object=…): ссылку можно переслать. Сначала список, фильтры —
   в листе «Фильтры» (и на компьютере тоже) и действуют сразу, без кнопки «Показать».

   Объект выбирают поиском, а не вписывают id: что искать, решает «Объект» — вендора по
   названию или коду, витрину по названию, клиента по коду C-… или номеру заявки, заявку по
   номеру, сотрудника по имени. «Сотрудник» — и отключённые (с пометкой): их действия тоже в
   журнале; выбрать его можно, только когда «Кто» — сотрудник или любой. */

import type {
  AuditEntry,
  AuditList,
  ClientList,
  ListingList,
  PiiAccessEntry,
  PiiAccessList,
  StaffDictionaries,
  StaffRequestList,
  TeamList,
  VendorList,
} from "@bayramm/shared/api/staff";
import {
  type CalendarTexts,
  Combobox,
  DateField,
  Dialog,
  RadioGroup,
  Select,
  type SelectOption,
} from "@bayramm/ui/react";
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { type Api, useLoad, useSession } from "../api";
import { formatDay, formatMoment, vendorLabel } from "../format";
import { useLayout } from "../layout";
import { type View, writeQuery } from "../router";
import { t } from "../texts";
import { EmptyList, FilterButton, Link, LoadedView, Pager, TableWrap } from "../ui";
import { monthTitle, tashkentToday } from "./Calendar";

type Tab = "actions" | "pii";

const PAGE = 50;
const FILTER_KEYS = ["actor", "actorKind", "type", "object", "action", "from", "to"] as const;
type FilterKey = (typeof FILTER_KEYS)[number];
type Filters = Partial<Record<FilterKey, string>>;

const ACTOR_KINDS = ["staff", "vendor_user", "client", "account", "system"] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Статусы витрины и роли — «было → стало» в подробностях */
const STATE_WORDS: Readonly<Record<string, string>> = { ...t.status, ...t.roles };
/** Подробности, значение которых — статус или роль; via — как пригласили сотрудника */
const STATE_KEYS: ReadonlySet<string> = new Set(["from", "to", "status", "role"]);

/** Группы действий и, если в ссылке своё начало кода, — оно тоже (как записано) */
function actionOptions(current: string | undefined) {
  const known = Object.entries(t.auditActionGroups).map(([value, label]) => ({ value, label }));
  const extra = current && !(current in t.auditActionGroups) ? [{ value: current, label: current }] : [];
  return [{ value: "", label: t.auditActionAny }, ...known, ...extra];
}

const dayName = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" });

/** Календарь фильтра дат: без пометок «свободно/занято» — здесь выбирают период журнала */
const CALENDAR_TEXTS: CalendarTexts = {
  prev: t.prevMonth,
  next: t.nextMonth,
  weekdays: t.weekdays,
  monthTitle: (month) => monthTitle(month.slice(0, 7)),
  dayLabel: (day) => dayName.format(new Date(`${day}T00:00:00Z`)),
  free: "",
  busy: "",
  selected: "",
};

/** Фильтры из адреса страницы: так их можно переслать ссылкой */
function initialState(search: string): { tab: Tab; filters: Filters } {
  const params = new URLSearchParams(search);
  const filters: Filters = {};
  for (const key of FILTER_KEYS) {
    const value = params.get(key)?.trim();
    if (value) filters[key] = value.slice(0, 100);
  }
  return { tab: params.get("tab") === "pii" ? "pii" : "actions", filters };
}

// ── поиск объекта ──────────────────────────────────────────────────────────

/** Вид объекта фильтра → где его искать (контакт заявки — та же заявка, и так далее) */
type SearchKind = "vendor" | "listing" | "client" | "request" | "staff";

const SEARCH_OF: Readonly<Record<string, SearchKind>> = {
  vendor: "vendor",
  vendor_contact: "vendor",
  vendor_inbox: "vendor",
  listing: "listing",
  listing_contact: "listing",
  client: "client",
  request: "request",
  request_contact: "request",
  staff: "staff",
};

/** Сколько вариантов показать в поиске: это выбор, а не список */
const FOUND = 20;

/** Варианты по строке поиска — тем же API, что разделы панели (ПДн в подписях нет) */
async function findObjects(
  api: Api,
  kind: Exclude<SearchKind, "staff">,
  query: string,
): Promise<SelectOption[] | null> {
  const q = encodeURIComponent(query);
  switch (kind) {
    case "vendor": {
      const result = await api.get<VendorList>(`/staff/vendors?q=${q}&limit=${FOUND}`);
      return result.ok
        ? result.data.items.map((v) => ({ value: v.id, label: vendorLabel({ name: v.name, code: v.code }) }))
        : null;
    }
    case "listing": {
      const result = await api.get<ListingList>(`/staff/listings?q=${q}&limit=${FOUND}`);
      return result.ok
        ? result.data.items.map((l) => ({ value: l.id, label: l.name, hint: vendorLabel(l.vendor) }))
        : null;
    }
    case "client": {
      const result = await api.get<ClientList>(`/staff/clients?q=${q}&limit=${FOUND}`);
      return result.ok
        ? result.data.items.map((c) => ({
            value: c.id,
            label: c.ref,
            ...(c.displayName ? { hint: c.displayName } : {}),
          }))
        : null;
    }
    case "request": {
      // Заявку — по номеру: иначе в поиск попали бы и названия витрин
      if (query !== "" && !/^\d{1,12}$/.test(query)) return [];
      const result = await api.get<StaffRequestList>(`/staff/requests?q=${q}&limit=${FOUND}`);
      return result.ok
        ? result.data.items.map((r) => ({
            value: r.id,
            label: t.requestNo(r.publicNo),
            hint: r.listing.name,
          }))
        : null;
    }
  }
}

/**
 * Поиск объекта для фильтра: строка — с задержкой, ответ на устаревшую строку отбрасывается.
 * Сотрудники — из команды (их немного), без запроса на каждую букву
 */
function useObjectSearch(kind: SearchKind | null, staff: readonly SelectOption[]) {
  const { api } = useSession();
  const [query, setQuery] = useState<string | null>(null);
  const [found, setFound] = useState<{ query: string; options: readonly SelectOption[] } | null>(null);
  const latest = useRef<string | null>(null);
  // Другой вид объекта — прежние варианты не годятся
  // biome-ignore lint/correctness/useExhaustiveDependencies: kind — повод начать поиск заново
  useEffect(() => {
    setFound(null);
    setQuery(null);
  }, [kind]);
  useEffect(() => {
    if (query === null || kind === null || kind === "staff") return;
    latest.current = query;
    const timer = setTimeout(() => {
      void findObjects(api, kind, query.trim()).then((options) => {
        if (latest.current === query) setFound({ query, options: options ?? [] });
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [api, kind, query]);
  if (kind === "staff") {
    const needle = (query ?? "").trim().toLowerCase();
    return {
      options: staff.filter((member) => member.label.toLowerCase().includes(needle)),
      loading: false,
      search: setQuery,
    };
  }
  return {
    options: found?.options ?? [],
    loading: query !== null && found?.query !== query,
    search: setQuery,
  };
}

function queryOf(tab: Tab, filters: Filters, offset = 0): URLSearchParams {
  const params = new URLSearchParams();
  if (tab === "pii") params.set("tab", "pii");
  for (const key of FILTER_KEYS) {
    const value = filters[key];
    if (value) params.set(key, value);
  }
  if (offset > 0) params.set("offset", String(offset));
  return params;
}

/** Сотрудники для фильтра: действующие, потом отключённые — с пометкой (их действия тоже в журнале) */
function staffOptions(team: TeamList | null, dictionaries: StaffDictionaries | null): SelectOption[] {
  if (team === null)
    return (dictionaries?.staff ?? []).map((member) => ({ value: member.id, label: member.displayName }));
  const order = [...team.items].sort((a, b) => Number(b.active) - Number(a.active));
  return order.map((member) => ({
    value: member.id,
    label: member.active ? member.displayName : t.auditStaffInactive(member.displayName),
  }));
}

export function AuditPage({ dictionaries }: { dictionaries: StaffDictionaries | null }) {
  // Таблица — только на компьютере: пять колонок на планшете обрезались бы справа
  const cards = useLayout() !== "desktop";
  const [state, setState] = useState(() => initialState(window.location.search));
  const [offset, setOffset] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const active = FILTER_KEYS.filter((key) => Boolean(state.filters[key])).length;
  const { loaded: teamLoaded } = useLoad<TeamList>("/staff/team");
  const staff = staffOptions(teamLoaded.state === "ready" ? teamLoaded.data : null, dictionaries);
  // Подписи найденных объектов (и из записей журнала): выбранный показывается словами, а не id
  const [labels, setLabels] = useState<ReadonlyMap<string, string>>(() => new Map());
  // Подпись из поиска — главная; подписи из записей журнала только дополняют (иначе выбранный
  // «Lola · V101» после применения фильтра сменился бы на название из записи)
  const remember = useCallback((options: readonly SelectOption[], keep = false) => {
    setLabels((prev) => {
      const fresh = options.filter((option) =>
        keep ? !prev.has(option.value) : prev.get(option.value) !== option.label,
      );
      if (fresh.length === 0) return prev;
      const next = new Map(prev);
      for (const option of fresh) next.set(option.value, option.label);
      return next;
    });
  }, []);

  const apply = (tab: Tab, filters: Filters) => {
    setState({ tab, filters });
    setOffset(0);
    // Запись истории — та же (её номер нужен «назад» панели), меняется только адрес
    writeQuery(["tab", ...FILTER_KEYS], Object.fromEntries(queryOf(tab, filters)));
  };
  const reset = () => apply(state.tab, {});

  const params = queryOf(state.tab, state.filters, offset);
  params.delete("tab");
  params.set("limit", String(PAGE));
  const path = state.tab === "pii" ? `/staff/audit/pii?${params}` : `/staff/audit?${params}`;
  const closeFilters = () => setFiltersOpen(false);

  return (
    <div className="stack">
      <div className="toolbar">
        <RadioGroup<Tab>
          variant="pill"
          label={t.audit}
          name="audit-tab"
          value={state.tab}
          onChange={(tab) => apply(tab, state.filters)}
          options={(["actions", "pii"] as const).map((tab) => ({ value: tab, label: t.auditTabs[tab] }))}
        />
        <FilterButton count={active} open={filtersOpen} onOpen={() => setFiltersOpen(true)} />
      </div>
      <Dialog
        open={filtersOpen}
        title={t.filters}
        onClose={closeFilters}
        actions={
          <>
            <button
              type="button"
              className="ui-btn ui-btn-secondary"
              onClick={() => {
                reset();
                closeFilters();
              }}
            >
              {t.auditReset}
            </button>
            <button type="button" className="ui-btn ui-btn-primary" onClick={closeFilters}>
              {t.done}
            </button>
          </>
        }
      >
        <FilterForm
          tab={state.tab}
          filters={state.filters}
          onChange={(filters) => apply(state.tab, filters)}
          dictionaries={dictionaries}
          staff={staff}
          labels={labels}
          onFound={remember}
        />
      </Dialog>
      {state.tab === "pii" ? (
        <PiiList
          path={path}
          offset={offset}
          onPage={setOffset}
          cards={cards}
          onReset={active > 0 ? reset : null}
          onLabels={remember}
        />
      ) : (
        <ActionList
          path={path}
          offset={offset}
          onPage={setOffset}
          cards={cards}
          onReset={active > 0 ? reset : null}
          onLabels={remember}
        />
      )}
    </div>
  );
}

// ── фильтры ────────────────────────────────────────────────────────────────

interface FilterFormProps {
  tab: Tab;
  /** Действующие фильтры: каждое изменение применяется сразу */
  filters: Filters;
  onChange: (filters: Filters) => void;
  dictionaries: StaffDictionaries | null;
  /** Сотрудники: действующие и отключённые */
  staff: readonly SelectOption[];
  /** Известные подписи объектов по id */
  labels: ReadonlyMap<string, string>;
  /** Нашли объекты — запомнить их подписи */
  onFound: (options: readonly SelectOption[]) => void;
}

function FilterForm({ tab, filters, onChange, staff, labels, onFound }: FilterFormProps) {
  const id = useId();
  const set = (key: FilterKey) => (value: string) => onChange({ ...filters, [key]: value });
  // Сотрудник — только у действий сотрудников: выбрали другого «Кто» — сотрудника не держим
  const staffOnly = !filters.actorKind || filters.actorKind === "staff";
  const searchKind = filters.type ? (SEARCH_OF[filters.type] ?? null) : null;
  const objects = useObjectSearch(searchKind, staff);
  useEffect(() => onFound(objects.options), [objects.options, onFound]);
  const objectLabel = filters.object
    ? (labels.get(filters.object) ??
      (filters.object.length > 13 ? `${filters.object.slice(0, 8)}…` : filters.object))
    : null;
  const types = tab === "pii" ? t.piiSubjects : t.auditTypes;
  // Журнал — не старше двух лет назад и не позже сегодняшнего дня по Ташкенту
  const today = tashkentToday();
  const earliest = `${Number(today.slice(0, 4)) - 2}-01-01`;
  const date = (key: "from" | "to", label: string, min: string, max: string) => (
    <FilterField id={`${id}-${key}`} label={label}>
      <DateField
        id={`${id}-${key}`}
        className="input"
        label={label}
        placeholder={t.auditAnyDate}
        value={filters[key] ?? null}
        min={min}
        max={max}
        defaultMonth={max}
        legend={false}
        format={formatDay}
        texts={CALENDAR_TEXTS}
        clearLabel={t.auditNoDate}
        onChange={(value) => set(key)(value ?? "")}
      />
    </FilterField>
  );

  return (
    <div className="filters-sheet">
      <FilterField id={`${id}-type`} label={t.auditType}>
        <Select
          id={`${id}-type`}
          className="input"
          label={t.auditType}
          value={filters.type ?? ""}
          // Другой вид — прежний объект к нему не относится
          onChange={(type) => onChange({ ...filters, type, object: "" })}
          options={[
            { value: "", label: t.auditTypeAny },
            ...Object.entries(types).map(([code, label]) => ({ value: code, label })),
          ]}
        />
      </FilterField>
      <FilterField id={`${id}-object`} label={t.auditObject}>
        <Combobox
          id={`${id}-object`}
          className="input"
          label={t.auditObject}
          value={filters.object || null}
          valueLabel={objectLabel}
          options={objects.options}
          anyLabel={t.auditObjectAny}
          placeholder={t.auditObjectAny}
          searchPlaceholder={searchKind ? t.auditObjectHints[searchKind] : undefined}
          loading={objects.loading}
          loadingText={t.auditObjectSearching}
          emptyText={t.auditObjectEmpty}
          disabled={searchKind === null && !filters.object}
          aria-describedby={searchKind === null && !filters.object ? `${id}-object-note` : undefined}
          onSearch={objects.search}
          onChange={(value) => set("object")(value ?? "")}
        />
        {searchKind === null && !filters.object ? (
          <span id={`${id}-object-note`} className="field-hint">
            {filters.type ? t.auditObjectNoSearch : t.auditObjectPickType}
          </span>
        ) : null}
      </FilterField>
      {tab === "actions" && (
        <FilterField id={`${id}-action`} label={t.auditAction}>
          <Select
            id={`${id}-action`}
            className="input"
            label={t.auditAction}
            value={filters.action ?? ""}
            onChange={set("action")}
            options={actionOptions(filters.action)}
          />
        </FilterField>
      )}
      <FilterField id={`${id}-kind`} label={t.auditActorKind}>
        <Select
          id={`${id}-kind`}
          className="input"
          label={t.auditActorKind}
          value={filters.actorKind ?? ""}
          onChange={(kind) =>
            onChange({ ...filters, actorKind: kind, ...(kind && kind !== "staff" ? { actor: "" } : {}) })
          }
          options={[
            { value: "", label: t.auditActorAny },
            ...ACTOR_KINDS.map((kind) => ({ value: kind, label: t.historyBy[kind] ?? kind })),
          ]}
        />
      </FilterField>
      <FilterField id={`${id}-actor`} label={t.auditActor}>
        <Select
          id={`${id}-actor`}
          className="input"
          label={t.auditActor}
          value={staffOnly ? (filters.actor ?? "") : ""}
          disabled={!staffOnly}
          aria-describedby={staffOnly ? undefined : `${id}-actor-note`}
          onChange={set("actor")}
          options={[{ value: "", label: t.auditActorAny }, ...staff]}
        />
        {staffOnly ? null : (
          <span id={`${id}-actor-note`} className="field-hint">
            {t.auditActorStaffOnly}
          </span>
        )}
      </FilterField>
      <div className="filters-dates">
        {date("from", t.auditFrom, earliest, filters.to || today)}
        {date("to", t.auditTo, filters.from || earliest, today)}
      </div>
    </div>
  );
}

function FilterField({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
    </div>
  );
}

// ── записи ─────────────────────────────────────────────────────────────────

/** Ссылка на объект, у которого в панели есть страница */
function objectView(type: string, id: string): View | null {
  if (!UUID.test(id)) return null;
  switch (type) {
    case "listing":
    case "listing_contact":
      return { name: "listing", id };
    case "vendor":
    case "vendor_contact":
    case "vendor_inbox":
      return { name: "vendor", id };
    case "request":
    case "request_contact":
      return { name: "request", id };
    case "client":
      return { name: "client", id };
    default:
      return null;
  }
}

function ObjectRef({
  type,
  id,
  label,
  labels,
  inline = false,
}: {
  type: string;
  id: string;
  /** Объект словами от сервера; null — подписи нет (удалён, вид без названия): показываем короткий id */
  label: string | null;
  labels: Record<string, string>;
  /** В строку (карточка на телефоне), а не второй строкой ячейки */
  inline?: boolean;
}) {
  const view = objectView(type, id);
  const short = id.length > 13 ? `${id.slice(0, 8)}…` : id;
  const shown = label ?? short;
  const ref = view ? <Link to={view}>{shown}</Link> : shown;
  if (inline)
    return (
      <>
        {labels[type] ?? type} · {ref}
      </>
    );
  return (
    <>
      {labels[type] ?? type}
      <span className="sub">{ref}</span>
    </>
  );
}

/** Значение подробности словами: имена полей и статусы — по словарям, UUID не показываем */
function detailValue(key: string, value: unknown): string | null {
  if (typeof value === "string" && UUID.test(value)) return null;
  if (Array.isArray(value))
    return value
      .map((item) => (key === "fields" ? (t.auditFields[String(item)] ?? String(item)) : item))
      .join(", ");
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  const raw = String(value);
  if (key === "via") return t.auditVia[raw] ?? raw;
  return STATE_KEYS.has(key) ? (STATE_WORDS[raw] ?? raw) : raw;
}

/** «поля: название, цена от · было: Черновик»; пусто — когда показывать нечего */
export function detailText(detail: Readonly<Record<string, unknown>>): string {
  return Object.entries(detail)
    .flatMap(([key, value]) => {
      const shown = detailValue(key, value);
      return shown === null ? [] : [`${t.auditDetailKeys[key] ?? key}: ${shown}`];
    })
    .join(" · ");
}

/** Кто: сотрудник — по имени, партнёр и клиент — «имя · вендор», «C-… · клиент»; без подписи — вид и короткий id */
function actorText(entry: { actorKind: string; actor: { id: string; name: string | null } | null }) {
  const kind = t.historyBy[entry.actorKind] ?? entry.actorKind;
  if (entry.actor?.name)
    return entry.actorKind === "staff" ? entry.actor.name : `${entry.actor.name} · ${kind}`;
  return entry.actor ? `${kind} ${entry.actor.id.slice(0, 8)}…` : kind;
}

interface ListProps {
  path: string;
  offset: number;
  onPage: (offset: number) => void;
  /** Не компьютер: записи — карточками */
  cards: boolean;
  /** Фильтры заданы: пустой журнал — с «Сбросить фильтры» */
  onReset: (() => void) | null;
  /** Подписи объектов из записей: выбранный в фильтре объект — словами */
  onLabels: (options: readonly SelectOption[], keep?: boolean) => void;
}

/** Журнал листают от новых к старым: «Новее» и «Старше» */
function JournalPager({
  total,
  offset,
  onPage,
}: {
  total: number;
  offset: number;
  onPage: (o: number) => void;
}) {
  return (
    <Pager
      total={total}
      offset={offset}
      size={PAGE}
      onPage={onPage}
      prevLabel={t.auditPrev}
      nextLabel={t.auditNext}
    />
  );
}

/** Объекты записей — подписи для фильтра: id → «Lola zali», «№1051» */
function useEntryLabels(
  loaded: ReturnType<typeof useLoad<AuditList | PiiAccessList>>["loaded"],
  onLabels: ListProps["onLabels"],
) {
  useEffect(() => {
    if (loaded.state !== "ready") return;
    onLabels(
      loaded.data.items.flatMap((entry) => {
        const [objectId, label] =
          "objectId" in entry ? [entry.objectId, entry.objectLabel] : [entry.subjectId, entry.subjectLabel];
        return label ? [{ value: objectId, label }] : [];
      }),
      true,
    );
  }, [loaded, onLabels]);
}

function ActionList({ path, offset, onPage, cards, onReset, onLabels }: ListProps) {
  const { loaded, reload } = useLoad<AuditList>(path);
  useEntryLabels(loaded, onLabels);
  return (
    <LoadedView loaded={loaded} onRetry={reload}>
      {(list) =>
        list.items.length === 0 ? (
          <EmptyList text={t.auditEmpty} onReset={onReset} />
        ) : cards ? (
          <>
            <ul className="rcards">
              {list.items.map((entry: AuditEntry) => (
                <li key={entry.id} className="rcard">
                  <p className="rcard-meta">
                    {formatMoment(entry.at)} · {actorText(entry)}
                  </p>
                  <p className="rcard-title">{t.auditActions[entry.action] ?? entry.action}</p>
                  <p className="rcard-meta detail-cell">
                    <ObjectRef
                      type={entry.objectType}
                      id={entry.objectId}
                      label={entry.objectLabel}
                      labels={t.auditTypes}
                      inline
                    />
                    {detailText(entry.detail) ? ` · ${detailText(entry.detail)}` : ""}
                  </p>
                </li>
              ))}
            </ul>
            <JournalPager total={list.total} offset={offset} onPage={onPage} />
          </>
        ) : (
          <>
            <TableWrap label={t.auditTabs.actions}>
              <table className="table audit-table">
                <thead>
                  <tr>
                    <th scope="col">{t.colWhen}</th>
                    <th scope="col">{t.colActor}</th>
                    <th scope="col">{t.colAction}</th>
                    <th scope="col">{t.colObject}</th>
                    <th scope="col">{t.colDetail}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.items.map((entry: AuditEntry) => (
                    <tr key={entry.id}>
                      <td>{formatMoment(entry.at)}</td>
                      <td>{actorText(entry)}</td>
                      <td>{t.auditActions[entry.action] ?? entry.action}</td>
                      <td>
                        <ObjectRef
                          type={entry.objectType}
                          id={entry.objectId}
                          label={entry.objectLabel}
                          labels={t.auditTypes}
                        />
                      </td>
                      <td className="detail-cell">{detailText(entry.detail) || t.none}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            <JournalPager total={list.total} offset={offset} onPage={onPage} />
          </>
        )
      }
    </LoadedView>
  );
}

function PiiList({ path, offset, onPage, cards, onReset, onLabels }: ListProps) {
  const { loaded, reload } = useLoad<PiiAccessList>(path);
  useEntryLabels(loaded, onLabels);
  return (
    <LoadedView loaded={loaded} onRetry={reload}>
      {(list) =>
        list.items.length === 0 ? (
          <EmptyList text={t.auditEmpty} onReset={onReset} />
        ) : cards ? (
          <>
            <ul className="rcards">
              {list.items.map((entry: PiiAccessEntry) => (
                <li key={entry.id} className="rcard">
                  <p className="rcard-meta">
                    {formatMoment(entry.at)} · {actorText(entry)}
                  </p>
                  <p className="rcard-title">{t.piiPurposes[entry.purpose] ?? entry.purpose}</p>
                  <p className="rcard-meta detail-cell">
                    <ObjectRef
                      type={entry.subjectKind}
                      id={entry.subjectId}
                      label={entry.subjectLabel}
                      labels={t.piiSubjects}
                      inline
                    />
                    {entry.reason ? ` · ${entry.reason}` : ""}
                  </p>
                </li>
              ))}
            </ul>
            <JournalPager total={list.total} offset={offset} onPage={onPage} />
          </>
        ) : (
          <>
            <TableWrap label={t.auditTabs.pii}>
              <table className="table audit-table">
                <thead>
                  <tr>
                    <th scope="col">{t.colWhen}</th>
                    <th scope="col">{t.colActor}</th>
                    <th scope="col">{t.colObject}</th>
                    <th scope="col">{t.colPurpose}</th>
                    <th scope="col">{t.reason}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.items.map((entry: PiiAccessEntry) => (
                    <tr key={entry.id}>
                      <td>{formatMoment(entry.at)}</td>
                      <td>{actorText(entry)}</td>
                      <td>
                        <ObjectRef
                          type={entry.subjectKind}
                          id={entry.subjectId}
                          label={entry.subjectLabel}
                          labels={t.piiSubjects}
                        />
                      </td>
                      <td>{t.piiPurposes[entry.purpose] ?? entry.purpose}</td>
                      <td className="detail-cell">{entry.reason ?? t.none}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            <JournalPager total={list.total} offset={offset} onPage={onPage} />
          </>
        )
      }
    </LoadedView>
  );
}
