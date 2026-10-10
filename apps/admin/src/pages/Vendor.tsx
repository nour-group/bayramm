/* Вендор: данные и реквизиты, чек-лист проверки, телефоны контакта, пользователи
   кабинета, витрины (по одной на категорию, бывает и несколько). Новый вендор — та же форма
   без остального, с выбором категории первой витрины. */

import type {
  ChecklistItem,
  StaffDictionaries,
  VendorDetail,
  VendorInput,
  VendorPhones,
} from "@bayramm/shared/api/staff";
import { Checkbox } from "@bayramm/ui/react";
import { useCallback, useState } from "react";
import { type Failure, type Result, useCan, useLoad, useSession } from "../api";
import { CategoryChip } from "../categories";
import { formatMoment, formatPrice } from "../format";
import { t } from "../texts";
import {
  Blockers,
  ErrorText,
  Link,
  LoadedView,
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
