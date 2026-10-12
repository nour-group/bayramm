/* Витрина — выбранная витрина как есть в базе (то, что видит клиент). Название, описания,
   данные витрины категории и ссылки на видео владелец кабинета меняет предложением
   (Proposal.tsx), фото — загрузкой здесь: и то, и другое проверяет команда, до одобрения
   клиенты видят прежнее (сказано один раз — вверху экрана). Цена «от» — из услуг: здесь
   только она и ссылка на «Услуги», списка услуг второй раз нет. Адрес, район, вместимость и
   телефон меняет менеджер — под ними код вендора для разговора с ним. Сотрудник площадки
   (роль member) витрину только смотрит. Рейтинга нет: его на первом запуске не показываем.

   Витрина не на сайте — сверху чек-лист «что осталось до публикации» (Readiness): почему она
   не опубликована, пункты партнёра — каждый с кнопкой туда, где он делается (услуги, фото,
   предложение изменений), и одной строкой — что сделает команда (район, договор, СТИР…).
   Пока витрина не опубликована, пункты партнёра — то, что мешает отправить её на проверку:
   услуги и фото, которые ждут решения команды, уже не его забота. Всё сделал — владелец
   кабинета сам отправляет черновик (и отклонённую) на проверку кнопкой «Отправить на
   проверку»: команде приходит оповещение, витрина — «на проверке». Новый партнёр попадает
   сюда из входящих (строка «что дальше»).

   Фото — свой блок, VenuePhotos.tsx (загрузка по правилу категории, порядок, обложка, удаление).

   Порядок: чек-лист (если витрина не на сайте), изменения (предложение на проверке, отказ с
   причиной и кнопка «Предложить» — до фото, а не после двух экранов сведений), затем фото и
   сведения. На компьютере — две колонки: фото слева, сведения справа; изменения над ними во
   всю ширину, поля формы парами (RU рядом с UZ). */

import type { VendorListing, VendorListingRef, VendorRole } from "@bayramm/shared/api/vendor";
import {
  attributeLabel,
  type CategoryConfig,
  categoryConfig,
  priceUnitLabel,
  serviceTypeLabel,
} from "@bayramm/shared/categories";
import { type MouseEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { AttributeFacts } from "./Attributes";
import { ApiFailure, api } from "./api";
import { categoryName } from "./category";
import { errorText } from "./errors";
import { formatMoney } from "./format";
import { fill, type TextKey, textOf, type VendorDict } from "./i18n";
import { Icon } from "./icons";
import { ListingPicker } from "./ListingPicker";
import { Proposal } from "./Proposal";
import { type Location, type Navigate, pathOf } from "./router";
import { Empty, Heading, LoadError, Loading, type ScreenProps } from "./ui";
import { useLoad } from "./useLoad";
import { VenueContacts } from "./VenueContacts";
import { VenuePhotos } from "./VenuePhotos";
import { WithdrawAction } from "./VenueWithdraw";

function Capacity({ listing, t }: { listing: VendorListing; t: VendorDict }) {
  if (listing.capMax === null) return <>{t.notSet}</>;
  return (
    <>
      {listing.capMin !== null
        ? fill(t.capRange, { min: listing.capMin, max: listing.capMax })
        : fill(t.capUpTo, { max: listing.capMax })}
    </>
  );
}

/** Пункт чек-листа готовности: что сделать и кнопка туда, где это делается */
export interface Todo {
  readonly key: string;
  /** Что сделать: пункты с одной и той же кнопкой — строками одного пункта */
  readonly lines: readonly string[];
  readonly action?: { readonly label: string; readonly run: () => void };
}

/** Пункты партнёра — их он делает сам; остальные коды готовности делает команда Bayramm */
const VENDOR_BLOCKERS: ReadonlySet<string> = new Set([
  "price",
  "packages",
  "photos",
  "descriptions",
  "attributes",
]);

/** Что сказано о витрине не на сайте — по статусу: пункты ещё есть / своё партнёр сделал */
const STATUS_LEAD: Readonly<
  Record<VendorListing["status"], { readonly todo: TextKey; readonly done: TextKey } | null>
> = {
  lead: { todo: "readyDraft", done: "readyLeadDone" },
  draft: { todo: "readyDraft", done: "readyDraftDone" },
  review: { todo: "readyReview", done: "readyReview" },
  active: null,
  suspended: { todo: "readySuspended", done: "readySuspended" },
  rejected: { todo: "readyRejected", done: "readyRejectedDone" },
};

/** Из этих статусов партнёр сам отправляет витрину на проверку (POST …/submit) */
const SUBMITTABLE: ReadonlySet<VendorListing["status"]> = new Set(["draft", "rejected"]);

/** Опубликована (или приостановлена после публикации): пункты — что мешает быть на сайте */
const isLive = (status: VendorListing["status"]) => status === "active" || status === "suspended";

/**
 * Коды готовности, из которых пункты партнёра: пока витрина не опубликована — что мешает
 * отправить её на проверку (услуги и фото, которые ждут решения, засчитаны — дальше дело
 * команды), у опубликованной — что мешает ей быть на сайте
 */
const partnerCodes = (listing: VendorListing) =>
  isLive(listing.status) ? listing.blockers : listing.reviewBlockers;

/** Куда ведут кнопки чек-листа */
interface TodoRoutes {
  readonly services: () => void;
  readonly photos: () => void;
  readonly propose: () => void;
}

/** Пункты партнёра: что сделать самому и где (коды готовности базы и пустые данные витрины) */
export function vendorTodos(
  listing: VendorListing,
  category: CategoryConfig | undefined,
  t: VendorDict,
  lang: "ru" | "uz",
  go: TodoRoutes,
): Todo[] {
  const blockers = new Set(partnerCodes(listing));
  const todos: Todo[] = [];
  const toServices = { label: t.toServices, run: go.services };
  // Форма изменений — блок прямо под чек-листом со своей «Предложить изменения»: тут другая подпись
  const propose = { label: t.toFill, run: go.propose };
  if (blockers.has("price")) todos.push({ key: "price", lines: [t.todoPrice], action: toServices });
  if (blockers.has("packages")) {
    const list =
      category && category.requiredServices.length > 0
        ? category.requiredServices.map((type) => serviceTypeLabel(lang, category, type)).join(", ")
        : t.blocker_packages;
    todos.push({ key: "packages", lines: [fill(t.todoServices, { list })], action: toServices });
  }
  const ready = listing.photos.filter((photo) => photo.moderation !== "declined").length;
  // До публикации база засчитывает для проверки и отклонённые фото — партнёру честнее считать без них
  if (blockers.has("photos") || (!isLive(listing.status) && ready < listing.photoLimits.min)) {
    todos.push({
      key: "photos",
      lines: [fill(t.todoPhotos, { n: ready, min: listing.photoLimits.min })],
      action: { label: t.toPhotos, run: go.photos },
    });
  }
  if (blockers.has("descriptions"))
    todos.push({ key: "descriptions", lines: [t.todoDescriptions], action: propose });
  if (blockers.has("attributes") || listing.missingAttributes.length > 0) {
    const list =
      category && listing.missingAttributes.length > 0
        ? // «;»: у подписи бывает единица через запятую («Готовый материал через, дней»)
          listing.missingAttributes.map((key) => attributeLabel(lang, category, key)).join("; ")
        : t.blocker_attributes;
    todos.push({ key: "attributes", lines: [fill(t.todoAttributes, { list })], action: propose });
  }
  // Одна кнопка — один пункт: «описание» и «данные витрины» делаются одним предложением, цена и
  // обязательные услуги — в «Услугах»; две одинаковые кнопки подряд только путали бы
  const merged: Todo[] = [];
  for (const todo of todos) {
    const same = merged.findIndex((m) => m.action?.label === todo.action?.label);
    const into = merged[same];
    if (into && todo.action) merged[same] = { ...into, lines: [...into.lines, ...todo.lines] };
    else merged.push(todo);
  }
  return merged;
}

interface ReadinessProps {
  readonly listing: VendorListing;
  readonly category: CategoryConfig | undefined;
  readonly t: VendorDict;
  readonly lang: "ru" | "uz";
  readonly owner: boolean;
  readonly go: TodoRoutes;
  /** Витрину отправили на проверку (или она устарела): перечитать её и значки разделов */
  readonly onSubmitted: () => Promise<void>;
}

/** Коды готовности словами, через запятую */
const codesText = (codes: readonly string[], t: VendorDict) =>
  codes.map((code) => textOf(t, `blocker_${code}`)).join(", ");

/**
 * «Отправить на проверку» — владельцу кабинета, когда свои пункты сделаны. Не всё готово
 * (кто-то успел изменить витрину) — чего не хватает, и витрина перечитывается
 */
function SubmitAction({
  listing,
  t,
  owner,
  onSubmitted,
  onDone,
}: {
  listing: VendorListing;
  t: VendorDict;
  owner: boolean;
  onSubmitted: () => Promise<void>;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!owner) return <p className="note">{t.submitOwner}</p>;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.submitListing(listing.id);
      onDone();
      await onSubmitted();
    } catch (err) {
      const blocked = err instanceof ApiFailure && err.code === "publish_blocked" && err.details.length > 0;
      setError(blocked ? fill(t.submitBlocked, { list: codesText(err.details, t) }) : errorText(err, t));
      // Витрину успели изменить — чек-лист заново, как сейчас
      if (err instanceof ApiFailure && (blocked || err.code === "illegal_transition")) await onSubmitted();
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="actions">
        <button type="button" className="btn btn-dark" disabled={busy} onClick={() => void submit()}>
          {t.submitListing}
        </button>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

/**
 * Готовность к публикации — чек-лист: почему витрины нет на сайте, что сделать партнёру (с
 * кнопкой туда, где это делается) и одной строкой — что сделает команда. Своё сделано —
 * «Отправить на проверку» (черновик и отклонённая); отправили — «на проверке у команды».
 * Опубликованная витрина, где делать нечего, — блока нет
 */
function Readiness({ listing, category, t, lang, owner, go, onSubmitted }: ReadinessProps) {
  const todos = vendorTodos(listing, category, t, lang, go);
  const team = listing.blockers.filter((code) => !VENDOR_BLOCKERS.has(code));
  // Своё партнёр сделал, а отправить мешает то, что заполняет команда (район, телефон…)
  const teamFirst = listing.reviewBlockers.filter((code) => !VENDOR_BLOCKERS.has(code));
  const submittable = SUBMITTABLE.has(listing.status) && todos.length === 0;
  const canSubmit = submittable && teamFirst.length === 0;
  // Отправили отсюда: сказать об этом и держать фокус на сказанном (кнопка исчезла)
  const [sent, setSent] = useState(false);
  const sentRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (sent && listing.status === "review") sentRef.current?.focus({ preventScroll: true });
  }, [sent, listing.status]);
  const leadKeys = STATUS_LEAD[listing.status];
  const lead =
    submittable && teamFirst.length > 0
      ? fill(t.readyDraftWait, { list: codesText(teamFirst, t) })
      : leadKeys
        ? t[todos.length === 0 ? leadKeys.done : leadKeys.todo]
        : null;
  if (lead === null && todos.length === 0) return null;
  const reason = listing.statusReason ? (
    <p className="note">{fill(t.reasonLine, { reason: listing.statusReason })}</p>
  ) : null;
  const action = canSubmit ? (
    <SubmitAction
      listing={listing}
      t={t}
      owner={owner}
      onSubmitted={onSubmitted}
      onDone={() => setSent(true)}
    />
  ) : listing.status === "review" ? (
    <WithdrawAction listing={listing} t={t} owner={owner} onWithdrawn={onSubmitted} />
  ) : null;
  const done =
    sent && listing.status === "review" ? (
      <p className="note" role="status" tabIndex={-1} ref={sentRef}>
        {t.submitDone}
      </p>
    ) : null;
  if (todos.length === 0 && team.length === 0) {
    return (
      <div className="notice readiness">
        <p>{lead}</p>
        {reason}
        {action}
        {done}
      </div>
    );
  }
  return (
    <section className="panel readiness" aria-labelledby="ready-title">
      <h2 className="section-title" id="ready-title">
        {t.blockersTitle}
      </h2>
      {lead ? <p className="lead">{lead}</p> : null}
      {reason}
      {todos.length > 0 ? (
        <ul className="todo">
          {todos.map((todo) => (
            <li key={todo.key} className="todo-item">
              <span className="todo-text">
                <span className="todo-mark" aria-hidden="true" />
                <span className="todo-lines">
                  {todo.lines.map((line) => (
                    <span key={line} className="todo-line">
                      {line}
                    </span>
                  ))}
                </span>
              </span>
              {owner && todo.action ? (
                <button type="button" className="btn btn-ghost todo-go" onClick={todo.action.run}>
                  {todo.action.label}
                  <span className="sr-only">: {todo.lines.join("; ")}</span>
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {!owner && todos.length > 0 ? <p className="note">{t.todoOwner}</p> : null}
      {team.length > 0 ? <p className="note">{fill(t.todoTeam, { list: codesText(team, t) })}</p> : null}
      {action}
      {done}
    </section>
  );
}

/** Ссылка на раздел без перезагрузки (новая вкладка, окно — как решит браузер) */
function SectionLink({
  to,
  navigate,
  className,
  children,
}: {
  to: Location;
  navigate: Navigate;
  className: string;
  children: ReactNode;
}) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
  };
  return (
    <a className={className} href={pathOf(to)} onClick={onClick}>
      {children}
    </a>
  );
}

interface VenueProps extends ScreenProps {
  readonly listings: readonly VendorListingRef[];
  readonly listingId: string | null;
  readonly onListing: (id: string) => void;
  readonly vendorCode: string;
  /** Роль в кабинете: витрину (фото и предложения) меняет только владелец */
  readonly role: VendorRole;
  /** Выбор витрины — в боковой панели (компьютер) */
  readonly inSidebar?: boolean;
  readonly navigate: Navigate;
  /** Партнёр изменил витрину (фото, предложение): значки «требует внимания» в разделах — заново */
  readonly onChanged?: () => void;
}

export function Venue({
  t,
  lang,
  headingRef,
  listings,
  listingId,
  onListing,
  vendorCode,
  role,
  inSidebar = false,
  navigate,
  onChanged,
}: VenueProps) {
  const [listing, reload, , refresh] = useLoad<VendorListing>(listingId, (id) => api.listing(id));
  const owner = role === "owner";
  // Тихо, чтобы список ошибок загрузки и фокус остались; не вышло — обычная загрузка с повтором
  const refreshListing = async () => {
    if (!(await refresh())) reload();
    onChanged?.();
  };

  if (listings.length === 0 || !listingId) {
    return (
      <section className="page" aria-labelledby="page-title">
        <Heading headingRef={headingRef}>{t.card}</Heading>
        <Empty icon="hall" title={t.noListings} text={t.noListingsText} />
        <p className="note">{fill(t.vendorCode, { code: vendorCode })}</p>
      </section>
    );
  }

  // Выбор витрины на экране (телефон, планшет) уже называет её — второй раз имя не нужно
  const pickerShown = listings.length > 1 && !inSidebar;
  return (
    <section className="page" aria-labelledby="page-title">
      <Heading headingRef={headingRef}>{t.card}</Heading>
      <ListingPicker
        listings={listings}
        value={listingId}
        onChange={(id) => id && onListing(id)}
        t={t}
        lang={lang}
        inSidebar={inSidebar}
        line={false}
        mark="card"
      />
      <p className="promise">
        <Icon name="info" size={17} />
        <span>{owner ? t.venueNote : t.venueNoteMember}</span>
      </p>

      {listing.state === "loading" ? <Loading t={t} kind="card" /> : null}
      {listing.state === "error" ? <LoadError t={t} onRetry={reload} error={listing.error} /> : null}
      {listing.state === "ready" ? (
        <VenueCard
          listing={listing.data}
          t={t}
          lang={lang}
          owner={owner}
          showName={!pickerShown}
          vendorCode={vendorCode}
          navigate={navigate}
          onChanged={refreshListing}
          onProposal={onChanged}
        />
      ) : null}
    </section>
  );
}

interface VenueCardProps {
  readonly listing: VendorListing;
  readonly t: VendorDict;
  readonly lang: "ru" | "uz";
  readonly owner: boolean;
  /** Имя витрины заголовком: выбора витрины на экране нет */
  readonly showName: boolean;
  readonly vendorCode: string;
  readonly navigate: Navigate;
  readonly onChanged: () => Promise<void>;
  /** Предложение изменений отправлено или отозвано */
  readonly onProposal?: () => void;
}

function VenueCard({
  listing,
  t,
  lang,
  owner,
  showName,
  vendorCode,
  navigate,
  onChanged,
  onProposal,
}: VenueCardProps) {
  const category = categoryConfig(listing.categoryCode);
  const fields = category?.listingFields ?? ["guest_capacity", "district"];
  // Кнопка чек-листа «Предложить изменения»: растёт — форма предложения открывается
  const [propose, setPropose] = useState(0);
  const go: TodoRoutes = {
    services: () => navigate({ route: "services" }),
    // Фото — на этом же экране: фокус на заголовок блока, браузер прокрутит к нему
    photos: () => document.getElementById("photos-title")?.focus(),
    propose: () => setPropose((n) => n + 1),
  };
  return (
    <article className="venue">
      <div className="detail-top">
        {showName ? <h2 className="venue-name">{listing.name}</h2> : null}
        <span className="venue-chips">
          {/* Имя и категорию уже называет выбор витрины на экране — здесь только статус */}
          {showName ? (
            <span className="chip chip-cat">{categoryName(lang, listing.categoryCode)}</span>
          ) : null}
          <span className={`chip chip-${listing.status === "active" ? "done" : "wait"}`}>
            {textOf(t, `ls_${listing.status}`)}
          </span>
        </span>
      </div>

      {/* Ключ — витрина: «отправили на проверку» другой витрины не переносится */}
      <Readiness
        key={`ready-${listing.id}`}
        listing={listing}
        category={category}
        t={t}
        lang={lang}
        owner={owner}
        go={go}
        onSubmitted={onChanged}
      />

      {/* Изменения — сразу под чек-листом: предложение на проверке, отказ с причиной и сама
        кнопка «Предложить» не прячутся под фото и сведениями (на телефоне — через два экрана).
        Ключ — витрина: при смене витрины форма и предложения — заново */}
      <Proposal
        key={listing.id}
        listing={listing}
        t={t}
        lang={lang}
        owner={owner}
        openSignal={propose}
        onChanged={onProposal}
      />

      <div className="venue-grid">
        {/* Ключ — витрина: галочка и ошибки загрузки другой витрины не переносятся.
          Не тот же, что у Proposal: ключи соседей в одном родителе обязаны различаться */}
        <VenuePhotos
          key={`photos-${listing.id}`}
          listing={listing}
          portfolio={category?.photoPolicy === "portfolio"}
          t={t}
          owner={owner}
          onChanged={onChanged}
        />

        <div className="venue-side">
          {/* Цена и телефон — во всю ширину: «от 25 млн сум за мероприятие» и номер в
            половине строки телефона переносились посреди числа */}
          <dl className="facts">
            <div className="facts-wide">
              <dt>{t.priceLabel}</dt>
              <dd>
                {listing.priceFromUzs !== null
                  ? `${fill(t.priceFrom, { price: formatMoney(listing.priceFromUzs, t, lang) })} ${priceUnitLabel(
                      lang,
                      listing.priceUnit,
                    )}`
                  : t.notSet}
                <span className="fact-sub fact-note">
                  {listing.priceFromUzs !== null ? t.priceFromServices : t.priceFromNone}
                </span>
                <SectionLink
                  to={{ route: "services" }}
                  navigate={navigate}
                  className="btn btn-ghost fact-link"
                >
                  {t.toServices}
                </SectionLink>
              </dd>
            </div>
            {fields.includes("guest_capacity") ? (
              <div>
                <dt>{t.capacity}</dt>
                <dd>
                  <Capacity listing={listing} t={t} />
                </dd>
              </div>
            ) : null}
            {fields.includes("district") || listing.districtCode ? (
              <div>
                <dt>{t.district}</dt>
                <dd>{listing.districtCode ? textOf(t, `dist_${listing.districtCode}`) : t.notSet}</dd>
              </div>
            ) : null}
            <div className="facts-wide">
              <dt>{t.address}</dt>
              <dd>{listing.address[lang] || t.notSet}</dd>
            </div>
          </dl>
          <p className="note">{fill(t.managerFacts, { code: vendorCode })}</p>

          <VenueContacts listing={listing} t={t} owner={owner} onChanged={onChanged} />

          {category && category.attributes.length > 0 ? (
            <section className="panel" aria-labelledby="venue-attrs-title">
              <h3 className="panel-title" id="venue-attrs-title">
                {t.attributesTitle}
              </h3>
              {Object.keys(listing.attributes).length === 0 ? (
                <p className="note">{t.notSet}</p>
              ) : (
                <AttributeFacts category={category} attributes={listing.attributes} t={t} lang={lang} />
              )}
            </section>
          ) : null}

          {listing.videoLinks.length > 0 ? (
            <section className="panel" aria-labelledby="venue-video-title">
              <h3 className="panel-title" id="venue-video-title">
                {t.videoTitle}
              </h3>
              <ul className="video-list">
                {listing.videoLinks.map((link) => (
                  <li key={link}>{link}</li>
                ))}
              </ul>
            </section>
          ) : null}

          <div className="panel">
            <p className="panel-title">{t.description}</p>
            <p className="description">{listing.description[lang] || t.notSet}</p>
          </div>
        </div>
      </div>
    </article>
  );
}
