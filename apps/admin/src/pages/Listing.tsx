/* Витрина: категория, статус и действия, чего не хватает, фото, услуги, занятость по
   режиму категории, поля, история. Любая правка и действие несут version — если витрину
   успели изменить, сервер отвечает version_conflict, и форма просит обновить страницу.
   Предложение изменений, которое ждёт решения модератора (от вендора или менеджера), —
   отметкой вверху со ссылкой на него. Новая витрина вендору — короткая форма: категория и
   название, остальное — на странице витрины. Что спрашивать, решает категория
   (@bayramm/shared/categories).

   Удалить витрину можно, только пока по ней не было заявок и она не на проверке и не в
   каталоге: блок «Удалить витрину» внизу — с причиной, если нельзя.

   Каждое сказано один раз: категория — плашкой в шапке и блоком «Категория» (сменить),
   телефон и Telegram для клиентов — блоком формы («Показать» и поля для новых значений вместе). У каждого пункта
   «чего не хватает» — переход туда, где он заполняется: услуги, фото, поля формы; проверка
   вендора (договор, СТИР…) — одной строкой со ссылкой на страницу вендора.

   Где витрина: на компьютере — путь над заголовком (вендоры → вендор), на телефоне — вендор
   ссылкой в шапке страницы и оглавление блоков, прилипшее под шапкой. Опубликованную — открыть
   на сайте; её заявки — списком заявок с фильтром витрины. ?focus=photos (из очереди фото) —
   сразу к блоку. Опубликовать и отправить на проверку, пока чего-то не хватает, — шторка
   перечисляет, чего, вместо отказа сервера. */

import type {
  ListingAction,
  ListingDetail,
  ListingInput,
  ListingSaveResult,
  ListingStatus,
  PendingRevision,
  PublishBlocker,
  RevealedListingContacts,
  StaffDictionaries,
  VendorDetail,
} from "@bayramm/shared/api/staff";
import {
  attributeLabel,
  type CategoryConfig,
  categoryConfig,
  serviceTypeLabel,
} from "@bayramm/shared/categories";
import { ConfirmSheet, Select } from "@bayramm/ui/react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { type Failure, useAuthMethods, useCan, useLoad, useSession } from "../api";
import { CategoryChip, categoryName, categoryOptions } from "../categories";
import { formatMoment, vendorLabel } from "../format";
import { useLayout, usePhone } from "../layout";
import { ReasonField } from "../reason";
import { readQuery } from "../router";
import { t } from "../texts";
import {
  ActionBar,
  Blockers,
  busyLabel,
  deleteFailureText,
  ErrorText,
  Field,
  focusSection,
  Link,
  LoadedView,
  OverflowMenu,
  PhoneSheet,
  publishBlockers,
  StatusPill,
  useBreadcrumbs,
  useEntityTitle,
  useNavigate,
} from "../ui";
import { useUnsaved } from "../unsaved";
import { Calendar, LeadTime } from "./Calendar";
import { ListingForm } from "./ListingForm";
import { NextInQueue } from "./NextInQueue";
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

/** Снимают с каталога или отказывают: кнопка подтверждения — цвета отказа, с готовыми причинами */
const DESTRUCTIVE: ReadonlySet<ListingAction> = new Set(["suspend", "reject"]);
const REASON_PRESETS: Partial<Record<ListingAction, readonly string[]>> = {
  suspend: t.reasons.listingSuspend,
  reject: t.reasons.listingReject,
};

export function ListingNewPage({ vendorId }: { vendorId: string }) {
  const { loaded, reload } = useLoad<VendorDetail>(`/staff/vendors/${vendorId}`);
  // К вендору — путь над заголовком на компьютере и «назад» в шапке телефона
  return (
    <LoadedView loaded={loaded} onRetry={reload} skeleton="detail">
      {(vendor) => <NewVitrinaForm vendor={vendor} />}
    </LoadedView>
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
  useBreadcrumbs([{ label: vendorLabel(vendor), to: { name: "vendor", id: vendor.id } }]);
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
        <button type="submit" className="btn btn-primary" aria-busy={busy || undefined} disabled={busy}>
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
  // Модератор решил по витрине на проверке — путь к следующей в очереди
  const [decided, setDecided] = useState(false);
  const desktop = useLayout() === "desktop";
  const phone = usePhone();
  const methods = useAuthMethods();
  useEntityTitle(listing.name);
  useBreadcrumbs([{ label: vendorLabel(listing.vendor), to: { name: "vendor", id: listing.vendor.id } }]);
  useFocusParam();
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
  // Телефон и Telegram — одним чтением (одна запись в журнале доступа к ПДн)
  const loadContacts = useCallback(
    () => api.post<RevealedListingContacts>(`/staff/listings/${listing.id}/phone`, {}),
    [api, listing.id],
  );

  const showReview = listing.status === "lead" || listing.status === "draft" || listing.status === "rejected";
  // Минимум фото — у категории (не меньше трёх) и в настройках платформы: больший из двух
  const minPhotos = Math.max(dictionaries?.settings.minPhotos ?? 3, category.minPhotos);
  const approvable = listing.photos.filter((photo) => photo.moderation !== "declined").length;
  const activeBlockers = publishBlockers(listing.blockers.active, approvable, minPhotos);
  // Сотрудник без права решать по правкам меняет опубликованную карточку через модерацию
  const moderated = listing.status === "active" && !can("revisions.moderate");
  // Блок «Данные витрины» есть у формы, если у категории есть поля или вместимость
  const showAttributes = category.attributes.length > 0 || category.listingFields.includes("guest_capacity");
  // Опубликованная — открыть так, как её видит клиент (адрес сайта — из GET /auth/methods)
  const siteUrl =
    listing.status === "active" && methods
      ? `${methods.apps.web}/venue/${encodeURIComponent(listing.slug)}`
      : null;

  return (
    <div className="stack">
      <div className="listing-head">
        {/* На компьютере вендор — в пути над заголовком; на телефоне — здесь */}
        {desktop ? null : (
          <p className="sub">
            <Link to={{ name: "vendor", id: listing.vendor.id }}>{vendorLabel(listing.vendor)}</Link>
          </p>
        )}
        <p>
          <CategoryChip code={listing.categoryCode} /> <StatusPill status={listing.status} />
          {listing.statusReason && (
            <span className="reason">
              {" "}
              {t.statusReason}: {listing.statusReason}
            </span>
          )}
        </p>
        {t.statusHints[listing.status] ? (
          <p className="muted small">{t.statusHints[listing.status]}</p>
        ) : null}
        {siteUrl || can("requests.read") ? (
          <p className="head-links">
            {siteUrl ? (
              <a className="btn btn-sm" href={siteUrl} target="_blank" rel="noopener noreferrer">
                {t.listingOnSite}
                <span className="visually-hidden"> ({t.opensNewTab})</span>
              </a>
            ) : null}
            {can("requests.read") ? (
              <Link to={{ name: "requests", query: { listingId: listing.id } }} className="btn btn-sm">
                {t.listingRequests}
              </Link>
            ) : null}
          </p>
        ) : null}
      </div>

      {listing.pendingRevision && <PendingRevisionNotice revision={listing.pendingRevision} />}

      <StatusActions
        listing={listing}
        onChange={onChange}
        hidden={dirty}
        onDecided={() => setDecided(true)}
        blockers={{ publish: activeBlockers, submit: listing.blockers.review }}
      />
      {decided && listing.status !== "review" ? <NextInQueue queue="review" currentId={listing.id} /> : null}

      {showReview && (
        <ListingBlockers
          title={t.blockersReview}
          codes={listing.blockers.review}
          listing={listing}
          category={category}
          photos={{ count: approvable, min: minPhotos }}
          showAttributes={showAttributes}
        />
      )}
      {listing.status !== "active" && (
        <ListingBlockers
          listing={listing}
          category={category}
          photos={{ count: approvable, min: minPhotos }}
          showAttributes={showAttributes}
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

      {/* Оглавление — перед блоками, которые оно перечисляет: прилипает, когда до них дошли */}
      {phone ? <SectionIndex category={category} showAttributes={showAttributes} /> : null}
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
          <Services listing={listing} category={category} onChanged={onReload} />
          {category.availability === "lead" ? (
            <LeadTime listing={listing} category={category} />
          ) : (
            <Calendar key={category.code} listingId={listing.id} category={category} />
          )}
          <CategoryPanel listing={listing} onChange={onChange} />
          <History listing={listing} />
          <DeleteListing listing={listing} onReload={onReload} />
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
          contacts={{ hasPhone: listing.hasPhone, hasTelegram: listing.hasTelegram, load: loadContacts }}
        />
      </div>
    </div>
  );
}

// ── оглавление и переход к блоку ───────────────────────────────────────────

/** Блоки страницы витрины и заголовки, к которым ведёт оглавление и ?focus= */
const SECTIONS = {
  photos: "photos-title",
  services: "services-title",
  calendar: "calendar-title",
  main: "form-main-title",
  attrs: "form-attrs-title",
  phone: "form-phone-title",
  history: "history-title",
} as const;

type SectionKey = keyof typeof SECTIONS;

const isSection = (value: string | undefined): value is SectionKey =>
  value !== undefined && Object.hasOwn(SECTIONS, value);

/**
 * ?focus=photos — пришли из очереди «Новые фото» (услуги — из очереди услуг): к блоку, когда
 * страница отрисовалась. Один раз за заход
 */
function useFocusParam() {
  useEffect(() => {
    const focus = readQuery(["focus"] as const).focus;
    if (!isSection(focus)) return;
    const timer = setTimeout(() => focusSection(SECTIONS[focus]), 0);
    return () => clearTimeout(timer);
  }, []);
}

/**
 * Оглавление витрины на телефоне: страница — одна длинная колонка, к блоку — одним нажатием.
 * Прилипает под шапкой; пункты — по категории (без данных витрины — без «Данных», у срока
 * заказа вместо календаря — «Занятость» ведёт к сроку)
 */
function SectionIndex({ category, showAttributes }: { category: CategoryConfig; showAttributes: boolean }) {
  const keys = (Object.keys(SECTIONS) as SectionKey[]).filter((key) => key !== "attrs" || showAttributes);
  const target = (key: SectionKey) =>
    key === "calendar" && category.availability === "lead" ? "lead-title" : SECTIONS[key];
  return (
    <nav className="section-index" aria-label={t.listingIndex}>
      <ul>
        {keys.map((key) => (
          <li key={key}>
            <button type="button" className="chip" onClick={() => focusSection(target(key))}>
              {t.listingIndexItems[key]}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

// ── чего не хватает ────────────────────────────────────────────────────────

/** Где на странице витрины заполняется пункт «чего не хватает»: заголовок блока */
const BLOCKER_TARGET: Partial<Record<PublishBlocker, string>> = {
  price: "services-title",
  packages: "services-title",
  photos: "photos-title",
  descriptions: "form-texts-title",
  attributes: "form-attrs-title",
  capacity: "form-attrs-title",
  district: "form-main-title",
  phone: "form-phone-title",
};

/** Пункты проверки вендора: их отмечают на странице вендора, а не витрины */
const VENDOR_CHECKS: ReadonlySet<PublishBlocker> = new Set(["contract", "stir", "contacts", "pd_consent"]);

/**
 * Чего не хватает для проверки или публикации — словами, с подробностями по категории: какие
 * данные витрины не заполнены, каких обязательных услуг нет. У каждого пункта — переход к
 * блоку, где он заполняется; проверка вендора — одной строкой со ссылкой на вендора
 */
function ListingBlockers({
  title,
  codes,
  listing,
  category,
  photos,
  showAttributes,
}: {
  title: string;
  codes: readonly PublishBlocker[];
  listing: ListingDetail;
  category: CategoryConfig;
  /** Фото, которые можно одобрить, и минимум категории */
  photos: { readonly count: number; readonly min: number };
  /** У формы есть блок «Данные витрины» (поля категории или вместимость) */
  showAttributes: boolean;
}) {
  if (codes.length === 0) return null;
  const own = codes.filter((code) => !VENDOR_CHECKS.has(code));
  const checks = codes.filter((code) => VENDOR_CHECKS.has(code));
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
  const targetOf = (code: PublishBlocker): string | undefined => {
    const target = BLOCKER_TARGET[code];
    return target === "form-attrs-title" && !showAttributes ? undefined : target;
  };
  return (
    <div className="notice notice-warn">
      <p className="notice-title">{title}</p>
      <ul className="blockers blockers-go">
        {own.map((code) => {
          const more = detail(code);
          const label = t.blockers[code] ?? code;
          const target = targetOf(code);
          return (
            <li key={code}>
              <span className="blocker-text">
                {label}
                {more ? <span className="sub">{more}</span> : null}
              </span>
              {target ? (
                <button type="button" className="btn btn-sm" onClick={() => focusSection(target)}>
                  {t.goTo}
                  <span className="visually-hidden">: {label}</span>
                </button>
              ) : null}
            </li>
          );
        })}
        {checks.length > 0 ? (
          <li>
            <span className="blocker-text">
              {t.checklist}
              <span className="sub">{checks.map((code) => t.blockers[code] ?? code).join(", ")}</span>
            </span>
            <Link to={{ name: "vendor", id: listing.vendor.id }} className="btn btn-sm">
              {t.toChecklist}
            </Link>
          </li>
        ) : null}
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
      {/* Открыта форма — что будет, сказано в ней, у кнопки: здесь не повторяем */}
      {locked || !open ? (
        <p className="muted small">{locked ? t.categoryChangeLocked : t.categoryChangeHint}</p>
      ) : null}
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
          {/* Что будет — в самой форме, у кнопки: подсказка над блоком в шторке не видна */}
          <div className="notice notice-warn">
            {code ? (
              <p className="notice-title">
                {t.categoryChangeFromTo(categoryName(listing.categoryCode), categoryName(code))}
              </p>
            ) : null}
            <p>{t.categoryChangeConsequence}</p>
          </div>
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
            <button type="submit" className="btn btn-danger" disabled={busy || code === null}>
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
  if (DESTRUCTIVE.has(action)) return "btn btn-danger";
  return "btn";
}

function StatusActions({
  listing,
  onChange,
  hidden,
  onDecided,
  blockers,
}: {
  listing: ListingDetail;
  onChange: (l: ListingDetail) => void;
  /** Форма витрины не сохранена: на телефоне панель внизу отдана «Сохранить» */
  hidden: boolean;
  /** Решение по витрине на проверке (опубликовать, вернуть, отклонить) — дальше следующая */
  onDecided: () => void;
  /** Чего не хватает для публикации и для проверки: шторка скажет это, а не сервер отказом */
  blockers: { readonly publish: readonly PublishBlocker[]; readonly submit: readonly PublishBlocker[] };
}) {
  const { api } = useSession();
  const can = useCan();
  const phone = usePhone();
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
      if (listing.status === "review") onDecided();
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
  // Опубликовать или отправить на проверку, когда чего-то не хватает, — сервер откажет
  // (publish_blocked): шторка сразу перечисляет, чего, и кнопку не даёт
  const blocked: readonly PublishBlocker[] =
    pending === "publish" ? blockers.publish : pending === "submit" ? blockers.submit : [];
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
            {blocked.length > 0 ? (
              <Blockers title={t.actionBlocked[pending] ?? ""} codes={blocked} />
            ) : (
              <>
                <p className="muted small">{t.actionHints[pending]}</p>
                <ReasonField
                  label={REASON_REQUIRED.has(pending) ? t.reason : `${t.comment} (${t.optional})`}
                  value={reason}
                  onChange={setReason}
                  presets={REASON_PRESETS[pending]}
                  required={REASON_REQUIRED.has(pending)}
                />
              </>
            )}
            <div className="acts">
              <button
                type="submit"
                className={`btn ${DESTRUCTIVE.has(pending) ? "btn-danger-fill" : "btn-primary"}`}
                aria-busy={busy || undefined}
                disabled={
                  busy || blocked.length > 0 || (REASON_REQUIRED.has(pending) && reason.trim() === "")
                }
              >
                {busyLabel(t.actions[pending], busy)}
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
      <h2 id="history-title" tabIndex={-1}>
        {t.history}
      </h2>
      {listing.history.length === 0 ? (
        <p className="muted">{t.historyEmpty}</p>
      ) : (
        <ol className="history">
          {listing.history.map((entry) => (
            <li key={`${entry.at}-${entry.to}`}>
              <span className="sub">
                {formatMoment(entry.at)} · {entry.actorName ?? t.historyBy[entry.actorKind]}
              </span>
              {entry.from ? `${t.status[entry.from]} → ` : ""}
              <strong>{t.status[entry.to]}</strong>
              {entry.reason && <p className="reason">{entry.reason}</p>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

// ── удаление ───────────────────────────────────────────────────────────────

/**
 * Удалить витрину — администратор и менеджер, и только пока по ней не было заявок и она не на
 * проверке и не в каталоге. Почему нельзя, сервер говорит заранее (deleteBlocker): кнопка
 * недоступна, рядом — что сделать вместо. Удалили — к вендору без вопроса о несохранённом и
 * без записи удалённой витрины в истории («назад» не приведёт к «не найдено»)
 */
function DeleteListing({ listing, onReload }: { listing: ListingDetail; onReload: () => void }) {
  const { api } = useSession();
  const can = useCan();
  const navigate = useNavigate();
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  if (!can("listings.delete")) return null;
  const blocker = listing.deleteBlocker;

  const remove = async () => {
    setBusy(true);
    const result = await api.del<null>(`/staff/listings/${listing.id}`);
    setBusy(false);
    if (!result.ok) {
      setFailure(result);
      // Пока смотрели, появилась заявка или витрину отправили на проверку — блок покажет почему
      if (result.code === "listing_in_use") onReload();
      return;
    }
    setOpen(false);
    navigate({ name: "vendor", id: listing.vendor.id }, { force: true, replace: true });
  };
  const close = () => {
    setOpen(false);
    setFailure(null);
  };

  return (
    <section className="panel" aria-labelledby="delete-title">
      <h2 id="delete-title">{t.listingDelete}</h2>
      <p className="muted small">{blocker ? t.listingDeleteBlocked[blocker] : t.listingDeleteHint}</p>
      <button
        ref={button}
        type="button"
        className="btn btn-sm btn-danger"
        disabled={blocker !== null}
        onClick={() => setOpen(true)}
      >
        {t.listingDelete}
      </button>
      <ConfirmSheet
        open={open}
        title={t.listingDeleteTitle}
        text={t.listingDeleteText(listing.name)}
        confirmLabel={t.listingDelete}
        cancelLabel={t.cancel}
        tone="danger"
        busy={busy}
        confirmDisabled={failure?.code === "listing_in_use"}
        error={failure ? deleteFailureText(failure, t.listingDeleteBlocked) : undefined}
        returnFocus={button}
        onConfirm={() => void remove()}
        onCancel={close}
      />
    </section>
  );
}
