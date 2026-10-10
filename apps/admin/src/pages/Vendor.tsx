/* Вендор: данные и реквизиты, чек-лист проверки, телефоны контакта, пользователи
   кабинета, витрины (по одной на категорию, бывает и несколько). Новый вендор — та же форма
   без остального, с выбором категории первой витрины. Удалить вендора целиком — администратор
   (в шапке: кнопкой, на телефоне — в «Ещё»), только пока ни у одной витрины не было заявок и
   ни одна не на проверке и не в каталоге; подтверждение — кодом вендора. */

import type {
  ChecklistItem,
  StaffDictionaries,
  VendorDetail,
  VendorInput,
  VendorPhones,
} from "@bayramm/shared/api/staff";
import { Checkbox, ConfirmSheet } from "@bayramm/ui/react";
import { useCallback, useId, useRef, useState } from "react";
import { type Failure, type Result, useCan, useLoad, useSession } from "../api";
import { CategoryChip } from "../categories";
import { formatMoment, formatPrice } from "../format";
import { usePhone } from "../layout";
import { t } from "../texts";
import {
  Blockers,
  deleteFailureText,
  ErrorText,
  Link,
  LoadedView,
  OverflowMenu,
  PhoneReveal,
  StatusPill,
  useEntityTitle,
  useNavigate,
} from "../ui";
import { VendorResponsePanel } from "./Metrics";
import { VendorForm } from "./VendorForm";
import { VendorUsers } from "./VendorUsers";

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
      <div className="vendor-head">
        <p className="sub">
          {t.vendorCode}: {vendor.code}
          {vendor.manager?.name ? ` · ${t.fields.managerId}: ${vendor.manager.name}` : ""}
        </p>
        <DeleteVendor vendor={vendor} />
      </div>
      <div className="columns">
        <div className="stack">
          <Checklist vendor={vendor} onChange={onChange} />
          <ContactPhones vendorId={vendor.id} />
          <Listings vendor={vendor} />
          {can("metrics.read") && <VendorResponsePanel vendorId={vendor.id} />}
          <VendorUsers vendor={vendor} onChange={onChange} />
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

// ── удаление ───────────────────────────────────────────────────────────────

/**
 * Удалить вендора — только администратор. Почему нельзя, сервер говорит заранее
 * (deleteBlocker): действие недоступно, под ним — что сделать вместо. Подтверждение — кодом
 * вендора (V101): удаляется всё сразу, вернуть нельзя. Удалили — к списку вендоров без
 * вопроса о несохранённом и без записи удалённого в истории
 */
function DeleteVendor({ vendor }: { vendor: VendorDetail }) {
  const { api } = useSession();
  const can = useCan();
  const phone = usePhone();
  const navigate = useNavigate();
  const codeId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  if (!can("vendors.delete")) return null;
  const blocker = blocked ?? vendor.deleteBlocker;
  const typed = code.trim().toUpperCase() === vendor.code.toUpperCase();

  const remove = async () => {
    setBusy(true);
    const result = await api.del<null>(`/staff/vendors/${vendor.id}`);
    setBusy(false);
    if (!result.ok) {
      setFailure(result);
      // Пока смотрели, появилась заявка или витрину отправили на проверку
      if (result.code === "vendor_in_use") setBlocked(result.details[0] ?? "published");
      return;
    }
    setOpen(false);
    navigate({ name: "vendors" }, { force: true, replace: true });
  };
  const close = () => {
    setOpen(false);
    setCode("");
    setFailure(null);
  };

  return (
    <div className="vendor-delete">
      {phone ? (
        <OverflowMenu
          title={t.actionsTitle}
          context={t.vendorActionsContext}
          buttonRef={button}
          className="btn btn-sm"
          actions={[
            {
              key: "delete",
              label: t.vendorDelete,
              danger: true,
              disabled: blocker !== null,
              run: () => setOpen(true),
            },
          ]}
        />
      ) : (
        <button
          ref={button}
          type="button"
          className="btn btn-sm btn-danger"
          disabled={blocker !== null}
          onClick={() => setOpen(true)}
        >
          {t.vendorDelete}
        </button>
      )}
      {blocker ? (
        <p className="muted small">{t.vendorDeleteBlocked[blocker] ?? t.api.vendor_in_use}</p>
      ) : null}
      <ConfirmSheet
        open={open}
        title={t.vendorDeleteTitle}
        text={
          <>
            <p>{t.vendorDeleteText(vendor.code)}</p>
            <label htmlFor={codeId}>{t.vendorDeleteCode(vendor.code)}</label>
            <input
              id={codeId}
              className="input"
              value={code}
              maxLength={16}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              enterKeyHint="done"
              onChange={(event) => setCode(event.target.value)}
            />
          </>
        }
        confirmLabel={t.vendorDelete}
        cancelLabel={t.cancel}
        tone="danger"
        busy={busy}
        confirmDisabled={!typed || failure?.code === "vendor_in_use"}
        error={failure ? deleteFailureText(failure, t.vendorDeleteBlocked) : undefined}
        returnFocus={button}
        onConfirm={() => void remove()}
        onCancel={close}
      />
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
