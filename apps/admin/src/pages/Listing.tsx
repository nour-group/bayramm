/* Карточка: статус и действия, чего не хватает, фото, занятые дни, поля, история.
   Любая правка и действие несут version — если карточку успели изменить, сервер
   отвечает version_conflict, и форма просит обновить страницу. Правка, которая ждёт
   решения модератора (от вендора или менеджера), — отметкой вверху со ссылкой на неё. */

import type {
  ListingAction,
  ListingDetail,
  ListingInput,
  ListingSaveResult,
  ListingStatus,
  PendingRevision,
  RevealedPhone,
  StaffDictionaries,
} from "@bayramm/shared/api/staff";
import { type FormEvent, useCallback, useId, useRef, useState } from "react";
import { type Failure, useCan, useLoad, useSession } from "../api";
import { formatMoment, vendorLabel } from "../format";
import { usePhone } from "../layout";
import { t } from "../texts";
import {
  ActionBar,
  Blockers,
  ErrorText,
  Link,
  LoadedView,
  OverflowMenu,
  PhoneReveal,
  PhoneSheet,
  publishBlockers,
  StatusPill,
  useEntityTitle,
  useNavigate,
} from "../ui";
import { useUnsaved } from "../unsaved";
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
      // Карточка создана — форма сохранена: переход без вопроса о несохранённом
      navigate({ name: "listing", id: result.data.id }, { force: true });
      return null;
    },
    [api, navigate, vendorId],
  );
  return (
    <div className="stack">
      <p>
        <Link to={{ name: "vendor", id: vendorId }} className="back-link">
          ← {t.openVendor}
        </Link>
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
    <LoadedView loaded={loaded} onRetry={reload} skeleton="detail">
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
  // Правка формы не сохранена — на телефоне внизу «Сохранить», а не смена статуса
  const [dirty, setDirty] = useState(false);
  useEntityTitle(listing.name);
  const save = useCallback(
    async (body: ListingInput): Promise<Failure | ListingSaveResult> => {
      const result = await api.patch<ListingSaveResult>(`/staff/listings/${listing.id}`, {
        ...body,
        version: listing.version,
      });
      if (!result.ok) {
        // Правку на модерацию успели открыть (вендор или коллега): перечитать карточку —
        // появится отметка о ней со ссылкой. Введённое в форме остаётся
        if (result.code === "revision_pending") onReload();
        return result;
      }
      // Карточка — как в базе после правки; что ушло на модерацию, скажет форма
      onChange(result.data);
      return result.data;
    },
    [api, listing.id, listing.version, onChange, onReload],
  );
  const loadPhone = useCallback(async () => {
    const result = await api.post<RevealedPhone>(`/staff/listings/${listing.id}/phone`, {});
    return result.ok ? ({ ok: true, data: result.data.phone } as const) : result;
  }, [api, listing.id]);

  const showReview = listing.status === "lead" || listing.status === "draft" || listing.status === "rejected";
  const minPhotos = dictionaries?.settings.minPhotos ?? 3;
  const approvable = listing.photos.filter((photo) => photo.moderation !== "declined").length;
  const activeBlockers = publishBlockers(listing.blockers.active, approvable, minPhotos);
  // Сотрудник без права решать по правкам меняет опубликованную карточку через модерацию
  const moderated = listing.status === "active" && !can("revisions.moderate");

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

      {listing.pendingRevision && <PendingRevisionNotice revision={listing.pendingRevision} />}

      <StatusActions listing={listing} onChange={onChange} hidden={dirty} />

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
          moderated={moderated}
          onDirtyChange={setDirty}
        />
      </div>
    </div>
  );
}

// ── правка на модерации ────────────────────────────────────────────────────

function PendingRevisionNotice({ revision }: { revision: PendingRevision }) {
  return (
    <div className="notice notice-warn pending-revision">
      <p className="notice-title">{t.pendingRevisionTitle}</p>
      <p>{revision.fields.map((field) => t.revisionFields[field] ?? field).join(", ")}</p>
      <p className="sub">
        {t.proposedBy(revision.proposedBy.kind, revision.proposedBy.name)} ·{" "}
        {formatMoment(revision.submittedAt)}
      </p>
      <p>
        <Link to={{ name: "revision", id: revision.id }} className="btn btn-sm">
          {t.pendingRevisionOpen}
        </Link>
      </p>
    </div>
  );
}

// ── действия со статусом ───────────────────────────────────────────────────

/** Главное действие для панели внизу телефона: вперёд по пути к публикации */
const PRIMARY: readonly ListingAction[] = ["publish", "submit"];

function actionClass(action: ListingAction): string {
  if (PRIMARY.includes(action)) return "btn btn-primary";
  if (action === "suspend" || action === "reject") return "btn btn-danger";
  return "btn";
}

function StatusActions({
  listing,
  onChange,
  hidden,
}: {
  listing: ListingDetail;
  onChange: (l: ListingDetail) => void;
  /** Форма карточки не сохранена: на телефоне панель внизу отдана «Сохранить» */
  hidden: boolean;
}) {
  const { api } = useSession();
  const can = useCan();
  const phone = usePhone();
  const reasonId = useId();
  const primaryButton = useRef<HTMLButtonElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState<ListingAction | null>(null);
  const [reason, setReason] = useState("");
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  // Вписанная причина или комментарий к смене статуса — несохранённое
  useUnsaved(pending !== null && reason.trim() !== "");
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

  const choose = (action: ListingAction) => {
    setPending(pending === action ? null : action);
    setReason("");
    setFailure(null);
  };
  // Закрыли форму причины — вписанное не остаётся висеть невидимым черновиком
  const cancel = () => {
    setPending(null);
    setReason("");
  };
  // Телефон: главное действие — кнопкой, остальные — в «Ещё»
  const primary = phone ? (actions.find((action) => PRIMARY.includes(action)) ?? actions[0]) : undefined;
  const rest = phone ? actions.filter((action) => action !== primary) : actions;

  return (
    <section className="panel actions-panel" aria-label={t.listingFields.status}>
      {phone && hidden ? null : (
        <ActionBar label={t.listingFields.status ?? ""}>
          {primary ? (
            <button
              ref={primaryButton}
              type="button"
              className={actionClass(primary)}
              aria-expanded={pending === primary}
              onClick={() => choose(primary)}
            >
              {t.actions[primary]}
            </button>
          ) : null}
          {phone ? (
            <OverflowMenu
              title={t.actionsTitle}
              context={t.listingActionsContext}
              buttonRef={moreButton}
              actions={rest.map((action) => ({
                key: action,
                label: t.actions[action],
                danger: action === "suspend" || action === "reject",
                run: () => choose(action),
              }))}
            />
          ) : (
            rest.map((action) => (
              <button
                key={action}
                type="button"
                className={actionClass(action)}
                aria-expanded={pending === action}
                onClick={() => choose(action)}
              >
                {t.actions[action]}
              </button>
            ))
          )}
        </ActionBar>
      )}
      <PhoneSheet
        open={pending !== null}
        title={pending ? t.actions[pending] : ""}
        onClose={cancel}
        returnFocus={pending === primary ? primaryButton : moreButton}
      >
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
              <button type="button" className="btn" onClick={cancel}>
                {t.cancel}
              </button>
            </div>
            {phone && failure && <ErrorText failure={failure} />}
          </form>
        )}
      </PhoneSheet>
      {!(phone && pending) && failure && <ErrorText failure={failure} />}
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
