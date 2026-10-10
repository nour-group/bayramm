/* Команда — только администратор: приглашение по имени пользователя Telegram или по
   номеру телефона, роль, отключение. Номер проверяется здесь же (+998 и 9 цифр) и ещё раз
   сервером; хранится только его HMAC — в списке видно лишь «по телефону». Себя не
   отключить и роль не сменить; последнего администратора база не даст ни отключить, ни
   понизить. Приглашение, которое ещё не приняли, можно отозвать (удалить); принятое —
   только отключить.
   Телефон — с +998 и маской, имя Telegram — с «@» (ссылку t.me поле снимает само), роль —
   строками с пояснением, что она может. Сделать администратором (пригласить или повысить) —
   через подтверждение: он получит всё, включая команду и телефоны клиентов. */

import { normalizeTelegram, normalizeUzPhone } from "@bayramm/shared";
import type { StaffRole, TeamInviteInput, TeamList, TeamMember } from "@bayramm/shared/api/staff";
import { ConfirmSheet, RadioGroup, Select } from "@bayramm/ui/react";
import { type FormEvent, type RefObject, useId, useRef, useState } from "react";
import { type Failure, useAuthMethods, useLoad, useSession } from "../api";
import { ChoiceField, PhoneField, TelegramField } from "../fields";
import { formatMoment } from "../format";
import { usePhone } from "../layout";
import { apiErrorText, t } from "../texts";
import {
  ConfirmForm,
  ErrorText,
  Field,
  fieldErrors,
  LoadedView,
  PhoneSheet,
  Pill,
  useRevealErrors,
} from "../ui";
import { useUnsaved } from "../unsaved";

const ROLES: readonly StaffRole[] = ["admin", "manager", "moderator"];
const ROLE_OPTIONS = ROLES.map((role) => ({ value: role, label: t.roles[role] }));
// Приглашение: роль — строками, с тем, что она может; администратор — последним (реже нужен)
const INVITE_ROLES = (["manager", "moderator", "admin"] as const).map((role) => ({
  value: role,
  label: t.roles[role],
  hint: t.roleHints[role],
}));

type InviteBy = TeamMember["invitedBy"];
const BY_OPTIONS: readonly { value: InviteBy; label: string }[] = [
  { value: "telegram", label: t.inviteByTelegram },
  { value: "phone", label: t.inviteByPhone },
];

/** Ошибка поля до запроса: сервер ответил бы так же (422, поле phone или username) */
const invalid = (field: string): Failure => ({
  ok: false,
  status: 422,
  code: "invalid_input",
  details: [field],
});

export function TeamPage() {
  const { loaded, reload, set } = useLoad<TeamList>("/staff/team");
  // На телефоне форма приглашения — на весь экран: сначала те, кто в команде, приглашение — ниже
  const phone = usePhone();
  const invite = <InviteForm onDone={set} />;
  return (
    <div className="stack">
      {phone ? null : invite}
      <LoadedView loaded={loaded} onRetry={reload}>
        {(list) => <Members list={list} onChange={set} />}
      </LoadedView>
      {phone ? invite : null}
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
  // Пригласить администратора — после подтверждения: тело запроса ждёт ответа
  const [confirmAdmin, setConfirmAdmin] = useState<TeamInviteInput | null>(null);
  const errors = fieldErrors(failure, {
    displayName: t.inviteName,
    username: t.fieldErrors.telegramUsername ?? "",
    phone: t.fieldErrors.phone ?? "",
    role: t.inviteRole,
  });
  const contact = by === "phone" ? phone : username;
  const form = useRevealErrors(failure);
  // Вписанное и не отправленное приглашение — несохранённое
  useUnsaved(displayName.trim() !== "" || contact.trim() !== "");

  const choose = (next: InviteBy) => {
    setBy(next);
    setFailure(null);
    setDone(false);
  };

  const send = async (body: TeamInviteInput) => {
    setBusy(true);
    const result = await api.post<TeamList>("/staff/team", body);
    setBusy(false);
    setFailure(result.ok ? null : result);
    if (result.ok) {
      setConfirmAdmin(null);
      setDone(true);
      setDisplayName("");
      setUsername("");
      setPhone("");
      onDone(result.data);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setDone(false);
    let body: TeamInviteInput;
    if (by === "phone") {
      const normalized = normalizeUzPhone(phone);
      if (normalized === null) {
        setFailure(invalid("phone"));
        return;
      }
      body = { displayName, role, phone: normalized };
    } else {
      const name = normalizeTelegram(username);
      if (name === null) {
        setFailure(invalid("username"));
        return;
      }
      body = { displayName, role, username: name };
    }
    // Администратор получит всё — сначала переспросить
    if (role === "admin") {
      setFailure(null);
      setConfirmAdmin(body);
      return;
    }
    void send(body);
  };

  const hint = by === "telegram" ? t.inviteHint : methods?.phone ? t.inviteHintPhone : t.inviteHintPhoneOff;
  return (
    <form ref={form} className="fs" onSubmit={submit} noValidate>
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
              autoComplete="off"
              enterKeyHint="next"
              onChange={(event) => setDisplayName(event.target.value)}
            />
          )}
        </Field>
        {by === "phone" ? (
          <PhoneField
            label={t.invitePhone}
            value={phone}
            onChange={setPhone}
            error={errors.phone}
            enterKeyHint="send"
          />
        ) : (
          <TelegramField
            label={t.inviteUsername}
            value={username}
            onChange={setUsername}
            error={errors.username}
            enterKeyHint="send"
          />
        )}
        <ChoiceField
          label={t.inviteRole}
          value={role}
          options={INVITE_ROLES}
          onChange={setRole}
          variant="row"
          error={errors.role}
        />
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
      <ConfirmSheet
        open={confirmAdmin !== null}
        title={t.inviteAdminTitle}
        text={t.inviteAdminText(displayName.trim() || t.roles.admin)}
        confirmLabel={t.invite}
        cancelLabel={t.cancel}
        busy={busy}
        error={confirmAdmin && failure ? apiErrorText(failure.code) : undefined}
        onConfirm={() => {
          if (confirmAdmin) void send(confirmAdmin);
        }}
        onCancel={() => {
          setConfirmAdmin(null);
          setFailure(null);
        }}
      />
    </form>
  );
}

function Members({ list, onChange }: { list: TeamList; onChange: (list: TeamList) => void }) {
  const phone = usePhone();
  if (phone)
    return (
      <ul className="rcards" aria-label={t.team}>
        {list.items.map((member) => (
          <MemberCard key={member.id} member={member} onChange={onChange} />
        ))}
      </ul>
    );
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

/** Роль и включение сотрудника: общее для строки таблицы и карточки телефона */
function useMember(member: TeamMember, onChange: (list: TeamList) => void) {
  const { api } = useSession();
  const [role, setRole] = useState<StaffRole>(member.role);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeFailure, setRevokeFailure] = useState<Failure | null>(null);
  // Сделать администратором — после подтверждения
  const [promoting, setPromoting] = useState(false);
  // Новая роль выбрана, но не применена — несохранённое
  useUnsaved(member.active && !member.self && role !== member.role);

  const applyRole = async () => {
    setBusy(true);
    const result = await api.post<TeamList>(`/staff/team/${member.id}/role`, { role });
    setBusy(false);
    setFailure(result.ok ? null : result);
    if (result.ok) {
      setPromoting(false);
      onChange(result.data);
    }
  };
  const changeRole = () => {
    if (role === "admin") {
      setFailure(null);
      setPromoting(true);
      return;
    }
    void applyRole();
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

  // Отозвать приглашение: в ответе — команда уже без него (строка исчезнет)
  const revoke = async () => {
    setBusy(true);
    const result = await api.del<TeamList>(`/staff/team/${member.id}`);
    setBusy(false);
    setRevokeFailure(result.ok ? null : result);
    if (result.ok) {
      setRevoking(false);
      onChange(result.data);
    }
  };
  const revokeOpen = () => {
    setRevokeFailure(null);
    setRevoking(true);
  };
  const revokeClose = () => {
    setRevoking(false);
    setRevokeFailure(null);
  };

  return {
    role,
    setRole,
    confirming,
    setConfirming,
    busy,
    failure,
    changeRole,
    applyRole,
    promoting,
    promoteClose: () => {
      setPromoting(false);
      setFailure(null);
    },
    toggle,
    revoking,
    revokeOpen,
    revokeClose,
    revoke,
    revokeFailure,
  };
}

/** Приглашение ещё не приняли — его можно отозвать (удалить); себя — нет */
const revocable = (member: TeamMember) => !member.accepted && !member.self;

/** Подтверждение «Отозвать приглашение»: что будет, ошибка — под текстом */
function RevokeSheet({
  member,
  state,
  returnFocus,
}: {
  member: TeamMember;
  state: ReturnType<typeof useMember>;
  returnFocus: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <ConfirmSheet
      open={state.revoking}
      title={t.inviteRevokeTitle}
      text={t.inviteRevokeText(member.displayName)}
      confirmLabel={t.inviteRevoke}
      cancelLabel={t.cancel}
      tone="danger"
      busy={state.busy}
      error={state.revokeFailure ? apiErrorText(state.revokeFailure.code) : undefined}
      returnFocus={returnFocus}
      onConfirm={() => void state.revoke()}
      onCancel={state.revokeClose}
    />
  );
}

/** Подтверждение «Сделать администратором»: что он получит, ошибка — под текстом */
function PromoteSheet({ member, state }: { member: TeamMember; state: ReturnType<typeof useMember> }) {
  return (
    <ConfirmSheet
      open={state.promoting}
      title={t.promoteTitle}
      text={t.promoteText(member.displayName)}
      confirmLabel={t.promote}
      cancelLabel={t.cancel}
      busy={state.busy}
      error={state.promoting && state.failure ? apiErrorText(state.failure.code) : undefined}
      onConfirm={() => void state.applyRole()}
      onCancel={state.promoteClose}
    />
  );
}

function linkState(member: TeamMember): string {
  if (member.linked && member.linkedAt) return t.memberLinked(formatMoment(member.linkedAt));
  return member.accepted ? t.memberAccepted : t.memberPending;
}

/** Действующему сотруднику бот не пишет (не было /start): оповещения команды до него не дойдут */
function NoBot({ member }: { member: TeamMember }) {
  if (!member.active || member.botLinked) return null;
  return (
    <>
      {" · "}
      <span className="no-bot">
        {t.memberNoBot}
        <span className="visually-hidden">, {t.memberNoBotHint}</span>
      </span>
    </>
  );
}

function MemberCard({ member, onChange }: { member: TeamMember; onChange: (list: TeamList) => void }) {
  const roleId = useId();
  const toggleButton = useRef<HTMLButtonElement>(null);
  const revokeButton = useRef<HTMLButtonElement>(null);
  const state = useMember(member, onChange);
  const { role, setRole, confirming, setConfirming, busy, failure, changeRole, toggle } = state;
  return (
    <li className="rcard">
      <div className="rcard-head">
        <p className="rcard-title">{member.displayName}</p>
        {member.active ? (
          <Pill tone="outline">{t.memberActive}</Pill>
        ) : (
          <Pill tone="muted">{t.memberInactive}</Pill>
        )}
      </div>
      <p className="rcard-meta">
        {member.self ? `${t.you} · ` : ""}
        {member.username ? `@${member.username}` : member.invitedBy === "phone" ? t.invitedByPhone : t.none}
      </p>
      <p className="rcard-meta">
        {linkState(member)}
        <NoBot member={member} />
      </p>
      {member.self || !member.active ? (
        <p className="rcard-meta">
          {t.colRole}: {t.roles[member.role]}
        </p>
      ) : (
        <div className="rcard-actions role-edit">
          <label className="role-label" htmlFor={roleId}>
            {t.colRole}
          </label>
          <Select
            id={roleId}
            className="input"
            label={`${t.changeRole}: ${member.displayName}`}
            value={role}
            onChange={setRole}
            options={ROLE_OPTIONS}
          />
          {role !== member.role && (
            <button type="button" className="btn" onClick={changeRole} disabled={busy}>
              {t.changeRole}
            </button>
          )}
        </div>
      )}
      {!member.self && (
        <div className="rcard-actions">
          <button
            ref={toggleButton}
            type="button"
            className={`btn${member.active ? " btn-danger" : ""}`}
            aria-expanded={confirming}
            onClick={() => setConfirming(true)}
          >
            {member.active ? t.deactivate : t.activate}
          </button>
          {revocable(member) ? (
            <button ref={revokeButton} type="button" className="btn btn-danger" onClick={state.revokeOpen}>
              {t.inviteRevoke}
            </button>
          ) : null}
        </div>
      )}
      <RevokeSheet member={member} state={state} returnFocus={revokeButton} />
      <PromoteSheet member={member} state={state} />
      <PhoneSheet
        open={confirming}
        title={member.active ? t.deactivate : t.activate}
        onClose={() => setConfirming(false)}
        returnFocus={toggleButton}
      >
        <ConfirmForm
          hint={member.active ? t.deactivateHint : t.activateHint}
          submitLabel={member.active ? t.deactivate : t.activate}
          danger={member.active}
          onSubmit={toggle}
          onCancel={() => setConfirming(false)}
        />
      </PhoneSheet>
      {failure && <ErrorText failure={failure} />}
    </li>
  );
}

function MemberRow({ member, onChange }: { member: TeamMember; onChange: (list: TeamList) => void }) {
  const roleId = useId();
  const revokeButton = useRef<HTMLButtonElement>(null);
  const state = useMember(member, onChange);
  const { role, setRole, confirming, setConfirming, busy, failure, changeRole, toggle } = state;

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
          {linkState(member)}
          <NoBot member={member} />
        </span>
      </td>
      <td>
        {!member.self &&
          (confirming ? (
            <ConfirmForm
              hint={member.active ? t.deactivateHint : t.activateHint}
              submitLabel={member.active ? t.deactivate : t.activate}
              danger={member.active}
              onSubmit={toggle}
              onCancel={() => setConfirming(false)}
            />
          ) : (
            <div className="acts">
              <button
                type="button"
                className={`btn btn-sm${member.active ? " btn-danger" : ""}`}
                onClick={() => setConfirming(true)}
              >
                {member.active ? t.deactivate : t.activate}
              </button>
              {revocable(member) ? (
                <button
                  ref={revokeButton}
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={state.revokeOpen}
                >
                  {t.inviteRevoke}
                </button>
              ) : null}
            </div>
          ))}
        <RevokeSheet member={member} state={state} returnFocus={revokeButton} />
        <PromoteSheet member={member} state={state} />
        {failure && <ErrorText failure={failure} />}
      </td>
    </tr>
  );
}
