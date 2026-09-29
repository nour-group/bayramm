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
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { useLoad } from "../api";
import { formatMoment } from "../format";
import type { View } from "../router";
import { t } from "../texts";
import { Link, LoadedView } from "../ui";

type Tab = "actions" | "pii";

const PAGE = 50;
const FILTER_KEYS = ["actor", "actorKind", "type", "object", "action", "from", "to"] as const;
type FilterKey = (typeof FILTER_KEYS)[number];
type Filters = Partial<Record<FilterKey, string>>;

const ACTOR_KINDS = ["staff", "vendor_user", "client", "system"] as const;

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
  const [state, setState] = useState(() => initialState(window.location.search));
  const [draft, setDraft] = useState<Filters>(state.filters);
  const [offset, setOffset] = useState(0);

  const apply = (tab: Tab, filters: Filters) => {
    setState({ tab, filters });
    setOffset(0);
    const query = queryOf(tab, filters).toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
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
      {state.tab === "pii" ? (
        <PiiList path={path} offset={offset} onPage={setOffset} />
      ) : (
        <ActionList path={path} offset={offset} onPage={setOffset} />
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

  return (
    <form className="panel filters" onSubmit={submit} noValidate>
      <div className="fields fields-3">
        <FilterField id={`${id}-actor`} label={t.auditActor}>
          <select
            id={`${id}-actor`}
            className="input"
            value={draft.actor ?? ""}
            onChange={(event) => set("actor")(event.target.value)}
          >
            <option value="">{t.auditActorAny}</option>
            {(dictionaries?.staff ?? []).map((member) => (
              <option key={member.id} value={member.id}>
                {member.displayName}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField id={`${id}-kind`} label={t.auditActorKind}>
          <select
            id={`${id}-kind`}
            className="input"
            value={draft.actorKind ?? ""}
            onChange={(event) => set("actorKind")(event.target.value)}
          >
            <option value="">{t.auditActorAny}</option>
            {ACTOR_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t.historyBy[kind]}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField id={`${id}-type`} label={t.auditType}>
          <select
            id={`${id}-type`}
            className="input"
            value={draft.type ?? ""}
            onChange={(event) => set("type")(event.target.value)}
          >
            <option value="">{t.auditTypeAny}</option>
            {Object.entries(types).map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField id={`${id}-object`} label={t.auditObject}>
          <input
            id={`${id}-object`}
            className="input"
            value={draft.object ?? ""}
            maxLength={100}
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
              placeholder="listing."
              onChange={(event) => set("action")(event.target.value)}
            />
          </FilterField>
        )}
        <FilterField id={`${id}-from`} label={t.auditFrom}>
          <input
            id={`${id}-from`}
            className="input"
            type="date"
            value={draft.from ?? ""}
            onChange={(event) => set("from")(event.target.value)}
          />
        </FilterField>
        <FilterField id={`${id}-to`} label={t.auditTo}>
          <input
            id={`${id}-to`}
            className="input"
            type="date"
            value={draft.to ?? ""}
            onChange={(event) => set("to")(event.target.value)}
          />
        </FilterField>
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

function ObjectRef({ type, id, labels }: { type: string; id: string; labels: Record<string, string> }) {
  const view = objectView(type, id);
  const short = id.length > 13 ? `${id.slice(0, 8)}…` : id;
  return (
    <>
      {labels[type] ?? type}
      <span className="sub">{view ? <Link to={view}>{short}</Link> : short}</span>
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

function ActionList({ path, offset, onPage }: ListProps) {
  const { loaded, reload } = useLoad<AuditList>(path);
  return (
    <LoadedView loaded={loaded} onRetry={reload}>
      {(list) =>
        list.items.length === 0 ? (
          <p className="empty">{t.auditEmpty}</p>
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

function PiiList({ path, offset, onPage }: ListProps) {
  const { loaded, reload } = useLoad<PiiAccessList>(path);
  return (
    <LoadedView loaded={loaded} onRetry={reload}>
      {(list) =>
        list.items.length === 0 ? (
          <p className="empty">{t.auditEmpty}</p>
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
