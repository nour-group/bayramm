/* Карточка (витрина): категория, статус и действия, чего не хватает, фото, услуги,
   занятость по режиму категории, поля, история. Любая правка и действие несут version —
   если карточку успели изменить, сервер отвечает version_conflict, и форма просит обновить
   страницу. Правка, которая ждёт решения модератора (от вендора или менеджера), — отметкой
   вверху со ссылкой на неё. Новая витрина вендору — короткая форма: категория и название,
   остальное — на странице витрины. Что спрашивать, решает категория
   (@bayramm/shared/categories). */

import type {
  ListingAction,
  ListingDetail,
  ListingInput,
  ListingSaveResult,
  ListingStatus,
  PendingRevision,
  PublishBlocker,
  RevealedPhone,
  StaffDictionaries,
  VendorDetail,
} from "@bayramm/shared/api/staff";
import {
  attributeLabel,
  type CategoryConfig,
  categoryConfig,
  serviceTypeLabel,
} from "@bayramm/shared/categories";
import { Select } from "@bayramm/ui/react";
import { type FormEvent, useCallback, useId, useRef, useState } from "react";
import { type Failure, useCan, useLoad, useSession } from "../api";
import { categoryName, categoryOptions } from "../categories";
import { formatMoment, vendorLabel } from "../format";
import { usePhone } from "../layout";
import { t } from "../texts";
import {
  ActionBar,
  CategoryChip,
  ErrorText,
  Field,
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
import { Calendar, LeadTime } from "./Calendar";
import { ListingForm } from "./ListingForm";
import { Photos } from "./Photos";
import { Services } from "./Services";

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

export function ListingNewPage({ vendorId }: { vendorId: string }) {
  const { loaded, reload } = useLoad<VendorDetail>(`/staff/vendors/${vendorId}`);
  return (
    <div className="stack">
      <p>
        <Link to={{ name: "vendor", id: vendorId }} className="back-link">
          ← {t.openVendor}
        </Link>
      </p>
      <LoadedView loaded={loaded} onRetry={reload}>
        {(vendor) => <NewVitrinaForm vendor={vendor} />}
      </LoadedView>
    </div>
  );
}

/** Новая витрина вендору: категория (обязательно) и название; дальше — страница витрины */
function NewVitrinaForm({ vendor }: { vendor: VendorDetail }) {
  const { api } = useSession();
  const navigate = useNavigate();
  const [categoryCode, setCategoryCode] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  useUnsaved(categoryCode !== null || name.trim() !== "");
  const bad = failure?.code === "invalid_input" ? failure.details : [];
  const existing = vendor.listings.map((l) => `${l.name} (${categoryName(l.categoryCode)})`).join(", ");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (categoryCode === null) {
      setFailure({ ok: false, status: 422, code: "invalid_input", details: ["categoryCode"] });
      return;
    }
    setBusy(true);
    const result = await api.post<ListingDetail>(`/staff/vendors/${vendor.id}/listings`, {
      categoryCode,
      ...(name.trim() ? { name: name.trim() } : {}),
    });
    setBusy(false);
    if (!result.ok) {
      setFailure(result);
      return;
    }
    // Витрина создана — форма сохранена: переход без вопроса о несохранённом
    navigate({ name: "listing", id: result.data.id }, { force: true });
  };

  return (
    <form className="form" onSubmit={submit} noValidate>
      <section className="fs">
        <div className="fs-head">
          <h2>{vendorLabel(vendor)}</h2>
          <p>{t.addVitrinaLead}</p>
          {existing ? <p>{t.vitrinaHas(existing)}</p> : null}
        </div>
        <div className="fields">
          <Field
            label={t.categoryFirst}
            error={bad.includes("categoryCode") ? t.categoryRequired : undefined}
          >
            {(props) => (
              <Select
                {...props}
                className="input"
                label={t.categoryFirst}
                placeholder={t.categoryRequired}
                value={categoryCode}
                onChange={(code) => {
                  setCategoryCode(code);
                  setFailure(null);
                }}
                options={categoryOptions()}
              />
            )}
          </Field>
          <Field
            label={t.vitrinaName}
            hint={t.vitrinaNameHint}
            error={bad.includes("name") ? (t.listingFieldErrors.name ?? "") : undefined}
          >
            {(props) => (
              <input
                {...props}
                className="input"
                value={name}
                maxLength={80}
                autoComplete="off"
                placeholder={vendor.name ?? ""}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>
        </div>
      </section>
      {failure && <ErrorText failure={failure} />}
      <div className="acts">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? t.saving : t.createVitrina}
        </button>
      </div>
    </form>
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
  const category = categoryConfig(listing.categoryCode);
  if (category === undefined) return <p className="notice notice-error">{t.api.not_found}</p>;
  return (
    <CategoryListing
      listing={listing}
      category={category}
      dictionaries={dictionaries}
      onChange={onChange}
      onReload={onReload}
    />
  );
}

function CategoryListing({
  listing,
  category,
  dictionaries,
  onChange,
  onReload,
}: ListingViewProps & { category: CategoryConfig }) {
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
  // Минимум фото — у категории (не меньше трёх) и в настройках платформы: больший из двух
  const minPhotos = Math.max(dictionaries?.settings.minPhotos ?? 3, category.minPhotos);
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
          <CategoryChip code={listing.categoryCode} /> <StatusPill status={listing.status} />
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

      {showReview && (
        <ListingBlockers
          title={t.blockersReview}
          codes={listing.blockers.review}
          listing={listing}
          category={category}
          photos={{ count: approvable, min: minPhotos }}
        />
      )}
      {listing.status !== "active" && (
        <ListingBlockers
          listing={listing}
          category={category}
          photos={{ count: approvable, min: minPhotos }}
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
            photoPolicy={category.photoPolicy}
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
          <Services listing={listing} category={category} onChanged={onReload} />
          {category.availability === "lead" ? (
            <LeadTime listing={listing} category={category} />
          ) : (
            <Calendar key={category.code} listingId={listing.id} category={category} />
          )}
          <CategoryPanel listing={listing} onChange={onChange} />
          <History listing={listing} />
        </div>
        <ListingForm
          key={`${listing.id}:${listing.categoryCode}`}
          listing={listing}
          category={category}
          dictionaries={dictionaries}
          onSubmit={save}
          readOnly={!can("listings.write")}
          moderated={moderated}
          onDirtyChange={setDirty}
        />
      </div>
    </div>
  );
}

// ── чего не хватает ────────────────────────────────────────────────────────

/**
 * Чего не хватает для проверки или публикации — словами, с подробностями по категории: какие
 * данные витрины не заполнены, каких обязательных услуг нет
 */
function ListingBlockers({
  title,
  codes,
  listing,
  category,
  photos,
}: {
  title: string;
  codes: readonly PublishBlocker[];
  listing: ListingDetail;
  category: CategoryConfig;
  /** Фото, которые можно одобрить, и минимум категории */
  photos: { readonly count: number; readonly min: number };
}) {
  if (codes.length === 0) return null;
  const present = new Set(
    listing.services.filter((s) => s.status === "active" || s.status === "review").map((s) => s.type),
  );
  const missingServices = category.requiredServices.filter((code) => !present.has(code));
  const detail = (code: PublishBlocker): string | null => {
    if (code === "attributes" && listing.missingAttributes.length > 0)
      return t.readinessAttributes(
        listing.missingAttributes.map((key) => attributeLabel("ru", category, key)).join(", "),
      );
    if (code === "packages" && missingServices.length > 0)
      return t.readinessServices(missingServices.map((s) => serviceTypeLabel("ru", category, s)).join(", "));
    if (code === "photos") return t.readinessPhotos(photos.count, photos.min);
    return null;
  };
  return (
    <div className="notice notice-warn">
      <p className="notice-title">{title}</p>
      <ul className="blockers">
        {codes.map((code) => {
          const more = detail(code);
          return (
            <li key={code}>
              {t.blockers[code] ?? code}
              {more ? <span className="sub">{more}</span> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── категория витрины ──────────────────────────────────────────────────────

/**
 * Сменить категорию — только сотрудник и только пока у витрины нет заявок и услуг (иначе
 * сервер ответит category_locked: новая витрина). Данные витрины при смене очищаются
 */
function CategoryPanel({
  listing,
  onChange,
}: {
  listing: ListingDetail;
  onChange: (l: ListingDetail) => void;
}) {
  const { api } = useSession();
  const can = useCan();
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  useUnsaved(open && code !== null);
  if (!can("listings.write")) return null;
  const locked = listing.services.length > 0;

  const close = () => {
    setOpen(false);
    setCode(null);
    setFailure(null);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (code === null) return;
    setBusy(true);
    const result = await api.post<ListingDetail>(`/staff/listings/${listing.id}/category`, {
      categoryCode: code,
      version: listing.version,
    });
    setBusy(false);
    setFailure(result.ok ? null : result);
    if (result.ok) {
      close();
      onChange(result.data);
    }
  };

  return (
    <section className="panel" aria-labelledby="category-title">
      <h2 id="category-title">{t.category}</h2>
      <p>
        <CategoryChip code={listing.categoryCode} />
      </p>
      <p className="muted small">{locked ? t.categoryChangeLocked : t.categoryChangeHint}</p>
      {locked ? null : (
        <button
          ref={button}
          type="button"
          className="btn btn-sm"
          aria-expanded={open}
          onClick={() => (open ? close() : setOpen(true))}
        >
          {t.categoryChange}
        </button>
      )}
      <PhoneSheet open={open} title={t.categoryChange} onClose={close} returnFocus={button}>
        <form className="confirm" onSubmit={submit} noValidate>
          <Field label={t.categoryNew}>
            {(props) => (
              <Select
                {...props}
                className="input"
                label={t.categoryNew}
                placeholder={t.categoryRequired}
                value={code}
                onChange={setCode}
                options={categoryOptions().filter((option) => option.value !== listing.categoryCode)}
              />
            )}
          </Field>
          <div className="acts">
            <button type="submit" className="btn btn-primary" disabled={busy || code === null}>
              {t.categoryChange}
            </button>
            <button type="button" className="btn" onClick={close}>
              {t.cancel}
            </button>
          </div>
          {failure && <ErrorText failure={failure} />}
        </form>
      </PhoneSheet>
    </section>
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
