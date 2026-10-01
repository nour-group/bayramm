/* Вендор: данные и реквизиты, чек-лист проверки, телефоны контакта, пользователи
   кабинета, витрины (по одной на категорию, бывает и несколько). Новый вендор — та же форма
   без остального, с выбором категории первой витрины. */

import type {
  ChecklistItem,
  RevealedPhone,
  StaffDictionaries,
  VendorDetail,
  VendorInput,
  VendorPhones,
  VendorUser,
  VendorUserInput,
} from "@bayramm/shared/api/staff";
import { Checkbox, ConfirmSheet } from "@bayramm/ui/react";
import { type FormEvent, useCallback, useState } from "react";
import { type Failure, type Result, useCan, useLoad, useSession } from "../api";
import { CategoryChip } from "../categories";
import { formatMoment, formatPrice } from "../format";
import { apiErrorText, t } from "../texts";
import {
  Blockers,
  ErrorText,
  Field,
  fieldErrors,
  Link,
  LoadedView,
  PhoneReveal,
  Pill,
  StatusPill,
  useEntityTitle,
  useNavigate,
  useRevealErrors,
} from "../ui";
import { useUnsaved } from "../unsaved";
import { VendorResponsePanel } from "./Metrics";
import { VendorForm } from "./VendorForm";

const CHECKLIST: readonly ChecklistItem[] = ["contract", "stir", "contacts", "pdConsent"];

/**
 * Пункты готовности, которые отмечают в «Проверке вендора» на этой же странице: у витрин их
 * не повторяем — иначе четыре одинаковых строки у каждой витрины
 */
const VENDOR_CHECKS: ReadonlySet<string> = new Set(["contract", "stir", "contacts", "pd_consent"]);

export function VendorNewPage({ dictionaries }: { dictionaries: StaffDictionaries | null }) {
  const { api } = useSession();
  const navigate = useNavigate();
  const create = useCallback(
    async (body: VendorInput): Promise<Failure | null> => {
      const result = await api.post<VendorDetail>("/staff/vendors", body);
      if (!result.ok) return result;
      // Вендор создан — форма сохранена: переход без вопроса о несохранённом
      navigate({ name: "vendor", id: result.data.id }, { force: true });
      return null;
    },
    [api, navigate],
  );
  return (
    <VendorForm vendor={null} dictionaries={dictionaries} onSubmit={create} submitLabel={t.createVendor} />
  );
}

export function VendorPage({ id, dictionaries }: { id: string; dictionaries: StaffDictionaries | null }) {
  const { loaded, reload, set } = useLoad<VendorDetail>(`/staff/vendors/${id}`);
  return (
    <LoadedView loaded={loaded} onRetry={reload}>
      {(vendor) => <VendorView vendor={vendor} dictionaries={dictionaries} onChange={set} />}
    </LoadedView>
  );
}

interface VendorViewProps {
  vendor: VendorDetail;
  dictionaries: StaffDictionaries | null;
  onChange: (vendor: VendorDetail) => void;
}

function VendorView({ vendor, dictionaries, onChange }: VendorViewProps) {
  const { api } = useSession();
  const can = useCan();
  useEntityTitle(vendor.name ?? vendor.contacts.legalName ?? vendor.code);
  const save = useCallback(
    async (body: VendorInput): Promise<Failure | null> => {
      const result = await api.patch<VendorDetail>(`/staff/vendors/${vendor.id}`, body);
      if (!result.ok) return result;
      onChange(result.data);
      return null;
    },
    [api, vendor.id, onChange],
  );

  return (
    <div className="stack">
      <p className="sub">
        {t.vendorCode}: {vendor.code}
        {vendor.manager?.name ? ` · ${t.fields.managerId}: ${vendor.manager.name}` : ""}
      </p>
      <div className="columns">
        <div className="stack">
          <Checklist vendor={vendor} onChange={onChange} />
          <ContactPhones vendorId={vendor.id} />
          <Listings vendor={vendor} />
          {can("metrics.read") && <VendorResponsePanel vendorId={vendor.id} />}
          <Users vendor={vendor} onChange={onChange} />
        </div>
        <VendorForm
          key={vendor.id}
          vendor={vendor}
          dictionaries={dictionaries}
          onSubmit={save}
          submitLabel={t.save}
          readOnly={!can("vendors.write")}
        />
      </div>
    </div>
  );
}

// ── чек-лист ───────────────────────────────────────────────────────────────

function Checklist({ vendor, onChange }: { vendor: VendorDetail; onChange: (v: VendorDetail) => void }) {
  const { api } = useSession();
  const can = useCan();
  const [busy, setBusy] = useState<ChecklistItem | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const done = CHECKLIST.filter((item) => vendor.checklist[item].done).length;

  const toggle = async (item: ChecklistItem, value: boolean) => {
    setBusy(item);
    const result = await api.post<VendorDetail>(`/staff/vendors/${vendor.id}/checklist`, {
      item,
      done: value,
    });
    setBusy(null);
    setFailure(result.ok ? null : result);
    if (result.ok) onChange(result.data);
  };

  return (
    <section className="panel" aria-labelledby="checklist-title">
      <h2 id="checklist-title">
        {t.checklist} <span className="count">{done}/4</span>
      </h2>
      <p className="muted small">{t.checklistHint}</p>
      <ul className="check">
        {CHECKLIST.map((item) => {
          const mark = vendor.checklist[item];
          return (
            <li key={item}>
              <Checkbox
                checked={mark.done}
                disabled={!can("vendors.write") || busy !== null}
                onChange={(done) => void toggle(item, done)}
              >
                {t.checklistItems[item]}
              </Checkbox>
              {mark.done && mark.at && (
                <span className="sub">{t.checkedBy(mark.by, formatMoment(mark.at))}</span>
              )}
            </li>
          );
        })}
      </ul>
      {failure && <ErrorText failure={failure} />}
    </section>
  );
}

// ── телефоны контакта ──────────────────────────────────────────────────────

function ContactPhones({ vendorId }: { vendorId: string }) {
  const { api } = useSession();
  // Один запрос отдаёт оба номера; второй «Показать» берёт из того же ответа
  const [phones, setPhones] = useState<Promise<Result<VendorPhones>> | null>(null);
  const load = useCallback(() => {
    const request = phones ?? api.post<VendorPhones>(`/staff/vendors/${vendorId}/phones`, {});
    setPhones(request);
    return request;
  }, [api, vendorId, phones]);
  const pick = (key: keyof VendorPhones) => async (): Promise<Result<string | null>> => {
    const result = await load();
    return result.ok ? { ok: true, data: result.data[key] } : result;
  };
  return (
    <section className="panel" aria-labelledby="phones-title">
      <h2 id="phones-title">{t.phones}</h2>
      <PhoneReveal label={t.phoneMain} load={pick("phone")} />
      <PhoneReveal label={t.phoneAlternative} load={pick("phoneAlt")} />
    </section>
  );
}

// ── витрины ────────────────────────────────────────────────────────────────

function Listings({ vendor }: { vendor: VendorDetail }) {
  const can = useCan();
  return (
    <section className="panel" aria-labelledby="listings-title">
      <h2 id="listings-title">
        {t.listings} <span className="count">{vendor.listings.length}</span>
      </h2>
      <p className="muted small">{t.vitrinasHint}</p>
      {vendor.listings.length === 0 ? (
        <p className="muted">{t.listingsEmpty}</p>
      ) : (
        <ul className="cards">
          {vendor.listings.map((listing) => (
            <li key={listing.id} className="card-row rcard-tap">
              <div className="rcard-head">
                <Link to={{ name: "listing", id: listing.id }} className="rcard-link">
                  {listing.name}
                </Link>
                <StatusPill status={listing.status} />
              </div>
              <span className="sub">
                <CategoryChip code={listing.categoryCode} />{" "}
                {formatPrice(listing.priceFromUzs, listing.priceUnit)}
                {listing.capMax ? ` · ${t.guestsUpTo(listing.capMax)}` : ""}
              </span>
              {listing.status !== "active" && (
                <Blockers
                  title={t.blockersActive}
                  codes={listing.blockers.filter((code) => !VENDOR_CHECKS.has(code))}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {can("listings.write") && (
        <p className="panel-foot">
          <Link to={{ name: "listingNew", vendorId: vendor.id }} className="btn btn-sm">
            {t.addVitrina}
          </Link>
        </p>
      )}
    </section>
  );
}

// ── вход в кабинет ─────────────────────────────────────────────────────────

function Users({ vendor, onChange }: { vendor: VendorDetail; onChange: (v: VendorDetail) => void }) {
  const { api } = useSession();
  const can = useCan();
  const [phone, setPhone] = useState("");
  const [fullName, setFullName] = useState("");
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ user: VendorUser; action: "disable" | "unlink" } | null>(null);
  const [confirmFailure, setConfirmFailure] = useState<Failure | null>(null);
  const errors = fieldErrors(failure, { phone: t.fieldErrors.phone ?? "" });
  const form = useRevealErrors(failure);
  // Вписанный, но не добавленный пользователь — несохранённое
  useUnsaved(phone.trim() !== "" || fullName.trim() !== "");

  const replace = (user: VendorUser, exists: boolean) =>
    onChange({
      ...vendor,
      users: exists ? vendor.users.map((u) => (u.id === user.id ? user : u)) : [...vendor.users, user],
    });

  const add = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const body: VendorUserInput = { phone, ...(fullName.trim() ? { fullName } : {}) };
    const result = await api.post<VendorUser>(`/staff/vendors/${vendor.id}/users`, body);
    setBusy(false);
    setFailure(result.ok ? null : result);
    if (result.ok) {
      replace(result.data, false);
      setPhone("");
      setFullName("");
    }
  };

  const userAction = async (user: VendorUser, action: "disable" | "enable" | "unlink") => {
    const result = await api.post<VendorUser>(`/staff/vendors/${vendor.id}/users/${user.id}/${action}`);
    setFailure(result.ok ? null : result);
    if (result.ok) replace(result.data, true);
    return result;
  };

  const confirmAction = async () => {
    if (!confirm) return;
    setBusy(true);
    const result = await userAction(confirm.user, confirm.action);
    setBusy(false);
    setConfirmFailure(result.ok ? null : result);
    if (result.ok) setConfirm(null);
  };

  return (
    <section className="panel" aria-labelledby="users-title">
      <h2 id="users-title">{t.users}</h2>
      <p className="muted small">{t.usersHint}</p>
      {vendor.users.length === 0 ? (
        <p className="muted">{t.usersEmpty}</p>
      ) : (
        <ul className="cards">
          {vendor.users.map((user) => (
            <li key={user.id} className="card-row">
              <div>
                <strong>{user.fullName ?? (user.role === "owner" ? t.owner : t.member)}</strong>{" "}
                {user.disabledAt ? (
                  <Pill tone="warn">{t.userDisabled}</Pill>
                ) : user.telegramLinked ? (
                  <Pill tone="good">{t.telegramLinked}</Pill>
                ) : (
                  <Pill tone="muted">{t.telegramNotLinked}</Pill>
                )}
              </div>
              <PhoneReveal
                label={t.userPhone}
                load={async () => {
                  const result = await api.post<RevealedPhone>(
                    `/staff/vendors/${vendor.id}/users/${user.id}/phone`,
                    {},
                  );
                  return result.ok ? { ok: true, data: result.data.phone } : result;
                }}
              />
              {can("vendor_users.write") && (
                <div className="acts">
                  <button
                    type="button"
                    className={`btn btn-sm${user.disabledAt ? "" : " btn-danger"}`}
                    onClick={() =>
                      user.disabledAt
                        ? void userAction(user, "enable")
                        : setConfirm({ user, action: "disable" })
                    }
                  >
                    {user.disabledAt ? t.enable : t.disable}
                  </button>
                  {user.telegramLinked && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setConfirm({ user, action: "unlink" })}
                    >
                      {t.unlinkTelegram}
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmSheet
        open={confirm !== null}
        title={confirm?.action === "unlink" ? t.unlinkTelegram : t.disable}
        text={confirm?.action === "unlink" ? t.unlinkHint : t.disableUserHint}
        confirmLabel={confirm?.action === "unlink" ? t.unlinkTelegram : t.disable}
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
      {can("vendor_users.write") && (
        <form ref={form} className="inline-form" onSubmit={add} noValidate>
          <Field label={t.userPhone} error={errors.phone}>
            {(props) => (
              <input
                {...props}
                className="input"
                type="tel"
                inputMode="tel"
                autoComplete="off"
                placeholder="+998 XX XXX XX XX"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                maxLength={24}
                enterKeyHint="next"
                required
              />
            )}
          </Field>
          <Field label={t.userName} hint={t.optional}>
            {(props) => (
              <input
                {...props}
                className="input"
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
                maxLength={120}
                autoComplete="off"
                enterKeyHint="done"
              />
            )}
          </Field>
          <div className="inline-form-actions">
            <button type="submit" className="btn" disabled={busy || phone.trim() === ""}>
              {t.addUser}
            </button>
          </div>
        </form>
      )}
      {failure && <ErrorText failure={failure} />}
    </section>
  );
}
