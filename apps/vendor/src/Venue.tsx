/* Витрина — выбранная витрина как есть в базе (то, что видит клиент). Название, описания, данные
   витрины категории, ссылки на видео, вместимость, район и адрес владелец кабинета меняет в окнах
   «Изменить» у карточек-групп (VenueGroups.tsx, ListingEdit.tsx): пока витрины нет на сайте —
   сохраняется сразу, на проверке и позже — уходит предложением, клиенты до решения команды видят
   прежнее (Proposal.tsx: предложение на проверке, отзыв, отказ с причиной, история). Цена «от» —
   из услуг: здесь только она и ссылка на «Услуги», списка услуг второй раз нет. Телефон и
   Telegram — карточка «Контакты» (VenueContacts.tsx). Сотрудник площадки (роль member) витрину
   только смотрит. Рейтинга нет: его на первом запуске не показываем.

   Витрина не на сайте — сверху чек-лист «что осталось до публикации» (Readiness): почему она
   не опубликована, пункты партнёра — каждый с кнопкой туда, где он делается (услуги, фото, окно
   «Изменить» нужной карточки), и одной строкой — что сделает команда (договор, СТИР…).
   Пока витрина не опубликована, пункты партнёра — то, что мешает отправить её на проверку:
   услуги и фото, которые ждут решения команды, уже не его забота. Всё сделал — владелец
   кабинета сам отправляет черновик (и отклонённую) на проверку кнопкой «Отправить на
   проверку»: команде приходит оповещение, витрина — «на проверке»; отозвать её с проверки —
   там же (VenueWithdraw.tsx). Новый партнёр попадает сюда из входящих (строка «что дальше»).

   Фото — свой блок, VenuePhotos.tsx (загрузка по правилу категории, порядок, обложка, удаление).
   «Время работы» (одно мероприятие в день или несколько, части дня, окна, заказов одновременно) —
   WorkingTimes.tsx, у категорий с календарём: меняется сразу, без проверки.

   Порядок: чек-лист (если витрина не на сайте), состояние предложения (на проверке, отказ с
   причиной), затем фото и карточки-группы. На компьютере — две колонки: фото слева, карточки
   справа; предложение над ними во всю ширину. */

import type {
  ListingRevisionPayload,
  VendorListing,
  VendorListingRef,
  VendorListingSaved,
  VendorRevisionList,
  VendorRole,
} from "@bayramm/shared/api/vendor";
import {
  attributeLabel,
  type CategoryConfig,
  categoryConfig,
  hasDayParts,
  serviceTypeLabel,
} from "@bayramm/shared/categories";
import { useToast } from "@bayramm/ui/react";
import { type MouseEvent, type RefObject, useEffect, useRef, useState } from "react";
import { ApiFailure, api } from "./api";
import { categoryName } from "./category";
import { draftKeys, takeDraft } from "./drafts";
import { errorText } from "./errors";
import { authMethods } from "./hub";
import { fill, type TextKey, textOf, type VendorDict } from "./i18n";
import { Icon } from "./icons";
import { type EditDraft, EditSheet, isEditDraft } from "./ListingEdit";
import { ListingPicker } from "./ListingPicker";
import { EDIT_GROUPS, type EditGroup } from "./listing-edit";
import { RevisionNotice } from "./Proposal";
import type { Navigate, VenueFocus } from "./router";
import { openSiteLink } from "./telegram";
import { Empty, Heading, LoadError, Loading, type ScreenProps } from "./ui";
import { useLoad } from "./useLoad";
import { VenueContacts } from "./VenueContacts";
import { VenueGroups } from "./VenueGroups";
import { VenuePhotos } from "./VenuePhotos";
import { WithdrawAction } from "./VenueWithdraw";
import { WorkingTimes } from "./WorkingTimes";

/** Пункт чек-листа готовности: что сделать и кнопка туда, где это делается */
export interface Todo {
  readonly key: string;
  /** Что сделать: пункты с одной и той же кнопкой — строками одного пункта */
  readonly lines: readonly string[];
  /** target — куда ведёт кнопка: пункты с одним местом сливаются в один */
  readonly action?: { readonly label: string; readonly target: string; readonly run: () => void };
}

/** Пункты партнёра — их он делает сам; остальные коды готовности делает команда Bayramm */
const VENDOR_BLOCKERS: ReadonlySet<string> = new Set([
  "price",
  "packages",
  "photos",
  "descriptions",
  "attributes",
  "capacity",
  "district",
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

/**
 * Сколько обычно занимает проверка витрины командой — говорим партнёру один раз, после отправки
 * (решение приходит ботом в Telegram)
 */
export const REVIEW_HOURS = 24;

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
  /** Открыть окно «Изменить» нужной карточки */
  readonly edit: (group: EditGroup) => void;
}

/**
 * Пункты партнёра: что сделать самому и где (коды готовности базы и пустые данные витрины).
 * pending — открытое предложение: что в нём уже есть, ждёт проверки и второй раз не просится
 */
export function vendorTodos(
  listing: VendorListing,
  category: CategoryConfig | undefined,
  t: VendorDict,
  lang: "ru" | "uz",
  go: TodoRoutes,
  pending: ListingRevisionPayload = {},
): Todo[] {
  const blockers = new Set(partnerCodes(listing));
  const todos: Todo[] = [];
  const toServices = { label: t.toServices, target: "services", run: go.services };
  const fillIn = (group: EditGroup) => ({ label: t.toFill, target: group, run: () => go.edit(group) });
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
      action: { label: t.toPhotos, target: "photos", run: go.photos },
    });
  }
  // Описание на каждом языке: пустое и ещё не предложенное
  const noRu = listing.description.ru.trim() === "" && pending.description_ru === undefined;
  const noUz = listing.description.uz.trim() === "" && pending.description_uz === undefined;
  if (blockers.has("descriptions") && (noRu || noUz))
    todos.push({ key: "descriptions", lines: [t.todoDescriptions], action: fillIn("basics") });
  if (blockers.has("capacity") && pending.cap_max === undefined)
    todos.push({ key: "capacity", lines: [t.todoCapacity], action: fillIn("place") });
  if (blockers.has("district") && pending.district_code === undefined)
    todos.push({ key: "district", lines: [t.todoDistrict], action: fillIn("place") });
  // Поля витрины, которых нет ни в карточке, ни в предложении: по строке на поле, подписью как в
  // форме — подписи не склеиваются (у них бывает единица через запятую: «…через, дней»)
  const missing = listing.missingAttributes.filter((key) => pending.attributes?.[key] === undefined);
  if ((blockers.has("attributes") && pending.attributes === undefined) || missing.length > 0) {
    const labels =
      category && missing.length > 0
        ? missing.map((key) => attributeLabel(lang, category, key))
        : [t.blocker_attributes];
    todos.push({
      key: "attributes",
      lines: labels.map((label) => fill(t.todoAttribute, { label })),
      action: fillIn("attributes"),
    });
  }
  // Одна кнопка — один пункт: вместимость и район — в одном окне «Место», цена и обязательные
  // услуги — в «Услугах»; две одинаковые кнопки подряд только путали бы
  const merged: Todo[] = [];
  for (const todo of todos) {
    const same = merged.findIndex((m) => m.action?.target === todo.action?.target);
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
  /** Открытое предложение: что в нём уже есть, ждёт проверки и в чек-листе не просится */
  readonly pending?: ListingRevisionPayload;
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
function Readiness({ listing, category, t, lang, owner, go, pending, onSubmitted }: ReadinessProps) {
  const todos = vendorTodos(listing, category, t, lang, go, pending);
  const team = listing.blockers.filter((code) => !VENDOR_BLOCKERS.has(code));
  // Своё партнёр сделал, а отправить мешает то, что заполняет команда (район, телефон…)
  const teamFirst = listing.reviewBlockers.filter((code) => !VENDOR_BLOCKERS.has(code));
  const submittable = SUBMITTABLE.has(listing.status) && todos.length === 0;
  const canSubmit = submittable && teamFirst.length === 0;
  // Отправили отсюда: сколько ждать — всплывающей строкой, один раз; «на проверке» скажет сам
  // чек-лист. Кнопка исчезла — фокус на чек-лист, а не в никуда
  const toast = useToast();
  const [sent, setSent] = useState(false);
  const block = useRef<HTMLElement>(null);
  useEffect(() => {
    if (sent && listing.status === "review") block.current?.focus({ preventScroll: true });
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
      onDone={() => {
        setSent(true);
        toast(fill(t.submitDone, { n: REVIEW_HOURS }), { tone: "success", duration: 8000 });
      }}
    />
  ) : listing.status === "review" ? (
    <WithdrawAction listing={listing} t={t} owner={owner} onWithdrawn={onSubmitted} />
  ) : null;
  if (todos.length === 0 && team.length === 0) {
    return (
      <div className="notice readiness" ref={block as RefObject<HTMLDivElement>} tabIndex={-1}>
        <p>{lead}</p>
        {reason}
        {action}
      </div>
    );
  }
  return (
    <section className="panel readiness" aria-labelledby="ready-title" ref={block} tabIndex={-1}>
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
                {/* «Не готово» — значком, а не пустым квадратом: он похож на флажок, которого нет */}
                <span className="todo-mark" aria-hidden="true">
                  <Icon name="warning" size={17} />
                </span>
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
    </section>
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
  /** Пришли по ссылке к блоку (?focus=): время работы или данные витрины */
  readonly focus?: VenueFocus;
}

/** Заголовок блока витрины, к которому ведёт ссылка */
function focusTarget(focus: VenueFocus): HTMLElement | null {
  return focus === "sessions"
    ? document.getElementById("sessions-title")
    : document.querySelector<HTMLElement>('[data-group="attributes"] .panel-title');
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
  focus,
}: VenueProps) {
  const [listing, reload, set, refresh] = useLoad<VendorListing>(listingId, (id) => api.listing(id));
  const owner = role === "owner";
  // Тихо, чтобы список ошибок загрузки и фокус остались; не вышло — обычная загрузка с повтором
  const refreshListing = async () => {
    if (!(await refresh())) reload();
    onChanged?.();
  };
  // Сохранили изменения: ответ API — витрина как она теперь (перечитывать не нужно)
  const saved = (result: VendorListingSaved) => {
    set(() => result.listing);
    onChanged?.();
  };
  // К блоку из ссылки — когда витрина на экране, один раз: прокрутка и фокус на его заголовок
  const ready = listing.state === "ready";
  const focused = useRef(false);
  useEffect(() => {
    if (!focus || !ready || focused.current) return;
    focused.current = true;
    requestAnimationFrame(() => {
      const target = focusTarget(focus);
      target?.scrollIntoView?.({ block: "start" });
      target?.focus({ preventScroll: true });
    });
  }, [focus, ready]);

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
      {/* Владельцу пояснения не нужны: что и как проверяется, сказано в окне «Изменить» */}
      {owner ? null : <p className="note">{t.venueNoteMember}</p>}

      {listing.state === "loading" ? <Loading t={t} kind="card" /> : null}
      {listing.state === "error" ? <LoadError t={t} onRetry={reload} error={listing.error} /> : null}
      {listing.state === "ready" ? (
        <VenueCard
          listing={listing.data}
          t={t}
          lang={lang}
          owner={owner}
          showName={!pickerShown}
          navigate={navigate}
          onChanged={refreshListing}
          onSaved={saved}
          onProposal={onChanged}
        />
      ) : null}
    </section>
  );
}

/** Адрес витрины на сайте (сайт окружения — из GET /auth/methods); пока не узнали — null */
function useSiteUrl(slug: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void authMethods().then((methods) => {
      const web = methods?.apps.web;
      if (active) setUrl(web ? `${web.replace(/\/+$/, "")}/venue/${encodeURIComponent(slug)}` : null);
    });
    return () => {
      active = false;
    };
  }, [slug]);
  return url;
}

/**
 * Витрина на сайте: открыть её глазами клиента и скопировать ссылку (в Instagram, Telegram).
 * В Telegram ссылка открывается во внешнем браузере, кабинет остаётся открытым
 */
function VenueLinks({ slug, t }: { slug: string; t: VendorDict }) {
  const url = useSiteUrl(slug);
  const toast = useToast();
  if (url === null) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast(t.venueLinkCopied, { tone: "success" });
    } catch {
      // Буфер обмена недоступен (старый вебвью, нет разрешения) — ссылка текстом, её можно выделить
      toast(fill(t.venueLinkCopyFailed, { url }));
    }
  };
  return (
    <div className="venue-links">
      <a
        className="btn btn-ghost"
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event: MouseEvent<HTMLAnchorElement>) => openSiteLink(url, event)}
      >
        {t.venueOpenSite}
      </a>
      <button type="button" className="btn btn-ghost" onClick={() => void copy()}>
        {t.venueCopyLink}
      </button>
    </div>
  );
}

interface VenueCardProps {
  readonly listing: VendorListing;
  readonly t: VendorDict;
  readonly lang: "ru" | "uz";
  readonly owner: boolean;
  /** Имя витрины заголовком: выбора витрины на экране нет */
  readonly showName: boolean;
  readonly navigate: Navigate;
  readonly onChanged: () => Promise<void>;
  /** Изменения сохранены сразу или ушли предложением: витрина как она теперь */
  readonly onSaved: (result: VendorListingSaved) => void;
  /** Предложение отозвано: значки «требует внимания» в разделах — заново */
  readonly onProposal?: () => void;
}

function VenueCard({
  listing,
  t,
  lang,
  owner,
  showName,
  navigate,
  onChanged,
  onSaved,
  onProposal,
}: VenueCardProps) {
  const category = categoryConfig(listing.categoryCode);
  const [revisions, reloadRevisions, setRevisions, refreshRevisions] = useLoad<VendorRevisionList>(
    listing.id,
    (id) => api.revisions(id),
  );
  const pending =
    revisions.state === "ready" ? revisions.data.items.find((r) => r.status === "pending") : undefined;
  // Окно «Изменить» какой-то карточки; сохранили — всплывающая строка, фокус — на заголовок карточки
  const [editing, setEditing] = useState<EditGroup | null>(null);
  const toast = useToast();
  const groupTitle = useRef<HTMLElement | null>(null);
  // Пока предложение открыто, новое отправить нельзя (одно на витрину): «Изменить» скрыто
  const canEdit = owner && pending === undefined;
  const open = (group: EditGroup) => {
    if (!canEdit) return;
    // Закрыли без сохранения — фокус туда, откуда открыли; сохранили — на заголовок карточки
    groupTitle.current = null;
    setEditing(group);
  };
  const go: TodoRoutes = {
    services: () => navigate({ route: "services" }),
    // Фото — на этом же экране: фокус на заголовок блока, браузер прокрутит к нему
    photos: () => document.getElementById("photos-title")?.focus(),
    edit: open,
  };
  const saved = (result: VendorListingSaved) => {
    const sent = result.sentForModeration.length > 0;
    groupTitle.current = document.querySelector<HTMLElement>(`[data-group="${editing}"] .panel-title`);
    setEditing(null);
    toast(sent ? t.proposalSent : t.editSaved, { tone: "success" });
    onSaved(result);
    // Предложение появилось: карточки отметят «на проверке», «Изменить» скроется
    if (sent) void refreshRevisions();
  };
  // Витрину успели изменить или предложение уже открыто — показать, как сейчас
  // Сессия кончилась посреди правки: после входа — то же окно с вписанным (drafts.ts). Ждём
  // предложения: пока одно открыто, окна «Изменить» нет — черновик тогда пропадает
  const [restored, setRestored] = useState<EditDraft | null>(null);
  const revisionsReady = revisions.state === "ready";
  // biome-ignore lint/correctness/useExhaustiveDependencies: один раз, когда предложения загружены
  useEffect(() => {
    // Окна «Изменить» сейчас нет (открыто предложение, не владелец) — черновик остаётся до него
    if (!revisionsReady || !canEdit) return;
    const start = `edit.${listing.id}.`;
    for (const key of draftKeys(start)) {
      const group = key.slice(start.length);
      if (!EDIT_GROUPS.includes(group as EditGroup)) continue;
      const draft = takeDraft(key, isEditDraft);
      if (draft && editing === null) {
        setRestored(draft);
        open(group as EditGroup);
      }
    }
  }, [revisionsReady, listing.id, canEdit]);
  const stale = () => {
    void onChanged();
    void refreshRevisions();
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
      {/* Клиенты видят только опубликованную */}
      {listing.status === "active" ? <VenueLinks slug={listing.slug} t={t} /> : null}

      {/* Ключ — витрина: «отправили на проверку» другой витрины не переносится */}
      <Readiness
        key={`ready-${listing.id}`}
        listing={listing}
        category={category}
        t={t}
        lang={lang}
        owner={owner}
        go={go}
        pending={pending?.payload}
        onSubmitted={onChanged}
      />

      {/* Предложение на проверке и отказ с причиной — сразу под чек-листом, а не под фото и
        карточками (на телефоне это два экрана). Ключ — витрина: при смене витрины — заново */}
      <RevisionNotice
        key={listing.id}
        listingId={listing.id}
        revisions={revisions}
        reload={reloadRevisions}
        setRevisions={setRevisions}
        t={t}
        owner={owner}
        onChanged={onProposal}
      />

      <div className="venue-grid">
        {/* Ключ — витрина: галочка и ошибки загрузки другой витрины не переносятся.
          Не тот же, что у RevisionNotice: ключи соседей в одном родителе обязаны различаться */}
        <VenuePhotos
          key={`photos-${listing.id}`}
          listing={listing}
          portfolio={category?.photoPolicy === "portfolio"}
          t={t}
          owner={owner}
          onChanged={onChanged}
        />

        <div className="venue-side">
          <VenueGroups
            listing={listing}
            category={category}
            t={t}
            lang={lang}
            navigate={navigate}
            pending={pending}
            onEdit={canEdit ? open : undefined}
          />
          <VenueContacts listing={listing} t={t} owner={owner} onChanged={onChanged} />
          {category !== undefined && hasDayParts(category) ? (
            <WorkingTimes
              key={`sessions-${listing.id}`}
              listing={listing}
              t={t}
              lang={lang}
              owner={owner}
              onChanged={onChanged}
            />
          ) : null}
        </div>
      </div>

      {editing !== null ? (
        <EditSheet
          key={editing}
          group={editing}
          listing={listing}
          t={t}
          lang={lang}
          returnFocus={groupTitle}
          onClose={() => {
            setRestored(null);
            setEditing(null);
          }}
          onSaved={saved}
          onStale={stale}
          restored={restored}
        />
      ) : null}
    </article>
  );
}
