/* Правка опубликованной карточки: «сейчас» и «предлагает вендор» по каждому полю.
   Одобрить — значения сразу попадают в карточку; отклонить — только с причиной (её
   увидит вендор). Решает модератор или администратор. */

import type {
  PriceUnit,
  RevisionChange,
  RevisionDetail,
  RevisionValue,
  StaffListingPackage,
} from "@bayramm/shared/api/staff";
import { useState } from "react";
import { type Failure, useCan, useLoad, useSession } from "../api";
import { formatMoment, formatSum, vendorLabel } from "../format";
import { t } from "../texts";
import { ConfirmForm, Link, LoadedView, Pill, StatusPill, useEntityTitle } from "../ui";

export function RevisionPage({ id }: { id: string }) {
  const { loaded, reload, set } = useLoad<RevisionDetail>(`/staff/revisions/${id}`);
  return (
    <LoadedView loaded={loaded} onRetry={reload}>
      {(revision) => <RevisionView revision={revision} onChange={set} />}
    </LoadedView>
  );
}

const isPackages = (value: RevisionValue): value is readonly StaffListingPackage[] => Array.isArray(value);

function Value({ field, value }: { field: RevisionChange["field"]; value: RevisionValue }) {
  if (value === null) return <span className="muted">{t.none}</span>;
  if (isPackages(value)) {
    return (
      <ul className="plain">
        {value.map((pkg) => (
          <li key={`${pkg.kind}-${pkg.nameRu}`}>
            {t.packageKinds[pkg.kind]}: {pkg.nameRu} / {pkg.nameUz} — {formatSum(pkg.priceUzs)}{" "}
            {t.priceUnits[pkg.priceUnit]}
          </li>
        ))}
      </ul>
    );
  }
  if (field === "priceFromUzs" && typeof value === "number") return <>{formatSum(value)}</>;
  if (field === "priceUnit" && typeof value === "string" && value in t.priceUnits) {
    return <>{t.priceUnits[value as PriceUnit]}</>;
  }
  return <span className="reason">{String(value)}</span>;
}

function RevisionView({
  revision,
  onChange,
}: {
  revision: RevisionDetail;
  onChange: (r: RevisionDetail) => void;
}) {
  useEntityTitle(`${t.views.revision}: ${revision.listing.name}`);
  const { api } = useSession();
  const can = useCan();
  const [pending, setPending] = useState<"approve" | "decline" | null>(null);

  const decide = async (reason: string): Promise<Failure | null> => {
    const result =
      pending === "decline"
        ? await api.post<RevisionDetail>(`/staff/revisions/${revision.id}/decline`, { reason })
        : await api.post<RevisionDetail>(`/staff/revisions/${revision.id}/approve`);
    if (!result.ok) return result;
    setPending(null);
    onChange(result.data);
    return null;
  };

  const open = revision.status === "pending";
  return (
    <div className="stack">
      <div className="listing-head">
        <p className="sub">
          <Link to={{ name: "listing", id: revision.listing.id }}>{t.openListing}</Link>
          {" · "}
          <Link to={{ name: "vendor", id: revision.vendor.id }}>{vendorLabel(revision.vendor)}</Link>
        </p>
        <p>
          <Pill tone={open ? "outline" : revision.status === "approved" ? "good" : "muted"}>
            {t.revisionStatus[revision.status]}
          </Pill>{" "}
          <StatusPill status={revision.listing.status} />
          <span className="sub">
            {t.submittedAt} {formatMoment(revision.submittedAt)}
          </span>
        </p>
        {!open && revision.decidedAt && (
          <p className="sub">
            {t.revisionDecided(
              t.revisionStatus[revision.status] ?? revision.status,
              revision.decidedBy,
              formatMoment(revision.decidedAt),
            )}
          </p>
        )}
        {revision.decisionReason && (
          <p className="reason">
            {t.reason}: {revision.decisionReason}
          </p>
        )}
      </div>

      {open && revision.stale && <p className="notice notice-warn">{t.revisionStale}</p>}
      {open && !revision.valid && <p className="notice notice-error">{t.revisionInvalid}</p>}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">{t.revisionField}</th>
              <th scope="col">{t.revisionNow}</th>
              <th scope="col">{t.revisionProposed}</th>
            </tr>
          </thead>
          <tbody>
            {revision.changes.map((change) => (
              <tr key={change.field}>
                <th scope="row">{t.revisionFields[change.field] ?? change.field}</th>
                <td>
                  <Value field={change.field} value={change.before} />
                </td>
                <td>
                  <Value field={change.field} value={change.after} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {open && can("revisions.moderate") && (
        <section className="panel" aria-label={t.revisions}>
          <div className="acts">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!revision.valid}
              aria-expanded={pending === "approve"}
              onClick={() => setPending(pending === "approve" ? null : "approve")}
            >
              {t.revisionApprove}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              aria-expanded={pending === "decline"}
              onClick={() => setPending(pending === "decline" ? null : "decline")}
            >
              {t.revisionDecline}
            </button>
          </div>
          {pending === "approve" && (
            <ConfirmForm
              key="approve"
              hint={t.revisionApproveHint}
              submitLabel={t.revisionApprove}
              onSubmit={decide}
              onCancel={() => setPending(null)}
            />
          )}
          {pending === "decline" && (
            <ConfirmForm
              key="decline"
              hint={t.revisionDeclineHint}
              label={t.reason}
              required
              danger
              submitLabel={t.revisionDecline}
              onSubmit={decide}
              onCancel={() => setPending(null)}
            />
          )}
        </section>
      )}
    </div>
  );
}
