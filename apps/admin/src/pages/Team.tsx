/* Команда — только администратор: приглашение по имени пользователя Telegram, роль,
   отключение. Себя не отключить и роль не сменить; последнего администратора база не даст
   ни отключить, ни понизить. */

import type { StaffRole, TeamList, TeamMember } from "@bayramm/shared/api/staff";
import { type FormEvent, useId, useState } from "react";
import { type Failure, useLoad, useSession } from "../api";
import { formatMoment } from "../format";
import { t } from "../texts";
import { ConfirmForm, ErrorText, Field, fieldErrors, LoadedView, Pill } from "../ui";

const ROLES: readonly StaffRole[] = ["admin", "manager", "moderator"];

export function TeamPage() {
  const { loaded, reload, set } = useLoad<TeamList>("/staff/team");
  return (
    <div className="stack">
      <InviteForm onDone={set} />
      <LoadedView loaded={loaded} onRetry={reload}>
        {(list) => <Members list={list} onChange={set} />}
      </LoadedView>
    </div>
  );
}

function InviteForm({ onDone }: { onDone: (list: TeamList) => void }) {
  const { api } = useSession();
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<StaffRole>("manager");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [done, setDone] = useState(false);
  const errors = fieldErrors(failure, {
    displayName: t.inviteName,
    username: t.fieldErrors.telegramUsername ?? "",
    role: t.inviteRole,
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setDone(false);
    const result = await api.post<TeamList>("/staff/team", { displayName, username, role });
    setBusy(false);
    setFailure(result.ok ? null : result);
    if (result.ok) {
      setDone(true);
      setDisplayName("");
      setUsername("");
      onDone(result.data);
    }
  };

  return (
    <form className="fs" onSubmit={submit} noValidate>
      <div className="fs-head">
        <h2>{t.inviteTitle}</h2>
        <p>{t.inviteHint}</p>
      </div>
      <div className="fields fields-3">
        <Field label={t.inviteName} error={errors.displayName}>
          {(props) => (
            <input
              {...props}
              className="input"
              value={displayName}
              maxLength={80}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          )}
        </Field>
        <Field label={t.inviteUsername} error={errors.username}>
          {(props) => (
            <input
              {...props}
              className="input"
              value={username}
              maxLength={33}
              placeholder="@username"
              autoCapitalize="none"
              spellCheck={false}
              onChange={(event) => setUsername(event.target.value)}
            />
          )}
        </Field>
        <Field label={t.inviteRole} error={errors.role} hint={t.roleHints[role]}>
          {(props) => (
            <select
              {...props}
              className="input"
              value={role}
              onChange={(event) => setRole(event.target.value as StaffRole)}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {t.roles[r]}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <div className="acts invite-acts">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={busy || displayName.trim() === "" || username.trim() === ""}
        >
          {t.invite}
        </button>
        {done && (
          <span className="saved" role="status">
            {t.invited}
          </span>
        )}
      </div>
      {failure && failure.code !== "invalid_input" && <ErrorText failure={failure} />}
    </form>
  );
}

function Members({ list, onChange }: { list: TeamList; onChange: (list: TeamList) => void }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">{t.colName}</th>
            <th scope="col">{t.colRole}</th>
            <th scope="col">{t.colStatus}</th>
            <th scope="col">
              <span className="visually-hidden">{t.requestActions}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {list.items.map((member) => (
            <MemberRow key={member.id} member={member} onChange={onChange} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MemberRow({ member, onChange }: { member: TeamMember; onChange: (list: TeamList) => void }) {
  const { api } = useSession();
  const roleId = useId();
  const [role, setRole] = useState<StaffRole>(member.role);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  const changeRole = async () => {
    setBusy(true);
    const result = await api.post<TeamList>(`/staff/team/${member.id}/role`, { role });
    setBusy(false);
    setFailure(result.ok ? null : result);
    if (result.ok) onChange(result.data);
  };

  const toggle = async (): Promise<Failure | null> => {
    const result = await api.post<TeamList>(
      `/staff/team/${member.id}/${member.active ? "deactivate" : "activate"}`,
    );
    if (!result.ok) return result;
    setConfirming(false);
    onChange(result.data);
    return null;
  };

  return (
    <tr>
      <td>
        <strong>{member.displayName}</strong>
        {member.self && <span className="sub">{t.you}</span>}
        <span className="sub">{member.username ? `@${member.username}` : t.none}</span>
      </td>
      <td>
        {member.self || !member.active ? (
          t.roles[member.role]
        ) : (
          <div className="role-edit">
            <label htmlFor={roleId} className="visually-hidden">
              {t.changeRole}: {member.displayName}
            </label>
            <select
              id={roleId}
              className="input"
              value={role}
              onChange={(event) => setRole(event.target.value as StaffRole)}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {t.roles[r]}
                </option>
              ))}
            </select>
            {role !== member.role && (
              <button type="button" className="btn btn-sm" onClick={changeRole} disabled={busy}>
                {t.changeRole}
              </button>
            )}
          </div>
        )}
      </td>
      <td>
        {member.active ? (
          <Pill tone="outline">{t.memberActive}</Pill>
        ) : (
          <Pill tone="muted">{t.memberInactive}</Pill>
        )}
        <span className="sub">
          {member.linked && member.linkedAt ? t.memberLinked(formatMoment(member.linkedAt)) : t.memberPending}
        </span>
      </td>
      <td>
        {!member.self &&
          (confirming ? (
            <ConfirmForm
              hint={member.active ? t.deactivateHint : t.activate}
              submitLabel={member.active ? t.deactivate : t.activate}
              danger={member.active}
              onSubmit={toggle}
              onCancel={() => setConfirming(false)}
            />
          ) : (
            <button
              type="button"
              className={`btn btn-sm${member.active ? " btn-danger" : ""}`}
              onClick={() => setConfirming(true)}
            >
              {member.active ? t.deactivate : t.activate}
            </button>
          ))}
        {failure && <ErrorText failure={failure} />}
      </td>
    </tr>
  );
}
