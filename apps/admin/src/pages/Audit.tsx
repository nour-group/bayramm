/* Журнал: действия в панели и просмотры телефонов — только чтение. Записи пишет база;
   в подробностях — коды, id и имена полей, как записано (значений ПДн там нет).
   Фильтры — в адресе страницы (?type=&object=…): ссылку можно переслать. */

import type {
  AuditEntry,
  AuditList,
  PiiAccessEntry,
  PiiAccessList,
  StaffDictionaries,
} from "@bayramm/shared/api/staff";
import { type CalendarTexts, DateField, Dialog, Select } from "@bayramm/ui/react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { useLoad } from "../api";
import { formatDay, formatMoment } from "../format";
import { usePhone } from "../layout";
import type { View } from "../router";
import { t } from "../texts";
import { FilterButton, Link, LoadedView } from "../ui";
import { monthTitle, tashkentToday } from "./Calendar";

type Tab = "actions" | "pii";

const PAGE = 50;
const FILTER_KEYS = ["actor", "actorKind", "type", "object", "action", "from", "to"] as const;
type FilterKey = (typeof FILTER_KEYS)[number];
type Filters = Partial<Record<FilterKey, string>>;

const ACTOR_KINDS = ["staff", "vendor_user", "client", "account", "system"] as const;

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

export function AuditPage({ dictionaries }: { dictionaries: StaffDictionaries | null }) {
  const phone = usePhone();
  const [state, setState] = useState(() => initialState(window.location.search));
  const [draft, setDraft] = useState<Filters>(state.filters);
  const [offset, setOffset] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const active = FILTER_KEYS.filter((key) => Boolean(state.filters[key])).length;

  const apply = (tab: Tab, filters: Filters) => {
    setState({ tab, filters });
    setOffset(0);
    const query = queryOf(tab, filters).toString();
    // Запись истории — та же (её номер нужен «назад» панели), меняется только адрес
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}`,
    );
  };

  const params = queryOf(state.tab, state.filters, offset);
  params.delete("tab");
  params.set("limit", String(PAGE));
  const path = state.tab === "pii" ? `/staff/audit/pii?${params}` : `/staff/audit?${params}`;

  return (
    <div className="stack">
      <fieldset className="chips">
        <legend className="visually-hidden">{t.audit}</legend>
        {(["actions", "pii"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            className="chip"
            aria-pressed={state.tab === tab}
            onClick={() => apply(tab, state.filters)}
          >
            {t.auditTabs[tab]}
          </button>
        ))}
      </fieldset>
      {phone ? (
        <div className="toolbar">
          <FilterButton count={active} open={filtersOpen} onOpen={() => setFiltersOpen(true)} />
        </div>
      ) : null}
      {phone ? (
        <Dialog open={filtersOpen} title={t.filters} onClose={() => setFiltersOpen(false)}>
          <FilterForm
            tab={state.tab}
            draft={draft}
            onDraft={setDraft}
            dictionaries={dictionaries}
            onApply={() => {
              apply(state.tab, draft);
              setFiltersOpen(false);
            }}
            onReset={() => {
              setDraft({});
              apply(state.tab, {});
              setFiltersOpen(false);
            }}
          />
        </Dialog>
      ) : (
        <FilterForm
          tab={state.tab}
          draft={draft}
          onDraft={setDraft}
          dictionaries={dictionaries}
          onApply={() => apply(state.tab, draft)}
          onReset={() => {
            setDraft({});
            apply(state.tab, {});
          }}
        />
      )}
      {state.tab === "pii" ? (
        <PiiList path={path} offset={offset} onPage={setOffset} phone={phone} />
      ) : (
        <ActionList path={path} offset={offset} onPage={setOffset} phone={phone} />
      )}
    </div>
  );
}

// ── фильтры ────────────────────────────────────────────────────────────────

interface FilterFormProps {
  tab: Tab;
  draft: Filters;
  onDraft: (filters: Filters) => void;
  dictionaries: StaffDictionaries | null;
  onApply: () => void;
  onReset: () => void;
}

function FilterForm({ tab, draft, onDraft, dictionaries, onApply, onReset }: FilterFormProps) {
  const id = useId();
  const set = (key: FilterKey) => (value: string) => onDraft({ ...draft, [key]: value });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onApply();
  };
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
        value={draft[key] ?? null}
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
    <form className="panel filters" onSubmit={submit} noValidate>
      <div className="fields fields-3">
        <FilterField id={`${id}-actor`} label={t.auditActor}>
          <Select
            id={`${id}-actor`}
            className="input"
            label={t.auditActor}
            value={draft.actor ?? ""}
            onChange={set("actor")}
            options={[
              { value: "", label: t.auditActorAny },
              ...(dictionaries?.staff ?? []).map((member) => ({
                value: member.id,
                label: member.displayName,
              })),
            ]}
          />
        </FilterField>
        <FilterField id={`${id}-kind`} label={t.auditActorKind}>
          <Select
            id={`${id}-kind`}
            className="input"
            label={t.auditActorKind}
            value={draft.actorKind ?? ""}
            onChange={set("actorKind")}
            options={[
              { value: "", label: t.auditActorAny },
              ...ACTOR_KINDS.map((kind) => ({ value: kind, label: t.historyBy[kind] ?? kind })),
            ]}
          />
        </FilterField>
        <FilterField id={`${id}-type`} label={t.auditType}>
          <Select
            id={`${id}-type`}
            className="input"
            label={t.auditType}
            value={draft.type ?? ""}
            onChange={set("type")}
            options={[
              { value: "", label: t.auditTypeAny },
              ...Object.entries(types).map(([code, label]) => ({ value: code, label })),
            ]}
          />
        </FilterField>
        <FilterField id={`${id}-object`} label={t.auditObject}>
          <input
            id={`${id}-object`}
            className="input"
            value={draft.object ?? ""}
            maxLength={100}
            autoComplete="off"
            enterKeyHint="search"
            onChange={(event) => set("object")(event.target.value)}
          />
        </FilterField>
        {tab === "actions" && (
          <FilterField id={`${id}-action`} label={t.auditAction}>
            <input
              id={`${id}-action`}
              className="input"
              value={draft.action ?? ""}
              maxLength={60}
              autoComplete="off"
              enterKeyHint="search"
              placeholder="listing."
              onChange={(event) => set("action")(event.target.value)}
            />
          </FilterField>
        )}
        {date("from", t.auditFrom, earliest, draft.to || today)}
        {date("to", t.auditTo, draft.from || earliest, today)}
      </div>
      <div className="acts">
        <button type="submit" className="btn btn-primary">
          {t.auditApply}
        </button>
        <button type="button" className="btn" onClick={onReset}>
          {t.auditReset}
        </button>
      </div>
    </form>
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
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
  if (!uuid) return null;
  switch (type) {
    case "listing":
      return { name: "listing", id };
    case "vendor":
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
  labels,
  inline = false,
}: {
  type: string;
  id: string;
  labels: Record<string, string>;
  /** В строку (карточка на телефоне), а не второй строкой ячейки */
  inline?: boolean;
}) {
  const view = objectView(type, id);
  const short = id.length > 13 ? `${id.slice(0, 8)}…` : id;
  const ref = view ? <Link to={view}>{short}</Link> : short;
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

function detailText(detail: Readonly<Record<string, unknown>>): string {
  return Object.entries(detail)
    .map(([key, value]) => {
      const shown = Array.isArray(value)
        ? value.join(", ")
        : typeof value === "object" && value !== null
          ? JSON.stringify(value)
          : String(value);
      return `${key}: ${shown}`;
    })
    .join(" · ");
}

function actorText(entry: { actorKind: string; actor: { id: string; name: string | null } | null }) {
  if (entry.actor?.name) return entry.actor.name;
  const kind = t.historyBy[entry.actorKind] ?? entry.actorKind;
  return entry.actor ? `${kind} ${entry.actor.id.slice(0, 8)}…` : kind;
}

interface ListProps {
  path: string;
  offset: number;
  onPage: (offset: number) => void;
  /** Телефон: записи — карточками */
  phone: boolean;
}

function Pager({ total, offset, onPage }: { total: number; offset: number; onPage: (o: number) => void }) {
  if (total <= PAGE) return <p className="muted small">{t.total(total)}</p>;
  return (
    <div className="toolbar">
      <button
        type="button"
        className="btn btn-sm"
        disabled={offset === 0}
        onClick={() => onPage(offset - PAGE)}
      >
        {t.auditPrev}
      </button>
      <span className="muted small">
        {offset + 1}–{Math.min(offset + PAGE, total)} · {t.total(total)}
      </span>
      <button
        type="button"
        className="btn btn-sm"
        disabled={offset + PAGE >= total}
        onClick={() => onPage(offset + PAGE)}
      >
        {t.auditNext}
      </button>
    </div>
  );
}

function ActionList({ path, offset, onPage, phone }: ListProps) {
  const { loaded, reload } = useLoad<AuditList>(path);
  return (
    <LoadedView loaded={loaded} onRetry={reload}>
      {(list) =>
        list.items.length === 0 ? (
          <p className="empty">{t.auditEmpty}</p>
        ) : phone ? (
          <>
            <ul className="rcards">
              {list.items.map((entry: AuditEntry) => (
                <li key={entry.id} className="rcard">
                  <p className="rcard-meta">
                    {formatMoment(entry.at)} · {actorText(entry)}
                  </p>
                  <p className="rcard-title">{t.auditActions[entry.action] ?? entry.action}</p>
                  <dl className="rcard-facts">
                    <dt>{t.colAction}</dt>
                    <dd>{entry.action}</dd>
                    <dt>{t.colObject}</dt>
                    <dd>
                      <ObjectRef type={entry.objectType} id={entry.objectId} labels={t.auditTypes} inline />
                    </dd>
                    <dt>{t.colDetail}</dt>
                    <dd className="detail-cell">{detailText(entry.detail) || t.none}</dd>
                  </dl>
                </li>
              ))}
            </ul>
            <Pager total={list.total} offset={offset} onPage={onPage} />
          </>
        ) : (
          <>
            <div className="table-wrap">
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
                      <td>
                        {t.auditActions[entry.action] ?? entry.action}
                        <span className="sub">{entry.action}</span>
                      </td>
                      <td>
                        <ObjectRef type={entry.objectType} id={entry.objectId} labels={t.auditTypes} />
                      </td>
                      <td className="detail-cell">{detailText(entry.detail) || t.none}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager total={list.total} offset={offset} onPage={onPage} />
          </>
        )
      }
    </LoadedView>
  );
}

function PiiList({ path, offset, onPage, phone }: ListProps) {
  const { loaded, reload } = useLoad<PiiAccessList>(path);
  return (
    <LoadedView loaded={loaded} onRetry={reload}>
      {(list) =>
        list.items.length === 0 ? (
          <p className="empty">{t.auditEmpty}</p>
        ) : phone ? (
          <>
            <ul className="rcards">
              {list.items.map((entry: PiiAccessEntry) => (
                <li key={entry.id} className="rcard">
                  <p className="rcard-meta">
                    {formatMoment(entry.at)} · {actorText(entry)}
                  </p>
                  <p className="rcard-title">{t.piiPurposes[entry.purpose] ?? entry.purpose}</p>
                  <dl className="rcard-facts">
                    <dt>{t.colObject}</dt>
                    <dd>
                      <ObjectRef
                        type={entry.subjectKind}
                        id={entry.subjectId}
                        labels={t.piiSubjects}
                        inline
                      />
                    </dd>
                    <dt>{t.reason}</dt>
                    <dd className="detail-cell">{entry.reason ?? t.none}</dd>
                  </dl>
                </li>
              ))}
            </ul>
            <Pager total={list.total} offset={offset} onPage={onPage} />
          </>
        ) : (
          <>
            <div className="table-wrap">
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
                        <ObjectRef type={entry.subjectKind} id={entry.subjectId} labels={t.piiSubjects} />
                      </td>
                      <td>
                        {t.piiPurposes[entry.purpose] ?? entry.purpose}
                        <span className="sub">{entry.purpose}</span>
                      </td>
                      <td className="detail-cell">{entry.reason ?? t.none}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager total={list.total} offset={offset} onPage={onPage} />
          </>
        )
      }
    </LoadedView>
  );
}
