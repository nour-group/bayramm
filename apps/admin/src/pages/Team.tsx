/* Команда — только администратор: приглашение по имени пользователя Telegram или по
   номеру телефона, роль, отключение. Номер проверяется здесь же (+998 и 9 цифр) и ещё раз
   сервером; хранится только его HMAC — в списке видно лишь «по телефону». Себя не
   отключить и роль не сменить; последнего администратора база не даст ни отключить, ни
   понизить. */

import { normalizeUzPhone } from "@bayramm/shared";
import type { StaffRole, TeamInviteInput, TeamList, TeamMember } from "@bayramm/shared/api/staff";
import { RadioGroup, Select } from "@bayramm/ui/react";
import { type FormEvent, useId, useState } from "react";
import { type Failure, useAuthMethods, useLoad, useSession } from "../api";
import { formatMoment } from "../format";
import { t } from "../texts";
import { ConfirmForm, ErrorText, Field, fieldErrors, LoadedView, Pill } from "../ui";

const ROLES: readonly StaffRole[] = ["admin", "manager", "moderator"];
const ROLE_OPTIONS = ROLES.map((role) => ({ value: role, label: t.roles[role] }));

type InviteBy = TeamMember["invitedBy"];
const BY_OPTIONS: readonly { value: InviteBy; label: string }[] = [
  { value: "telegram", label: t.inviteByTelegram },
  { value: "phone", label: t.inviteByPhone },
];

/** Ошибка номера до запроса: сервер ответил бы так же (422, поле phone) */
const phoneFailure: Failure = { ok: false, status: 422, code: "invalid_input", details: ["phone"] };

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
  const methods = useAuthMethods();
  const byId = useId();
  const [by, setBy] = useState<InviteBy>("telegram");
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState<StaffRole>("manager");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [done, setDone] = useState(false);
  const errors = fieldErrors(failure, {
    displayName: t.inviteName,
    username: t.fieldErrors.telegramUsername ?? "",
    phone: t.fieldErrors.phone ?? "",
    role: t.inviteRole,
  });
  const contact = by === "phone" ? phone : username;

  const choose = (next: InviteBy) => {
    setBy(next);
    setFailure(null);
    setDone(false);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setDone(false);
    let body: TeamInviteInput;
    if (by === "phone") {
      const normalized = normalizeUzPhone(phone);
      if (normalized === null) {
        setFailure(phoneFailure);
        return;
      }
      body = { displayName, role, phone: normalized };
    } else {
      body = { displayName, role, username };
    }
    setBusy(true);
    const result = await api.post<TeamList>("/staff/team", body);
    setBusy(false);
    setFailure(result.ok ? null : result);
    if (result.ok) {
      setDone(true);
      setDisplayName("");
      setUsername("");
      setPhone("");
      onDone(result.data);
    }
  };

  const hint = by === "telegram" ? t.inviteHint : methods?.phone ? t.inviteHintPhone : t.inviteHintPhoneOff;
  return (
    <form className="fs" onSubmit={submit} noValidate>
      <div className="fs-head">
        <h2>{t.inviteTitle}</h2>
        <p>{hint}</p>
      </div>
      <div className="field invite-by">
        <span id={byId}>{t.inviteBy}</span>
        <RadioGroup
          variant="segmented"
          aria-labelledby={byId}
          name="invite-by"
          value={by}
          options={BY_OPTIONS}
          onChange={choose}
        />
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
        {by === "phone" ? (
          <Field label={t.invitePhone} error={errors.phone}>
            {(props) => (
              <input
                {...props}
                className="input"
                type="tel"
                inputMode="tel"
                autoComplete="off"
                placeholder="+998 90 123 45 67"
                value={phone}
                maxLength={24}
                onChange={(event) => setPhone(event.target.value)}
              />
            )}
          </Field>
        ) : (
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
        )}
        <Field label={t.inviteRole} error={errors.role} hint={t.roleHints[role]}>
          {(props) => (
            <Select
              {...props}
              className="input"
              label={t.inviteRole}
              value={role}
              onChange={setRole}
              options={ROLE_OPTIONS}
            />
          )}
        </Field>
      </div>
      <div className="acts invite-acts">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={busy || displayName.trim() === "" || contact.trim() === ""}
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
        <span className="sub">
          {member.username ? `@${member.username}` : member.invitedBy === "phone" ? t.invitedByPhone : t.none}
        </span>
      </td>
      <td>
        {member.self || !member.active ? (
          t.roles[member.role]
        ) : (
          <div className="role-edit">
            <Select
              id={roleId}
              className="input"
              label={`${t.changeRole}: ${member.displayName}`}
              value={role}
              onChange={setRole}
              options={ROLE_OPTIONS}
            />
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
          {member.linked && member.linkedAt
            ? t.memberLinked(formatMoment(member.linkedAt))
            : member.accepted
              ? t.memberAccepted
              : t.memberPending}
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
