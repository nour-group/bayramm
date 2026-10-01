/* Предложение изменений опубликованной витрины: «сейчас» и «предлагает» по каждому полю.
   Предлагает вендор из кабинета или менеджер из панели — кто именно, видно в шапке.
   Одобрить — значения сразу попадают на витрину; отклонить — только с причиной (её увидит
   вендор). Решает модератор или администратор; после решения — кнопка к следующему
   предложению в очереди (NextInQueue), фокус — на ней. */

import type {
  PriceUnit,
  RevisionChange,
  RevisionDetail,
  RevisionValue,
  StaffListingPackage,
} from "@bayramm/shared/api/staff";
import {
  type AttributeValue,
  attributeText,
  type CategoryConfig,
  categoryConfig,
} from "@bayramm/shared/categories";
import { useRef, useState } from "react";
import { type Failure, useCan, useLoad, useSession } from "../api";
import { ru } from "../categories";
import { formatMoment, formatSum, vendorLabel } from "../format";
import { usePhone } from "../layout";
import { t } from "../texts";
import {
  ActionBar,
  ConfirmForm,
  Link,
  LoadedView,
  PhoneSheet,
  Pill,
  StatusPill,
  useEntityTitle,
} from "../ui";
import { NextInQueue } from "./NextInQueue";

export function RevisionPage({ id }: { id: string }) {
  const { loaded, reload, set } = useLoad<RevisionDetail>(`/staff/revisions/${id}`);
  return (
    <LoadedView loaded={loaded} onRetry={reload}>
      {(revision) => <RevisionView revision={revision} onChange={set} />}
    </LoadedView>
  );
}

const isPackages = (value: RevisionValue): value is readonly StaffListingPackage[] =>
  Array.isArray(value) && value.every((item) => typeof item === "object" && item !== null);

const isRecord = (value: RevisionValue): value is Readonly<Record<string, AttributeValue | null>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Данные витрины в правке: подпись поля и значение словами (пусто — «убрать») */
function AttributesValue({
  category,
  value,
}: {
  category: CategoryConfig;
  value: Readonly<Record<string, unknown>>;
}) {
  return (
    <ul className="plain">
      {Object.entries(value).map(([key, item]) => {
        const field = category.attributes.find((a) => a.key === key);
        const label = field ? ru(field.label) : key;
        const text = field ? attributeText("ru", field, item, t.yes) : item === null ? null : String(item);
        return (
          <li key={key}>
            {label}: {text ?? t.none}
          </li>
        );
      })}
    </ul>
  );
}

function Value({
  field,
  value,
  category,
}: {
  field: RevisionChange["field"];
  value: RevisionValue;
  category: CategoryConfig | undefined;
}) {
  if (value === null) return <span className="muted">{t.none}</span>;
  if (field === "attributes" && isRecord(value) && category) {
    return <AttributesValue category={category} value={value} />;
  }
  if (field === "videoLinks" && Array.isArray(value)) {
    return value.length === 0 ? (
      <span className="muted">{t.none}</span>
    ) : (
      <ul className="plain">
        {(value as readonly string[]).map((link) => (
          <li key={link} className="reason">
            {link}
          </li>
        ))}
      </ul>
    );
  }
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
  // Ссылки на видео и поля витрины — как есть, пока у панели нет своего вида для них
  if (Array.isArray(value)) return <span className="reason">{value.join(", ")}</span>;
  if (typeof value === "object") return <span className="reason">{JSON.stringify(value)}</span>;
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
  const category = categoryConfig(revision.listing.categoryCode);
  const { api } = useSession();
  const can = useCan();
  const phone = usePhone();
  const [pending, setPending] = useState<"approve" | "decline" | null>(null);
  // Решили здесь и сейчас — показать путь к следующему предложению очереди
  const [decided, setDecided] = useState(false);
  const approveButton = useRef<HTMLButtonElement>(null);
  const declineButton = useRef<HTMLButtonElement>(null);

  const decide = async (reason: string): Promise<Failure | null> => {
    const result =
      pending === "decline"
        ? await api.post<RevisionDetail>(`/staff/revisions/${revision.id}/decline`, { reason })
        : await api.post<RevisionDetail>(`/staff/revisions/${revision.id}/approve`);
    if (!result.ok) return result;
    setPending(null);
    setDecided(true);
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
          <span className="sub">{t.proposedBy(revision.proposedBy.kind, revision.proposedBy.name)}</span>
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

      {decided && !open ? <NextInQueue queue="revisions" currentId={revision.id} /> : null}
      {open && revision.stale && <p className="notice notice-warn">{t.revisionStale}</p>}
      {open && !revision.valid && <p className="notice notice-error">{t.revisionInvalid}</p>}

      {phone ? (
        <ul className="rcards" aria-label={t.revisionField}>
          {revision.changes.map((change) => (
            <li key={change.field} className="rcard">
              <p className="rcard-title">{t.revisionFields[change.field] ?? change.field}</p>
              <div className="change">
                <p className="change-label">{t.revisionNow}</p>
                <div className="change-value">
                  <Value field={change.field} value={change.before} category={category} />
                </div>
              </div>
              <div className="change change-new">
                <p className="change-label">{t.revisionProposed[revision.proposedBy.kind]}</p>
                <div className="change-value">
                  <Value field={change.field} value={change.after} category={category} />
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{t.revisionField}</th>
                <th scope="col">{t.revisionNow}</th>
                <th scope="col">{t.revisionProposed[revision.proposedBy.kind]}</th>
              </tr>
            </thead>
            <tbody>
              {revision.changes.map((change) => (
                <tr key={change.field}>
                  <th scope="row">{t.revisionFields[change.field] ?? change.field}</th>
                  <td>
                    <Value field={change.field} value={change.before} category={category} />
                  </td>
                  <td>
                    <Value field={change.field} value={change.after} category={category} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Решить не может (менеджер) — объяснение, а не пустое место вместо кнопок */}
      {open && !can("revisions.moderate") && <p className="notice">{t.revisionWhoDecides}</p>}
      {open && can("revisions.moderate") && (
        <section className="panel panel-actions" aria-label={t.revisions}>
          <ActionBar label={t.revisions}>
            <button
              ref={approveButton}
              type="button"
              className="btn btn-primary"
              disabled={!revision.valid}
              aria-expanded={pending === "approve"}
              onClick={() => setPending(pending === "approve" ? null : "approve")}
            >
              {t.revisionApprove}
            </button>
            <button
              ref={declineButton}
              type="button"
              className="btn btn-danger"
              aria-expanded={pending === "decline"}
              onClick={() => setPending(pending === "decline" ? null : "decline")}
            >
              {t.revisionDecline}
            </button>
          </ActionBar>
          <PhoneSheet
            open={pending === "approve"}
            title={t.revisionApprove}
            onClose={() => setPending(null)}
            returnFocus={approveButton}
          >
            <ConfirmForm
              key="approve"
              hint={t.revisionApproveHint}
              submitLabel={t.revisionApprove}
              onSubmit={decide}
              onCancel={() => setPending(null)}
            />
          </PhoneSheet>
          <PhoneSheet
            open={pending === "decline"}
            title={t.revisionDecline}
            onClose={() => setPending(null)}
            returnFocus={declineButton}
          >
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
          </PhoneSheet>
        </section>
      )}
    </div>
  );
}
