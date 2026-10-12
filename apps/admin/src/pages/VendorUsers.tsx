/* Вход в кабинет вендора: кто в нём и что с ним делает команда.
   Приглашение — «+ Пригласить» открывает шторку: имя, телефон (+998, проверяется здесь и ещё раз
   сервером), роль (владелец меняет витрину, фото и услуги, сотрудник площадки — заявки и календарь:
   apps/api/src/vendor/access.ts) и язык уведомлений; подсказка — только к выбранной роли. Номер, уже
   подтверждённый в аккаунте Bayramm, принимается сразу; иначе партнёру отправляют текст приглашения:
   бот с «Я партнёр» и кабинет на сайте.
   У каждого — имя, роль и статус (ждёт входа, вошёл, отключён), одна строка «последний вход · язык»,
   а строка про Telegram — только когда уведомления не приходят. Действий два: «Изменить» (шторка:
   имя, роль, язык, телефон — он скрыт маской, «Показать» открывает его с записью в журнал) и «Ещё»
   (скопировать приглашение, отключить, отвязать вход, убрать из кабинета) — на любой ширине.
   Владелец у кабинета есть всегда: последнего не понизить, не отключить и не убрать — это
   проверяет база (vendor_last_owner).
   Телефон — полем с +998 и маской (fields.tsx); сменить его — «Изменить номер», пока партнёр по
   нему не вошёл (вошедшему сервер ответит user_linked). */

import { normalizeUzPhone } from "@bayramm/shared";
import type {
  RevealedPhone,
  VendorDetail,
  VendorUser,
  VendorUserInput,
  VendorUserPatch,
} from "@bayramm/shared/api/staff";
import { ConfirmSheet, Dialog, type RadioOption } from "@bayramm/ui/react";
import { type FormEvent, type ReactNode, type RefObject, useRef, useState } from "react";
import { type Api, type Failure, type Result, useAuthMethods, useCan, useSession } from "../api";
import { ChoiceField, PhoneField } from "../fields";
import { formatMoment } from "../format";
import { apiErrorText, t } from "../texts";
import {
  busyLabel,
  ErrorText,
  Field,
  fieldErrors,
  OverflowMenu,
  PhoneReveal,
  Pill,
  SheetClose,
  toneOf,
  useRevealErrors,
} from "../ui";
import { useUnsaved } from "../unsaved";
import { vendorInviteText } from "../vendor-invite";

type Role = VendorUser["role"];
type Lang = VendorUser["locale"];

const LANG_OPTIONS: readonly RadioOption<Lang>[] = [
  { value: "ru", label: t.vuLocales.ru },
  { value: "uz", label: t.vuLocales.uz },
];

/** Сотрудника площадки не пригласить, пока у кабинета нет владельца (база ответит так же) */
const roleOptions = (hasOwner: boolean): readonly RadioOption<Role>[] => [
  { value: "owner", label: t.vuRoles.owner },
  { value: "member", label: t.vuRoles.member, disabled: !hasOwner },
];

/** Ошибка номера до запроса: сервер ответил бы так же (422, поле phone) */
const phoneFailure: Failure = { ok: false, status: 422, code: "invalid_input", details: ["phone"] };

/** Действующий владелец — и тот, чьё приглашение ещё ждёт входа: база считает так же */
const isActiveOwner = (user: VendorUser) => user.role === "owner" && user.status !== "disabled";

/**
 * Уведомления не приходят, хотя человек уже вошёл: бот не знает его чат — пусть откроет бота.
 * Пока приглашение ждёт входа или человек отключён, строки нет: это не поломка
 */
function notifyProblem(user: VendorUser): string | null {
  if (user.status !== "accepted" || user.notifiable) return null;
  return `${t.vuNotNotifiable} — ${t.vuOpenBot}`;
}

/** Номер для входа одним чтением: каждое пишется в журнал доступа к ПДн (кнопка «Показать») */
function userPhoneLoader(api: Api, vendorId: string, userId: string) {
  return async (): Promise<Result<string | null>> => {
    const result = await api.post<RevealedPhone>(`/staff/vendors/${vendorId}/users/${userId}/phone`, {});
    return result.ok ? { ok: true, data: result.data.phone } : result;
  };
}

type ConfirmAction = "disable" | "unlink" | "remove";

const CONFIRM_TITLE: Record<ConfirmAction, string> = {
  disable: t.disable,
  unlink: t.vuUnlink,
  remove: t.vuRemove,
};

function confirmText(action: ConfirmAction, user: VendorUser): string {
  if (action === "disable") return t.disableUserHint;
  if (action === "unlink") return t.vuUnlinkHint;
  return user.status === "pending" ? t.vuRemoveHintPending : t.vuRemoveHint;
}

export function VendorUsers({
  vendor,
  onChange,
}: {
  vendor: VendorDetail;
  onChange: (vendor: VendorDetail) => void;
}) {
  const { api } = useSession();
  const can = useCan();
  const write = can("vendor_users.write");
  const copier = useInviteCopy(vendor);
  const [inviting, setInviting] = useState(false);
  const inviteButton = useRef<HTMLButtonElement>(null);
  const [confirm, setConfirm] = useState<{ user: VendorUser; action: ConfirmAction } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmFailure, setConfirmFailure] = useState<Failure | null>(null);
  const [failure, setFailure] = useState<{ userId: string; failure: Failure } | null>(null);

  const replace = (user: VendorUser) =>
    onChange({
      ...vendor,
      users: vendor.users.some((u) => u.id === user.id)
        ? vendor.users.map((u) => (u.id === user.id ? user : u))
        : [...vendor.users, user],
    });

  const enable = async (user: VendorUser) => {
    const result = await api.post<VendorUser>(`/staff/vendors/${vendor.id}/users/${user.id}/enable`);
    setFailure(result.ok ? null : { userId: user.id, failure: result });
    if (result.ok) replace(result.data);
  };

  const confirmAction = async () => {
    if (!confirm) return;
    const { user, action } = confirm;
    const path = `/staff/vendors/${vendor.id}/users/${user.id}`;
    setBusy(true);
    if (action === "remove") {
      const result = await api.del<null>(path);
      setBusy(false);
      setConfirmFailure(result.ok ? null : result);
      if (!result.ok) return;
      onChange({ ...vendor, users: vendor.users.filter((u) => u.id !== user.id) });
    } else {
      const result = await api.post<VendorUser>(`${path}/${action}`);
      setBusy(false);
      setConfirmFailure(result.ok ? null : result);
      if (!result.ok) return;
      replace(result.data);
    }
    setConfirm(null);
  };

  return (
    <section className="panel" aria-labelledby="users-title">
      <div className="panel-head">
        <h2 id="users-title" tabIndex={-1}>
          {t.users} <span className="count">{vendor.users.length}</span>
        </h2>
        {write ? (
          <button
            ref={inviteButton}
            type="button"
            className="btn btn-sm"
            aria-haspopup="dialog"
            aria-expanded={inviting}
            onClick={() => setInviting(true)}
          >
            {t.vuInviteOpen}
          </button>
        ) : null}
      </div>
      {vendor.users.length === 0 ? (
        <p className="muted">{t.usersEmpty}</p>
      ) : (
        <ul className="cards">
          {vendor.users.map((user) => (
            <UserCard
              key={user.id}
              user={user}
              vendorId={vendor.id}
              write={write}
              copier={copier}
              failure={failure?.userId === user.id ? failure.failure : null}
              onSaved={replace}
              onEnable={() => void enable(user)}
              onConfirm={(action) => {
                setConfirmFailure(null);
                setFailure(null);
                setConfirm({ user, action });
              }}
            />
          ))}
        </ul>
      )}
      <ConfirmSheet
        open={confirm !== null}
        title={confirm ? CONFIRM_TITLE[confirm.action] : ""}
        text={confirm ? confirmText(confirm.action, confirm.user) : undefined}
        confirmLabel={confirm ? CONFIRM_TITLE[confirm.action] : ""}
        cancelLabel={t.cancel}
        tone="danger"
        busy={busy}
        error={confirmFailure ? apiErrorText(confirmFailure.code) : undefined}
        onConfirm={() => void confirmAction()}
        onCancel={() => {
          setConfirm(null);
          setConfirmFailure(null);
        }}
      />
      {copier.dialog}
      {write ? (
        <InviteSheet
          open={inviting}
          vendor={vendor}
          copier={copier}
          returnFocus={inviteButton}
          onClose={() => setInviting(false)}
          onInvited={replace}
        />
      ) : null}
    </section>
  );
}

// ── пользователь ───────────────────────────────────────────────────────────

interface UserCardProps {
  user: VendorUser;
  vendorId: string;
  write: boolean;
  copier: InviteCopier;
  failure: Failure | null;
  onSaved: (user: VendorUser) => void;
  onEnable: () => void;
  onConfirm: (action: ConfirmAction) => void;
}

function UserCard({ user, vendorId, write, copier, failure, onSaved, onEnable, onConfirm }: UserCardProps) {
  const { api } = useSession();
  const can = useCan();
  const [editing, setEditing] = useState(false);
  const edit = useRef<HTMLButtonElement>(null);
  const name = user.fullName ?? t.vuNoName;
  const problem = notifyProblem(user);
  // «Изменить» — отдельной кнопкой; остальное — в «Ещё»
  const actions = [
    { key: "copy", label: t.vuCopy, disabled: !copier.ready, run: () => void copier.copy(user, "card") },
    user.status === "disabled"
      ? { key: "enable", label: t.enable, run: onEnable }
      : { key: "disable", label: t.disable, danger: true, run: () => onConfirm("disable") },
    // Вход — аккаунт партнёра или привязка Telegram: отвязать, если сменил номер или Telegram
    ...(user.accountLinked || user.telegramLinked
      ? [{ key: "unlink", label: t.vuUnlink, run: () => onConfirm("unlink") }]
      : []),
    { key: "remove", label: t.vuRemove, danger: true, run: () => onConfirm("remove") },
  ];

  return (
    <li className="card-row vuser">
      <div className="vuser-head">
        <div className="vuser-id">
          <strong className="vuser-name">{name}</strong>
          <span className="vuser-pills">
            {/* Роль — не статус: нейтральной плашкой; статус — общим цветом статусов */}
            <Pill tone="muted">{t.vuRoles[user.role]}</Pill>
            <Pill tone={toneOf("vendorUser", user.status)}>{t.vuStatus[user.status]}</Pill>
          </span>
        </div>
        {write ? (
          <div className="vuser-acts">
            <button
              ref={edit}
              type="button"
              className="btn btn-sm"
              aria-haspopup="dialog"
              aria-expanded={editing}
              onClick={() => setEditing(true)}
            >
              {t.vuEdit}
              <span className="visually-hidden">: {name}</span>
            </button>
            <OverflowMenu title={name} context={name} className="btn btn-sm" actions={actions} />
          </div>
        ) : null}
      </div>
      <p className="rcard-meta">
        {user.lastLoginAt ? t.vuLastLogin(formatMoment(user.lastLoginAt)) : t.vuNeverLoggedIn}
        {` · ${t.vuLocaleLine(t.vuLocales[user.locale])}`}
      </p>
      {problem ? <p className="rcard-meta">{problem}</p> : null}
      {/* Правящему номер — в шторке «Изменить»; тому, кто только смотрит (модератор), — здесь */}
      {!write && can("vendor_phones.read") ? (
        <PhoneReveal label={t.userPhone} load={userPhoneLoader(api, vendorId, user.id)} />
      ) : null}
      {copier.copiedKey === `card:${user.id}` && (
        <span className="saved" role="status">
          {t.vuCopied}
        </span>
      )}
      {failure && <ErrorText failure={failure} />}
      {write ? (
        <Dialog
          open={editing}
          title={`${t.vuEdit}: ${name}`}
          onClose={() => setEditing(false)}
          returnFocus={edit}
        >
          <EditUserForm
            user={user}
            vendorId={vendorId}
            onCancel={() => setEditing(false)}
            onSaved={(saved) => {
              setEditing(false);
              onSaved(saved);
            }}
          />
        </Dialog>
      ) : null}
    </li>
  );
}

/**
 * Имя, роль, язык и номер. Последнего владельца сервер не понизит — ответ словами под формой.
 * Номер скрыт маской: «Показать» открывает его (запись в журнал), «Изменить номер» — меняет, пока по
 * нему не вошли
 */
function EditUserForm({
  user,
  vendorId,
  onSaved,
  onCancel,
}: {
  user: VendorUser;
  vendorId: string;
  onSaved: (user: VendorUser) => void;
  onCancel: () => void;
}) {
  const { api } = useSession();
  const [fullName, setFullName] = useState(user.fullName ?? "");
  const [role, setRole] = useState<Role>(user.role);
  const [locale, setLocale] = useState<Lang>(user.locale);
  // Новый номер: null — номер не меняют (поле закрыто)
  const [phone, setPhone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const phoneInput = useRef<HTMLInputElement>(null);
  // Партнёр уже вошёл по номеру (аккаунт или Telegram) — номер не сменить
  const phoneLocked = user.accountLinked || user.telegramLinked;
  const name = fullName.trim();
  const newPhone = phone === null || phone.trim() === "" ? null : (normalizeUzPhone(phone) ?? phone);
  const patch: VendorUserPatch = {
    ...(name !== (user.fullName ?? "") ? { fullName: name === "" ? null : name } : {}),
    ...(role !== user.role ? { role } : {}),
    ...(locale !== user.locale ? { locale } : {}),
    ...(newPhone !== null ? { phone: newPhone } : {}),
  };
  const dirty = Object.keys(patch).length > 0;
  // Изменённое и не сохранённое — уход со страницы переспросит
  useUnsaved(dirty);
  const errors = fieldErrors(failure, { fullName: t.userName, phone: t.fieldErrors.phone ?? "" });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!dirty) {
      onCancel();
      return;
    }
    // Неполный номер — сервер ответил бы так же (422, поле phone)
    if (newPhone !== null && normalizeUzPhone(newPhone) === null) {
      setFailure(phoneFailure);
      return;
    }
    setBusy(true);
    const result = await api.patch<VendorUser>(`/staff/vendors/${vendorId}/users/${user.id}`, patch);
    setBusy(false);
    setFailure(result.ok ? null : result);
    if (result.ok) onSaved(result.data);
  };

  return (
    <form className="vuser-edit" onSubmit={submit} noValidate>
      <Field label={t.userName} hint={t.optional} error={errors.fullName}>
        {(props) => (
          <input
            {...props}
            className="input"
            value={fullName}
            maxLength={120}
            autoComplete="off"
            enterKeyHint="done"
            onChange={(event) => setFullName(event.target.value)}
          />
        )}
      </Field>
      <ChoiceField
        label={t.vuRole}
        value={role}
        options={roleOptions(true)}
        onChange={setRole}
        hint={t.vuRoleHints[role]}
      />
      <ChoiceField label={t.vuLocale} value={locale} options={LANG_OPTIONS} onChange={setLocale} />
      {phone === null ? (
        <div className="field">
          <PhoneReveal label={t.userPhone} load={userPhoneLoader(api, vendorId, user.id)} />
          {phoneLocked ? (
            <span className="field-hint">{t.input.phoneLinked}</span>
          ) : (
            <div>
              <button
                type="button"
                className="btn btn-sm"
                aria-expanded={false}
                onClick={() => {
                  setPhone("");
                  // Поле появится после этой отрисовки — фокус в него, без прокрутки (ловушка №3)
                  setTimeout(() => phoneInput.current?.focus({ preventScroll: true }), 0);
                }}
              >
                {t.input.phoneChange}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="field">
          <PhoneField
            label={t.phoneNew}
            value={phone}
            onChange={setPhone}
            error={errors.phone}
            inputRef={phoneInput}
          />
          <div>
            <button type="button" className="btn btn-sm" onClick={() => setPhone(null)}>
              {t.input.phoneChangeCancel}
            </button>
          </div>
        </div>
      )}
      <div className="acts">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? t.saving : t.save}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          {t.cancel}
        </button>
      </div>
      {failure && failure.code !== "invalid_input" && <ErrorText failure={failure} />}
    </form>
  );
}

// ── приглашение ────────────────────────────────────────────────────────────

/**
 * Приглашение в шторке. Вписанное остаётся, пока шторку закрыли не отправив (случайное нажатие на
 * подложку не стирает номер); отправили — шторка говорит, что приглашение создано, и даёт скопировать
 * его текст
 */
function InviteSheet({
  open,
  vendor,
  copier,
  returnFocus,
  onClose,
  onInvited,
}: {
  open: boolean;
  vendor: VendorDetail;
  copier: InviteCopier;
  returnFocus: RefObject<HTMLElement | null>;
  onClose: () => void;
  onInvited: (user: VendorUser) => void;
}) {
  const { api } = useSession();
  const hasOwner = vendor.users.some(isActiveOwner);
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  // Роль выбирают явно: раньше каждый заведённый становился владельцем. Владельца ещё нет —
  // первым приглашают его
  const [role, setRole] = useState<Role | null>(null);
  const [locale, setLocale] = useState<Lang>("uz");
  const [roleMissing, setRoleMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [invited, setInvited] = useState<VendorUser | null>(null);
  const chosen: Role | null = hasOwner ? role : "owner";
  const errors = fieldErrors(failure, { phone: t.fieldErrors.phone ?? "", fullName: t.userName });
  const form = useRevealErrors(failure);
  // Вписанное и не отправленное приглашение — несохранённое
  useUnsaved(phone.trim() !== "" || fullName.trim() !== "");

  const close = () => {
    setInvited(null);
    onClose();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setInvited(null);
    const normalized = normalizeUzPhone(phone);
    setRoleMissing(chosen === null);
    if (normalized === null) {
      setFailure(phoneFailure);
      return;
    }
    if (chosen === null) {
      setFailure(null);
      return;
    }
    const name = fullName.trim();
    const body: VendorUserInput = {
      phone: normalized,
      role: chosen,
      locale,
      ...(name ? { fullName: name } : {}),
    };
    setBusy(true);
    const result = await api.post<VendorUser>(`/staff/vendors/${vendor.id}/users`, body);
    setBusy(false);
    setFailure(result.ok ? null : result);
    if (result.ok) {
      setInvited(result.data);
      setFullName("");
      setPhone("");
      setRole(null);
      onInvited(result.data);
    }
  };

  return (
    <Dialog open={open} title={t.vuInviteTitle} onClose={close} returnFocus={returnFocus}>
      {invited ? (
        <div className="vuser-invited">
          <p className="saved" role="status">
            {invited.status === "accepted" ? t.vuInvitedAccepted : t.vuInvited}
          </p>
          <div className="acts">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!copier.ready}
              onClick={() => void copier.copy(invited, "invite")}
            >
              {t.vuCopy}
            </button>
            <button type="button" className="btn" onClick={close}>
              {t.done}
            </button>
          </div>
          {copier.copiedKey === `invite:${invited.id}` && (
            <span className="saved" role="status">
              {t.vuCopied}
            </span>
          )}
        </div>
      ) : (
        <form ref={form} className="vuser-invite" onSubmit={submit} noValidate>
          <div className="fields">
            <Field label={t.userName} hint={t.optional} error={errors.fullName}>
              {(props) => (
                <input
                  {...props}
                  className="input"
                  value={fullName}
                  maxLength={120}
                  autoComplete="off"
                  enterKeyHint="next"
                  onChange={(event) => setFullName(event.target.value)}
                />
              )}
            </Field>
            <PhoneField
              label={t.userPhone}
              value={phone}
              onChange={setPhone}
              error={errors.phone}
              enterKeyHint="next"
            />
            <ChoiceField
              label={t.vuRole}
              value={chosen}
              options={roleOptions(hasOwner)}
              onChange={(next) => {
                setRole(next);
                setRoleMissing(false);
              }}
              hint={!hasOwner ? t.vuOwnerFirst : chosen ? t.vuRoleHints[chosen] : undefined}
              error={roleMissing ? t.vuRoleRequired : undefined}
            />
            <ChoiceField label={t.vuLocale} value={locale} options={LANG_OPTIONS} onChange={setLocale} />
          </div>
          <div className="acts">
            <button
              type="submit"
              className="btn btn-primary"
              aria-busy={busy || undefined}
              disabled={busy || phone.trim() === ""}
            >
              {busyLabel(t.vuInvite, busy)}
            </button>
            <button type="button" className="btn" onClick={close}>
              {t.cancel}
            </button>
          </div>
          {failure && failure.code !== "invalid_input" && <ErrorText failure={failure} />}
        </form>
      )}
    </Dialog>
  );
}

// ── текст приглашения ──────────────────────────────────────────────────────

interface InviteCopier {
  /** Адреса бота и кабинета пришли (GET /auth/methods) — текст можно собрать */
  readonly ready: boolean;
  /** Что скопировано последним: «card:<id>» или «invite:<id>» — там и «Скопировано» */
  readonly copiedKey: string | null;
  readonly copy: (user: VendorUser, where: "card" | "invite") => Promise<void>;
  /** Шторка с текстом, если буфер обмена недоступен (старый вебвью, нет разрешения) */
  readonly dialog: ReactNode;
}

/**
 * Текст приглашения на языке партнёра — в буфер обмена; не вышло — шторка с выделенным
 * текстом, чтобы скопировать его самому
 */
function useInviteCopy(vendor: VendorDetail): InviteCopier {
  const methods = useAuthMethods();
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [manual, setManual] = useState<string | null>(null);

  const copy = async (user: VendorUser, where: "card" | "invite") => {
    if (methods === null) return;
    const text = vendorInviteText(user.locale, {
      name: user.fullName,
      vendor: vendor.name ?? vendor.code,
      role: user.role,
      bot: methods.telegram.bot,
      cabinetUrl: methods.apps.vendor,
      phoneLogin: methods.phone,
    });
    setCopiedKey(null);
    try {
      // Буфера обмена нет в старых вебвью и вне https — тогда текст в шторке
      if (typeof navigator.clipboard?.writeText !== "function") throw new Error("no clipboard");
      await navigator.clipboard.writeText(text);
      setCopiedKey(`${where}:${user.id}`);
    } catch {
      setManual(text);
    }
  };

  return {
    ready: methods !== null,
    copiedKey,
    copy,
    dialog: <CopyDialog text={manual} onClose={() => setManual(null)} />,
  };
}

function CopyDialog({ text, onClose }: { text: string | null; onClose: () => void }) {
  const area = useRef<HTMLTextAreaElement>(null);
  return (
    <Dialog
      open={text !== null}
      title={t.vuCopyTitle}
      onClose={onClose}
      initialFocus={area}
      actions={<SheetClose onClose={onClose} />}
    >
      <p className="muted small">{t.vuCopyHint}</p>
      <textarea
        ref={area}
        className="input vuser-copy-text"
        readOnly
        rows={10}
        aria-label={t.vuCopyTitle}
        value={text ?? ""}
        onFocus={(event) => event.currentTarget.select()}
      />
    </Dialog>
  );
}
