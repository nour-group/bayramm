/* Витрина: категория, статус и действия, чего не хватает, фото, услуги, занятость по
   режиму категории, поля, история. Любая правка и действие несут version — если витрину
   успели изменить, сервер отвечает version_conflict, и форма просит обновить страницу.
   Предложение изменений, которое ждёт решения модератора (от вендора или менеджера), —
   одной строкой со ссылкой на него. Новая витрина вендору — короткая форма: категория и
   название, остальное — на странице витрины. Что спрашивать, решает категория
   (@bayramm/shared/categories).

   Порядок страницы — порядок работы, один на телефоне и компьютере:
     1. строка «категория · статус · вендор» и «…» (на компьютере — и главное действие);
     2. один блок «что дальше» — «Что осталось» (пункты с «Перейти», проверка вендора —
        одной строкой «n/4» со ссылкой на вендора), «Ждёт решения» у витрины на проверке;
     3. «Основное» с описаниями, 4. «Фото», 5. «Услуги», 6. «Занятость» («Заказов
        одновременно» — в её шапке), 7. «Данные витрины» с видео, 8. «Контакты»;
     9. «Служебное» (свёрнуто): история (три записи), категория (пока можно сменить), удалить
        (пока можно).
   На компьютере соседние блоки встают парами в ряд — читать их слева направо и сверху вниз
   по-прежнему тот же порядок. Форма — одна на страницу (ListingForm.tsx: части по порядку, одно
   «Сохранить»).

   «…» в шапке: открыть на сайте (опубликованную), заявки витрины, второстепенные действия со
   статусом (вернуть в черновик, отклонить, приостановить) и «Удалить витрину» — когда нельзя,
   пункт недоступен и говорит почему. Главное действие — «Отправить на проверку» или
   «Опубликовать»: пока чего-то не хватает, в подписи — сколько осталось, а нажатие ведёт к
   блоку «Что осталось», а не открывает шторку; у опубликованной главного действия нет, и панели
   внизу телефона тоже.

   Удалить витрину можно, только пока по ней не было заявок и она не на проверке и не в
   каталоге.

   Где витрина: на компьютере — путь над заголовком (вендоры → вендор), на телефоне — вендор
   ссылкой в шапке страницы и оглавление блоков, прилипшее под шапкой. ?focus=photos (из очереди
   фото) — сразу к блоку. */

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
import { ConfirmSheet, Select, UiIcon } from "@bayramm/ui/react";
import {
  type FormEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { type Failure, useAuthMethods, useCan, useLoad, useSession } from "../api";
import { CategoryChip, categoryName, categoryOptions } from "../categories";
import { formatMoment, vendorLabel } from "../format";
import { useLayout, usePhone } from "../layout";
import { ReasonField } from "../reason";
import { readQuery } from "../router";
import { t } from "../texts";
import {
  ActionBar,
  busyLabel,
  deleteFailureText,
  ErrorText,
  Field,
  focusSection,
  Link,
  LoadedView,
  type MenuAction,
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
import { ContactChange } from "./ContactChange";
import {
  CapacityControl,
  ContactsSection,
  DataSection,
  EditorBar,
  hasDataSection,
  ListingEditor,
  MainSection,
} from "./ListingForm";
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

// ── что осталось до проверки и публикации ──────────────────────────────────

/** Пункты проверки вендора: их отмечают на странице вендора, а не витрины */
const VENDOR_CHECKS: ReadonlySet<PublishBlocker> = new Set(["contract", "stir", "contacts", "pd_consent"]);

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

/** Заголовок блока «что дальше»: сюда ведёт главное действие, пока чего-то не хватает */
const NEXT_TITLE = "next-title";

/** Главное действие — вперёд по пути к публикации; остальные — в «…» */
const PRIMARY: readonly ListingAction[] = ["publish", "submit"];

interface Remaining {
  /** Пункты самой витрины (без проверки вендора), по порядку */
  readonly own: readonly PublishBlocker[];
  /** Пункты проверки вендора, что ещё не отмечены */
  readonly vendor: readonly PublishBlocker[];
  /** Сколько осталось до «Отправить на проверку» */
  readonly submit: number;
  /** Сколько осталось до «Опубликовать»: пункты витрины и вся проверка вендора — за один */
  readonly publish: number;
}

/**
 * Что осталось: у неопубликованной — для проверки и сверх неё для публикации, у витрины на
 * проверке или приостановленной — для публикации (готовые фото, ждущие решения, не мешают: их
 * одобряет сама публикация); у опубликованной — ничего
 */
function remainingOf(listing: ListingDetail, approvable: number, minPhotos: number): Remaining {
  const none: Remaining = { own: [], vendor: [], submit: 0, publish: 0 };
  if (listing.status === "active") return none;
  const forPublish = publishBlockers(listing.blockers.active, approvable, minPhotos);
  const ownPublish = forPublish.filter((code) => !VENDOR_CHECKS.has(code));
  const vendor = forPublish.filter((code) => VENDOR_CHECKS.has(code));
  const beforeReview =
    listing.status === "lead" || listing.status === "draft" || listing.status === "rejected";
  const own = beforeReview
    ? [...listing.blockers.review, ...ownPublish.filter((code) => !listing.blockers.review.includes(code))]
    : ownPublish;
  return {
    own,
    vendor,
    submit: listing.blockers.review.length,
    publish: ownPublish.length + (vendor.length > 0 ? 1 : 0),
  };
}

// ── страница ───────────────────────────────────────────────────────────────

function CategoryListing({
  listing,
  category,
  dictionaries,
  onChange,
  onReload,
}: ListingViewProps & { category: CategoryConfig }) {
  const { api } = useSession();
  const can = useCan();
  const navigate = useNavigate();
  // Правка формы не сохранена — на телефоне внизу «Сохранить», а не смена статуса
  const [dirty, setDirty] = useState(false);
  // Модератор решил по витрине на проверке — путь к следующей в очереди
  const [decided, setDecided] = useState(false);
  // Удалить — из «…» и из «Служебного»: подтверждение одно
  const [deleting, setDeleting] = useState(false);
  const layout = useLayout();
  const desktop = layout === "desktop";
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

  // Минимум фото — у категории (не меньше трёх) и в настройках платформы: больший из двух
  const minPhotos = Math.max(dictionaries?.settings.minPhotos ?? 3, category.minPhotos);
  const approvable = listing.photos.filter((photo) => photo.moderation !== "declined").length;
  const left = remainingOf(listing, approvable, minPhotos);
  // Сотрудник без права решать по правкам меняет опубликованную карточку через модерацию
  const moderated = listing.status === "active" && !can("revisions.moderate");
  // Блок «Данные витрины» есть у формы, если у категории есть поля, вместимость или видео
  const showAttributes = hasDataSection(category);
  // Опубликованная — открыть так, как её видит клиент (адрес сайта — из GET /auth/methods)
  const siteUrl =
    listing.status === "active" && methods
      ? `${methods.apps.web}/venue/${encodeURIComponent(listing.slug)}`
      : null;

  const status = useStatusActions({
    listing,
    onChange,
    onDecided: () => setDecided(true),
    left,
  });
  const blocker = listing.deleteBlocker;
  const menu: MenuAction[] = [
    ...(siteUrl ? [{ key: "site", label: t.listingOnSite, href: siteUrl, run: () => {} }] : []),
    ...(can("requests.read")
      ? [
          {
            key: "requests",
            label: t.listingRequests,
            run: () => navigate({ name: "requests", query: { listingId: listing.id } }),
          },
        ]
      : []),
    ...status.menu,
    ...(can("listings.delete")
      ? [
          {
            key: "delete",
            label: t.listingDelete,
            danger: true,
            disabled: blocker !== null,
            ...(blocker ? { hint: t.listingDeleteBlocked[blocker] } : {}),
            run: () => setDeleting(true),
          },
        ]
      : []),
  ];

  // Телефон: главное действие — в панели внизу, пока форма не сохранена (там «Сохранить»);
  // шире — кнопкой в шапке
  const primary = status.primaryButton;

  return (
    <div className="stack listing-page">
      <div className="listing-top">
        <div className="listing-meta">
          <CategoryChip code={listing.categoryCode} />
          <StatusPill status={listing.status} />
          {/* На компьютере вендор — в пути над заголовком; на телефоне и планшете — здесь */}
          {desktop ? null : (
            <Link to={{ name: "vendor", id: listing.vendor.id }}>{vendorLabel(listing.vendor)}</Link>
          )}
        </div>
        <div className="listing-top-actions">
          {phone ? null : primary}
          <OverflowMenu
            title={t.actionsTitle}
            context={t.listingActionsContext}
            className="btn btn-icon"
            buttonRef={status.moreRef}
            actions={menu}
          />
        </div>
      </div>
      {listing.statusReason ? (
        <p className="reason">
          {t.statusReason}: {listing.statusReason}
        </p>
      ) : null}
      {status.sheet}
      {status.failureText}

      {listing.pendingRevision ? <PendingRevisionRow revision={listing.pendingRevision} /> : null}
      <ListingEditor
        key={`${listing.id}:${listing.categoryCode}`}
        listing={listing}
        category={category}
        dictionaries={dictionaries}
        onSubmit={save}
        readOnly={!can("listings.write")}
        moderated={moderated}
        onDirtyChange={setDirty}
        contacts={{ hasPhone: listing.hasPhone, hasTelegram: listing.hasTelegram, load: loadContacts }}
      >
        {/* Две колонки на компьютере читаются так же, как одна на телефоне: сначала левая, потом правая */}
        <div className="listing-cols">
          <div className="listing-col">
            <NextStep
              listing={listing}
              category={category}
              left={left}
              photos={{ count: approvable, min: minPhotos }}
              showAttributes={showAttributes}
            />
            {decided && listing.status !== "review" ? (
              <NextInQueue queue="review" currentId={listing.id} />
            ) : null}
            {/* Оглавление — перед блоками, которые оно перечисляет: прилипает, когда до них дошли */}
            {phone ? <SectionIndex category={category} showAttributes={showAttributes} /> : null}
            <MainSection />
            <Photos
              listingId={listing.id}
              photoPolicy={category.photoPolicy}
              photos={listing.photos}
              minPhotos={minPhotos}
              maxPhotos={dictionaries?.settings.maxPhotos ?? 10}
              onChanged={onReload}
            />
            <Services listing={listing} category={category} onChanged={onReload} />
          </div>
          <div className="listing-col">
            {category.availability === "lead" ? (
              <LeadTime listing={listing} category={category} />
            ) : (
              <Calendar
                key={category.code}
                listingId={listing.id}
                category={category}
                capacity={listing.parallelCapacity}
                headerExtra={<CapacityControl />}
              />
            )}
            <DataSection />
            {/* Партнёр просит сменить контакты витрины на проверке или на сайте (блок сам прячется, если просьбы нет) */}
            <ContactChange listingId={listing.id} onDecided={onReload} />
            <ContactsSection />
          </div>
        </div>
        <ServiceBlock listing={listing} onChange={onChange} onDelete={() => setDeleting(true)} />
        <EditorBar />
      </ListingEditor>
      {phone && primary && !dirty ? (
        <ActionBar label={t.listingFields.status ?? ""}>{primary}</ActionBar>
      ) : null}
      <DeleteListing
        listing={listing}
        open={deleting}
        onClose={() => setDeleting(false)}
        onReload={onReload}
      />
    </div>
  );
}

// ── оглавление и переход к блоку ───────────────────────────────────────────

/** Блоки страницы витрины и заголовки, к которым ведёт оглавление, ?focus= и «Перейти» */
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

/** Что в оглавлении на телефоне: основное — первый блок страницы, служебное — в конце, их нет */
const INDEX: readonly SectionKey[] = ["photos", "services", "calendar", "attrs", "phone"];

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
  const keys = INDEX.filter((key) => key !== "attrs" || showAttributes);
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

// ── что дальше ─────────────────────────────────────────────────────────────

/**
 * Один блок «что дальше»: «Что осталось» — пункты с переходом к блоку, где каждый заполняется
 * (с подробностями по категории: какие данные не заполнены, каких обязательных услуг нет), проверка
 * вендора — одной строкой «n/4» со ссылкой на вендора; «Ждёт решения» — у витрины на проверке,
 * когда осталось только решить. У опубликованной блока нет
 */
function NextStep({
  listing,
  category,
  left,
  photos,
  showAttributes,
}: {
  listing: ListingDetail;
  category: CategoryConfig;
  left: Remaining;
  /** Фото, которые можно одобрить, и минимум категории */
  photos: { readonly count: number; readonly min: number };
  /** У формы есть блок «Данные витрины» (поля категории, вместимость или видео) */
  showAttributes: boolean;
}) {
  if (left.own.length === 0 && left.vendor.length === 0) {
    if (listing.status !== "review") return null;
    return (
      <section className="notice notice-warn next-step" aria-labelledby={NEXT_TITLE}>
        <h2 id={NEXT_TITLE} className="notice-title" tabIndex={-1}>
          {t.listingWaits}
        </h2>
        {listing.submittedAt ? (
          <p className="sub">{t.listingSubmitted(formatMoment(listing.submittedAt))}</p>
        ) : null}
      </section>
    );
  }
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
    <section className="notice notice-warn next-step" aria-labelledby={NEXT_TITLE}>
      <h2 id={NEXT_TITLE} className="notice-title" tabIndex={-1}>
        {t.listingLeft}
      </h2>
      <ul className="blockers blockers-go">
        {left.own.map((code) => {
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
        {left.vendor.length > 0 ? (
          <li>
            <span className="blocker-text">{t.vendorChecksDone(4 - left.vendor.length, 4)}</span>
            <Link to={{ name: "vendor", id: listing.vendor.id }} className="btn btn-sm">
              {t.toVendor}
            </Link>
          </li>
        ) : null}
      </ul>
    </section>
  );
}

// ── служебное: история, категория, удалить ─────────────────────────────────

/** Сколько записей истории видно сразу */
const HISTORY_SHOWN = 3;

/**
 * «Служебное» — свёрнуто: нужно редко. История статусов (последние записи, остальные — по
 * кнопке), смена категории (пока услуг нет), удаление (пока можно). ?focus=history раскрывает
 */
function ServiceBlock({
  listing,
  onChange,
  onDelete,
}: {
  listing: ListingDetail;
  onChange: (l: ListingDetail) => void;
  onDelete: () => void;
}) {
  const can = useCan();
  const [open, setOpen] = useState(() => readQuery(["focus"] as const).focus === "history");
  const [all, setAll] = useState(false);
  const bodyId = "service-body";
  const canDelete = can("listings.delete") && listing.deleteBlocker === null;
  const entries = all ? listing.history : listing.history.slice(0, HISTORY_SHOWN);
  return (
    <section className="panel service-block" aria-labelledby="service-title">
      <h2 id="service-title">
        <button
          type="button"
          className="disclosure"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen(!open)}
        >
          <span>{t.listingService}</span>
          <UiIcon name="caret" size={17} className="disclosure-caret" />
        </button>
      </h2>
      {open ? (
        <div id={bodyId} className="service-body">
          <div>
            <h3 id="history-title" className="sub-title" tabIndex={-1}>
              {t.history}
            </h3>
            {listing.history.length === 0 ? (
              <p className="muted">{t.historyEmpty}</p>
            ) : (
              <ol className="history">
                {entries.map((entry) => (
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
            {!all && listing.history.length > HISTORY_SHOWN ? (
              <button type="button" className="btn btn-sm" onClick={() => setAll(true)}>
                {t.historyAll(listing.history.length)}
              </button>
            ) : null}
          </div>
          <CategoryPanel listing={listing} onChange={onChange} />
          {canDelete ? (
            <div>
              <button type="button" className="btn btn-sm btn-danger" onClick={onDelete}>
                {t.listingDelete}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

// ── категория витрины ──────────────────────────────────────────────────────

/**
 * Сменить категорию — только сотрудник и только пока у витрины нет заявок и услуг (иначе
 * сервер ответит category_locked: новая витрина); когда услуги есть — блока нет. Данные
 * витрины при смене очищаются
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
  if (!can("listings.write") || listing.services.length > 0) return null;

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
    <div className="category-line">
      <span>
        {t.category}: <CategoryChip code={listing.categoryCode} />
      </span>
      <button
        ref={button}
        type="button"
        className="btn btn-sm"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {t.categoryChange}
      </button>
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
    </div>
  );
}

// ── правка на модерации ────────────────────────────────────────────────────

/** Предложение изменений ждёт решения: одна строка — что и кто, и ссылка на него */
function PendingRevisionRow({ revision }: { revision: PendingRevision }) {
  return (
    <div className="notice notice-warn pending-revision">
      <div className="pending-text">
        <p className="notice-title">{t.pendingRevisionTitle}</p>
        <p className="sub">
          {revision.fields.map((field) => t.revisionFields[field] ?? field).join(", ")} ·{" "}
          {t.proposedBy(revision.proposedBy.kind, revision.proposedBy.name)} ·{" "}
          {formatMoment(revision.submittedAt)}
        </p>
      </div>
      <Link to={{ name: "revision", id: revision.id }} className="btn btn-sm">
        {t.pendingRevisionOpen}
      </Link>
    </div>
  );
}

// ── действия со статусом ───────────────────────────────────────────────────

function actionClass(action: ListingAction): string {
  if (PRIMARY.includes(action)) return "btn btn-primary";
  if (DESTRUCTIVE.has(action)) return "btn btn-danger";
  return "btn";
}

interface StatusControls {
  /** Главная кнопка (отправить на проверку, опубликовать); у опубликованной её нет */
  readonly primaryButton: ReactNode;
  /** Остальные действия со статусом — для «…» в шапке */
  readonly menu: MenuAction[];
  /** «…» шапки: туда возвращается фокус после шторки второстепенного действия */
  readonly moreRef: RefObject<HTMLButtonElement | null>;
  /** Причина или комментарий к выбранному действию: шторка на телефоне, форма на месте шире */
  readonly sheet: ReactNode;
  /** Ошибка сервера не в шторке (на компьютере форма на месте — ошибка в ней же) */
  readonly failureText: ReactNode;
}

/**
 * Смена статуса. Главное действие, пока чего-то не хватает, шторку не открывает — ведёт к блоку
 * «Что осталось» (в подписи — сколько осталось); остальные действия — в «…» шапки. Причина
 * отказа или приостановки — обязательна, с готовыми причинами; к остальным — комментарий в историю
 */
function useStatusActions({
  listing,
  onChange,
  onDecided,
  left,
}: {
  listing: ListingDetail;
  onChange: (l: ListingDetail) => void;
  /** Решение по витрине на проверке (опубликовать, вернуть, отклонить) — дальше следующая */
  onDecided: () => void;
  left: Remaining;
}): StatusControls {
  const { api } = useSession();
  const can = useCan();
  const phone = usePhone();
  const primaryRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState<ListingAction | null>(null);
  const [reason, setReason] = useState("");
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  // Вписанная причина или комментарий к смене статуса — несохранённое
  useUnsaved(pending !== null && reason.trim() !== "");
  const actions = ACTIONS_FROM[listing.status].filter((action) => can(PERMISSION[action]));
  const primary = actions.find((action) => PRIMARY.includes(action));

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

  const remaining = primary === "publish" ? left.publish : primary === "submit" ? left.submit : 0;
  const primaryButton = primary ? (
    <button
      ref={primaryRef}
      type="button"
      className={actionClass(primary)}
      aria-expanded={pending === primary}
      // Не хватает — к блоку «Что осталось»: шторка с подтверждением была бы отказом сервера
      onClick={() => (remaining > 0 ? focusSection(NEXT_TITLE) : choose(primary))}
    >
      {remaining > 0 ? t.actionLeft(t.actions[primary], remaining) : t.actions[primary]}
    </button>
  ) : null;

  const menu: MenuAction[] = actions
    .filter((action) => action !== primary)
    .map((action) => ({
      key: action,
      label: t.actions[action],
      danger: DESTRUCTIVE.has(action),
      run: () => choose(action),
    }));

  const form = pending ? (
    <form className="confirm" onSubmit={run} noValidate>
      <p className="muted small">{t.actionHints[pending]}</p>
      <ReasonField
        label={REASON_REQUIRED.has(pending) ? t.reason : `${t.comment} (${t.optional})`}
        value={reason}
        onChange={setReason}
        presets={REASON_PRESETS[pending]}
        required={REASON_REQUIRED.has(pending)}
      />
      <div className="acts">
        <button
          type="submit"
          className={`btn ${DESTRUCTIVE.has(pending) ? "btn-danger-fill" : "btn-primary"}`}
          aria-busy={busy || undefined}
          disabled={busy || (REASON_REQUIRED.has(pending) && reason.trim() === "")}
        >
          {busyLabel(t.actions[pending], busy)}
        </button>
        <button type="button" className="btn" onClick={cancel}>
          {t.cancel}
        </button>
      </div>
      {phone && failure && <ErrorText failure={failure} />}
    </form>
  ) : null;

  return {
    primaryButton,
    menu,
    moreRef,
    sheet: pending ? (
      <PhoneSheet
        open
        title={t.actions[pending]}
        onClose={cancel}
        returnFocus={pending === primary ? primaryRef : moreRef}
      >
        {phone ? form : <section className="panel status-form">{form}</section>}
      </PhoneSheet>
    ) : null,
    failureText: !(phone && pending) && failure ? <ErrorText failure={failure} /> : null,
  };
}

// ── удаление ───────────────────────────────────────────────────────────────

/**
 * Удалить витрину — администратор и менеджер, и только пока по ней не было заявок и она не на
 * проверке и не в каталоге. Почему нельзя, сервер говорит заранее (deleteBlocker): пункт «…»
 * недоступен и объясняет, кнопки в «Служебном» тогда нет. Удалили — к вендору без вопроса о
 * несохранённом и без записи удалённой витрины в истории («назад» не приведёт к «не найдено»)
 */
function DeleteListing({
  listing,
  open,
  onClose,
  onReload,
}: {
  listing: ListingDetail;
  open: boolean;
  onClose: () => void;
  onReload: () => void;
}) {
  const { api } = useSession();
  const can = useCan();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  if (!can("listings.delete")) return null;

  const remove = async () => {
    setBusy(true);
    const result = await api.del<null>(`/staff/listings/${listing.id}`);
    setBusy(false);
    if (!result.ok) {
      setFailure(result);
      // Пока смотрели, появилась заявка или витрину отправили на проверку — «…» покажет почему
      if (result.code === "listing_in_use") onReload();
      return;
    }
    onClose();
    navigate({ name: "vendor", id: listing.vendor.id }, { force: true, replace: true });
  };
  const close = () => {
    onClose();
    setFailure(null);
  };

  return (
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
      onConfirm={() => void remove()}
      onCancel={close}
    />
  );
}
