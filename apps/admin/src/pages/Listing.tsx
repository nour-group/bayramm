/* Карточка: статус и действия, чего не хватает, фото, занятые дни, поля, история.
   Любая правка и действие несут version — если карточку успели изменить, сервер
   отвечает version_conflict, и форма просит обновить страницу. */

import type {
  ListingAction,
  ListingDetail,
  ListingInput,
  ListingStatus,
  RevealedPhone,
  StaffDictionaries,
} from "@bayramm/shared/api/staff";
import { type FormEvent, useCallback, useId, useState } from "react";
import { type Failure, useCan, useLoad, useSession } from "../api";
import { formatMoment, vendorLabel } from "../format";
import { t } from "../texts";
import {
  Blockers,
  ErrorText,
  Link,
  LoadedView,
  PhoneReveal,
  publishBlockers,
  StatusPill,
  useEntityTitle,
  useNavigate,
} from "../ui";
import { Calendar } from "./Calendar";
import { ListingForm } from "./ListingForm";
import { Photos } from "./Photos";

// Какие действия доступны из статуса — те же переходы, что в базе
const ACTIONS_FROM: Record<ListingStatus, readonly ListingAction[]> = {
  lead: ["submit", "draft", "reject"],
  draft: ["submit", "reject"],
  review: ["publish", "draft", "reject"],
  active: ["suspend"],
  suspended: ["publish"],
  rejected: ["draft", "submit"],
};

const PERMISSION = {
  submit: "listings.submit",
  publish: "listings.publish",
  suspend: "listings.moderate",
  reject: "listings.moderate",
  draft: "listings.draft",
} as const;

const REASON_REQUIRED: ReadonlySet<ListingAction> = new Set(["suspend", "reject"]);

export function ListingNewPage({
  vendorId,
  dictionaries,
}: {
  vendorId: string;
  dictionaries: StaffDictionaries | null;
}) {
  const { api } = useSession();
  const navigate = useNavigate();
  const create = useCallback(
    async (body: ListingInput): Promise<Failure | null> => {
      const result = await api.post<ListingDetail>("/staff/listings", { ...body, vendorId });
      if (!result.ok) return result;
      navigate({ name: "listing", id: result.data.id });
      return null;
    },
    [api, navigate, vendorId],
  );
  return (
    <div className="stack">
      <p>
        <Link to={{ name: "vendor", id: vendorId }}>← {t.openVendor}</Link>
      </p>
      <ListingForm
        listing={null}
        dictionaries={dictionaries}
        onSubmit={create}
        submitLabel={t.createListing}
      />
    </div>
  );
}

export function ListingPage({ id, dictionaries }: { id: string; dictionaries: StaffDictionaries | null }) {
  const { loaded, reload, set } = useLoad<ListingDetail>(`/staff/listings/${id}`);
  return (
    <LoadedView loaded={loaded} onRetry={reload}>
      {(listing) => (
        <ListingView listing={listing} dictionaries={dictionaries} onChange={set} onReload={reload} />
      )}
    </LoadedView>
  );
}

interface ListingViewProps {
  listing: ListingDetail;
  dictionaries: StaffDictionaries | null;
  onChange: (listing: ListingDetail) => void;
  onReload: () => void;
}

function ListingView({ listing, dictionaries, onChange, onReload }: ListingViewProps) {
  const { api } = useSession();
  const can = useCan();
  useEntityTitle(listing.name);
  const save = useCallback(
    async (body: ListingInput): Promise<Failure | null> => {
      const result = await api.patch<ListingDetail>(`/staff/listings/${listing.id}`, {
        ...body,
        version: listing.version,
      });
      if (!result.ok) return result;
      onChange(result.data);
      return null;
    },
    [api, listing.id, listing.version, onChange],
  );
  const loadPhone = useCallback(async () => {
    const result = await api.post<RevealedPhone>(`/staff/listings/${listing.id}/phone`, {});
    return result.ok ? ({ ok: true, data: result.data.phone } as const) : result;
  }, [api, listing.id]);

  const showReview = listing.status === "lead" || listing.status === "draft" || listing.status === "rejected";
  const minPhotos = dictionaries?.settings.minPhotos ?? 3;
  const approvable = listing.photos.filter((photo) => photo.moderation !== "declined").length;
  const activeBlockers = publishBlockers(listing.blockers.active, approvable, minPhotos);

  return (
    <div className="stack">
      <div className="listing-head">
        <p className="sub">
          <Link to={{ name: "vendor", id: listing.vendor.id }}>{vendorLabel(listing.vendor)}</Link>
          {" · "}/{listing.slug}
        </p>
        <p>
          <StatusPill status={listing.status} />
          {listing.statusReason && (
            <span className="reason">
              {" "}
              {t.statusReason}: {listing.statusReason}
            </span>
          )}
        </p>
      </div>

      <StatusActions listing={listing} onChange={onChange} />

      {showReview && <Blockers title={t.blockersReview} codes={listing.blockers.review} />}
      {listing.status !== "active" && (
        <Blockers
          title={t.blockersActive}
          // До проверки — только то, чего не хватит сверх уже перечисленного
          codes={
            showReview
              ? activeBlockers.filter((code) => !listing.blockers.review.includes(code))
              : activeBlockers
          }
        />
      )}
      {(listing.status === "review" || listing.status === "suspended") && activeBlockers.length === 0 && (
        <p className="notice notice-good">{t.readyToPublish}</p>
      )}

      <div className="columns">
        <div className="stack">
          <Photos
            listingId={listing.id}
            photos={listing.photos}
            minPhotos={minPhotos}
            maxPhotos={dictionaries?.settings.maxPhotos ?? 10}
            onChanged={onReload}
          />
          <section className="panel" aria-labelledby="listing-phone-title">
            <h2 id="listing-phone-title">{t.listingSections.phone}</h2>
            {listing.hasPhone ? (
              <PhoneReveal label={t.listingFields.phone ?? ""} load={loadPhone} />
            ) : (
              <p className="muted">{t.phoneMissing}</p>
            )}
          </section>
          <Calendar listingId={listing.id} />
          <History listing={listing} />
        </div>
        <ListingForm
          key={listing.id}
          listing={listing}
          dictionaries={dictionaries}
          onSubmit={save}
          submitLabel={t.save}
          readOnly={!can("listings.write")}
        />
      </div>
    </div>
  );
}

// ── действия со статусом ───────────────────────────────────────────────────

function StatusActions({
  listing,
  onChange,
}: {
  listing: ListingDetail;
  onChange: (l: ListingDetail) => void;
}) {
  const { api } = useSession();
  const can = useCan();
  const reasonId = useId();
  const [pending, setPending] = useState<ListingAction | null>(null);
  const [reason, setReason] = useState("");
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const actions = ACTIONS_FROM[listing.status].filter((action) => can(PERMISSION[action]));
  if (actions.length === 0) return null;

  const run = async (event: FormEvent) => {
    event.preventDefault();
    if (!pending) return;
    setBusy(true);
    const body = { version: listing.version, ...(reason.trim() ? { reason: reason.trim() } : {}) };
    const result = await api.post<ListingDetail>(`/staff/listings/${listing.id}/${pending}`, body);
    setBusy(false);
    setFailure(result.ok ? null : result);
    if (result.ok) {
      setPending(null);
      setReason("");
      onChange(result.data);
    }
  };

  return (
    <section className="panel actions-panel" aria-label={t.listingFields.status}>
      <div className="acts">
        {actions.map((action) => (
          <button
            key={action}
            type="button"
            className={`btn${action === "publish" || action === "submit" ? " btn-primary" : ""}${action === "suspend" || action === "reject" ? " btn-danger" : ""}`}
            aria-expanded={pending === action}
            onClick={() => {
              setPending(pending === action ? null : action);
              setFailure(null);
            }}
          >
            {t.actions[action]}
          </button>
        ))}
      </div>
      {pending && (
        <form className="confirm" onSubmit={run} noValidate>
          <p className="muted small">{t.actionHints[pending]}</p>
          <label htmlFor={reasonId}>
            {REASON_REQUIRED.has(pending) ? t.reason : `${t.comment} (${t.optional})`}
          </label>
          <textarea
            id={reasonId}
            className="input"
            rows={2}
            maxLength={1000}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            required={REASON_REQUIRED.has(pending)}
          />
          <div className="acts">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || (REASON_REQUIRED.has(pending) && reason.trim() === "")}
            >
              {t.actions[pending]}
            </button>
            <button type="button" className="btn" onClick={() => setPending(null)}>
              {t.cancel}
            </button>
          </div>
        </form>
      )}
      {failure && <ErrorText failure={failure} />}
    </section>
  );
}

// ── история статусов ───────────────────────────────────────────────────────

function History({ listing }: { listing: ListingDetail }) {
  return (
    <section className="panel" aria-labelledby="history-title">
      <h2 id="history-title">{t.history}</h2>
      {listing.history.length === 0 ? (
        <p className="muted">{t.historyEmpty}</p>
      ) : (
        <ol className="history">
          {listing.history.map((entry) => (
            <li key={`${entry.at}-${entry.to}`}>
              <span className="sub">{formatMoment(entry.at)}</span>{" "}
              {entry.from ? `${t.status[entry.from]} → ` : ""}
              <strong>{t.status[entry.to]}</strong>
              <span className="sub"> · {entry.actorName ?? t.historyBy[entry.actorKind]}</span>
              {entry.reason && <p className="reason">{entry.reason}</p>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
